import json
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from nora_nlp.services.summary_verifier import verify_summary
from nora_nlp.time_budget import LlmBudgetExceededError


def test_checks_event_associations_using_original_source_and_counts_the_extra_usage():
    client = MagicMock()
    corrected = "Delivery is confirmed for 2026-10-30. The installation date was not defined."
    client.chat_structured.return_value = (json.dumps({"summary": corrected}), 80, 30)
    original = "Delivery is confirmed for 2026-10-30; use it to plan installation."
    result = verify_summary(client, "Installation is scheduled for 2026-10-30.", original, "en")
    assert result == (corrected, 80, 30)
    call = client.chat_structured.call_args.kwargs
    assert json.loads(call["user_prompt"])["transcript"] == original
    assert call["schema_name"] == "meeting_summary_verification"
    assert call["json_schema"]["additionalProperties"] is False


def test_keeps_fact_free_and_placeholder_only_summaries_without_an_extra_provider_call():
    client = MagicMock()
    summary = "The team discussed follow-ups with [[PERSON_NAME_12]] and assigned the next steps."
    assert verify_summary(client, summary, "Source", "en") == (summary, 0, 0)
    client.chat_structured.assert_not_called()


@pytest.mark.parametrize(
    "source",
    [
        "Recebemos a confirmação escrita do fornecedor. A entrega ainda não aconteceu.",
        "Written confirmation was received; the equipment has not arrived.",
        "A proposta é de 178000 reais, com teto de 170000 reais.",
    ],
)
def test_reviews_material_source_facts_even_when_the_draft_omits_them(source):
    client = MagicMock()
    corrected = "Written confirmation has been received. Physical delivery is still pending."
    client.chat_structured.return_value = (json.dumps({"summary": corrected}), 30, 20)
    result = verify_summary(client, "The team discussed the supplier and next steps.", source, "en")
    assert result[0].startswith(corrected)
    assert result[1:] == (30, 20)
    if "confirma" in source.lower():
        assert "> " + source in result[0]
    user_prompt = json.loads(client.chat_structured.call_args.kwargs["user_prompt"])
    assert user_prompt["transcript"] == source


@pytest.mark.parametrize(
    "source",
    [
        "Operações: Recebemos a confirmação escrita do fornecedor. A entrega continua futura.",
        "Operações: Não recebemos a confirmação escrita do fornecedor.",
        "Operações: Se recebermos a confirmação escrita, revisaremos o cronograma.",
        "Operações: Recebemos a confirmação escrita do fornecedor?",
        "Operations: We received written confirmation. Physical delivery is still pending.",
        "Operations: We have not received written confirmation.",
        "Operations: When we receive written confirmation, we will review the schedule.",
    ],
)
def test_preserves_whole_source_records_even_when_the_reviewer_omits_the_update(source):
    client = MagicMock()
    draft = "The team discussed the supplier and kept the project conditional."
    client.chat_structured.return_value = (json.dumps({"summary": draft}), 30, 20)
    result = verify_summary(client, draft, source, "pt-BR")[0]
    assert result.startswith(draft)
    assert "> " + source in result


def test_keeps_a_later_revocation_with_the_earlier_confirmation_and_preserves_placeholders():
    client = MagicMock()
    draft = "The team discussed the supplier and kept the project conditional."
    client.chat_structured.return_value = (json.dumps({"summary": draft}), 30, 20)
    lines = [
        "[[PERSON_NAME_1]]: Recebemos a confirmação escrita do fornecedor.",
        "Diretoria: A decisão continua condicionada ao aceite do cliente.",
        "Operações: Ela foi revogada; a previsão precisa ser revista.",
    ]
    result = verify_summary(client, draft, "\n".join(lines), "pt-BR")[0]
    assert "> " + lines[0] in result
    assert "> " + lines[2] in result
    assert result.index(lines[0]) < result.index(lines[2])


def test_reserves_space_without_cutting_the_source_record():
    client = MagicMock()
    draft = ("The team discussed the project.\n\n" * 70)[:2000]
    source = "Operations: We received written confirmation; the installation date is not defined."
    client.chat_structured.return_value = (json.dumps({"summary": draft}), 30, 20)
    result = verify_summary(client, draft, source, "en")[0]
    assert len(result) <= 2000
    assert result.endswith("> " + source)
    assert "Source excerpts (transcript order)" in result


def test_budget_failure_is_not_silently_replaced_by_the_unverified_draft():
    client = MagicMock()
    client.chat_structured.side_effect = LlmBudgetExceededError(
        "request budget exceeded", elapsed=1, total=1
    )
    with pytest.raises(LlmBudgetExceededError):
        verify_summary(client, "The approved budget is 170000 reais.", "Source", "pt-BR")
    client.chat_json.assert_not_called()


def test_rejects_an_empty_verified_summary():
    client = MagicMock()
    client.chat_structured.return_value = ('{"summary":""}', 20, 5)
    with pytest.raises(ValidationError):
        verify_summary(client, "The approved budget is 170000 reais.", "Source", "pt-BR")


@pytest.mark.parametrize("month", ["janeiro", "maio", "agosto", "dezembro"])
def test_checks_dates_spelled_out_beyond_the_demo_months(month):
    client = MagicMock()
    summary = f"A entrega ficou prevista para vinte de {month} de dois mil e vinte e seis."
    client.chat_structured.return_value = (json.dumps({"summary": summary}), 20, 10)
    assert verify_summary(client, summary, summary, "pt-BR") == (summary, 20, 10)
    client.chat_structured.assert_called_once()


def test_preserves_json_mode_compatibility_with_the_same_factual_review_prompt():
    client = MagicMock()
    client.chat_structured.side_effect = RuntimeError("Structured mode unavailable")
    summary = "The proposal is 178000 reais and exceeds the approved ceiling of 170000 reais."
    client.chat_json.return_value = (json.dumps({"summary": summary}), 20, 10)
    assert verify_summary(client, summary, summary, "en") == (summary, 20, 10)
    assert (
        client.chat_json.call_args.kwargs["user_prompt"]
        == client.chat_structured.call_args.kwargs["user_prompt"]
    )
