from __future__ import annotations

import json
import re
from itertools import pairwise
from unittest.mock import MagicMock, patch

import pytest

from nora_nlp.clients.llm import build_json_schema_for_analysis
from nora_nlp.models import AnalyzeRequest, CommercialIntelligence, MeetingAnalysisV1
from nora_nlp.services import llm_analyzer
from nora_nlp.services.commercial_evidence import (
    render_evidence,
    resolve_evidence,
    segment_evidence,
    use_evidence_schema,
)
from nora_nlp.settings import Settings


def _commercial(**items):
    return {"products": [], "personas": [], "budgets": [], "sentimentByTopic": [], **items}


def _payload(commercial):
    return {
        "summary": "The team discussed its existing system and the financial constraints.",
        "sentimentOverall": "NEUTRAL",
        "commercialIntelligence": commercial,
    }


def _request(transcript, *, enabled=True):
    return AnalyzeRequest(
        meetingId="evidence-test",
        tenantId="00000000-0000-4000-8000-000000000001",
        transcript=transcript,
        language="pt-BR",
        tenantContext={"companyName": "ACME", "valueProposition": "Business software"},
        options={"includeCustomerConfidence": enabled},
    )


@pytest.mark.parametrize(
    "transcript",
    ["", "x", "\n\r\n", "x" * 1501, "a\t" * 800, "[LOCUTOR 1]: Olá.\r\n[LOCUTOR 2]: Sim.\n"],
)
def test_evidence_offsets_preserve_every_character_without_overlap(transcript):
    segments = segment_evidence(transcript)
    assert "".join(item.text for item in segments) == transcript
    assert [item.evidence_id for item in segments] == list(range(1, len(segments) + 1))
    assert all(0 < len(item.text) <= 500 for item in segments)
    assert all(transcript[item.start : item.end] == item.text for item in segments)
    assert all(left.end == right.start for left, right in pairwise(segments))
    if segments:
        assert segments[0].start == 0
        assert segments[-1].end == len(transcript)


def test_long_evidence_input_is_complete_and_keeps_the_last_fact():
    transcript = "[LOCUTOR 1]: Contexto neutro com acentuação.\n" * 4500
    transcript += "[LOCUTOR 2]: Usamos LedgerOne e não temos orçamento aprovado."
    assert len(transcript) > 185000
    segments = segment_evidence(transcript)
    serialized = json.loads(render_evidence(segments))
    assert "".join(item["text"] for item in serialized) == transcript
    assert serialized[-1]["text"].endswith("não temos orçamento aprovado.")
    assert all(len(item["text"]) <= 500 for item in serialized)
    assert len(serialized) == len({item["evidenceId"] for item in serialized})


def test_short_speaker_turns_keep_their_label_and_role_in_the_same_segment():
    source = "[LOCUTOR 1]: Sou diretor financeiro.\n[SPEAKER_2]: Sou usuário do sistema."
    segments = segment_evidence(source)
    assert segments[0].text == "[LOCUTOR 1]: Sou diretor financeiro.\n"
    assert segments[1].text == "[SPEAKER_2]: Sou usuário do sistema."


def test_provider_references_do_not_change_the_public_source_quote_contract():
    schema = build_json_schema_for_analysis()
    use_evidence_schema(schema, 4)
    for name in ("CommercialProduct", "CommercialPersona", "CommercialBudget", "TopicSentiment"):
        definition = schema["$defs"][name]
        assert "sourceQuote" not in definition["properties"]
        assert "sourceQuote" not in definition["required"]
        assert "evidenceId" in definition["required"]
        assert definition["properties"]["evidenceId"]["maximum"] == 4
    assert "sourceQuote" in schema["$defs"]["Risk"]["properties"]
    public = MeetingAnalysisV1.model_json_schema(by_alias=True)
    assert "sourceQuote" in public["$defs"]["CommercialProduct"]["properties"]
    assert "evidenceId" not in public["$defs"]["CommercialProduct"]["properties"]


@pytest.mark.parametrize("evidence_id", [0, -1, 999, True, 1.0, "1", None])
def test_invalid_references_are_discarded_instead_of_using_a_supplied_quote(evidence_id):
    source = "Usamos LedgerOne no financeiro."
    commercial = _commercial(
        products=[
            {
                "name": "LedgerOne",
                "relationship": "CURRENT",
                "evidenceId": evidence_id,
                "sourceQuote": source,
            }
        ]
    )
    result, rejected = resolve_evidence(commercial, segment_evidence(source))
    assert result["products"] == []
    assert rejected == 1


def test_resolution_uses_only_this_requests_source_and_ignores_model_written_quotes():
    source = "[LOCUTOR 1]: Usamos LedgerOne.\n"
    commercial = _commercial(
        products=[
            {
                "name": "LedgerOne",
                "relationship": "CURRENT",
                "evidenceId": 1,
                "sourceQuote": "Invented text that must not be persisted.",
            }
        ]
    )
    result, rejected = resolve_evidence(commercial, segment_evidence(source))
    assert rejected == 0
    assert result["products"][0]["sourceQuote"] == source
    assert "evidenceId" not in result["products"][0]
    other, _ = resolve_evidence(commercial, segment_evidence("A separate tenant's meeting."))
    assert other["products"][0]["sourceQuote"] == "A separate tenant's meeting."
    assert commercial["products"][0]["sourceQuote"].startswith("Invented")


def test_legacy_quotes_still_require_the_existing_grounding_and_short_segments_are_rejected():
    legacy = _commercial(
        products=[{"name": "ERP", "relationship": "CURRENT", "sourceQuote": "Usamos ERP."}]
    )
    result, rejected = resolve_evidence(legacy, segment_evidence("Usamos ERP."))
    assert rejected == 0
    assert CommercialIntelligence.model_validate(result).products[0].source_quote == "Usamos ERP."
    invalid = _commercial(products=[{"name": "x", "relationship": "MENTIONED", "evidenceId": 1}])
    assert resolve_evidence(invalid, segment_evidence("x")) == (_commercial(), 1)


@pytest.mark.parametrize("fallback", [False, True])
def test_both_transports_resolve_evidence_before_grounding_and_count_invalid_items(
    fallback, caplog
):
    source = (
        "[LOCUTOR 1]: Usamos LedgerOne no financeiro.\n"
        "[LOCUTOR 2]: Sou diretor financeiro, mas a diretoria aprova os gastos.\n"
        "[LOCUTOR 2]: O preço antigo era quatro mil reais por mês.\n"
        "[LOCUTOR 1]: Falei com a [EMPRESA].\n"
    )
    commercial = _commercial(
        products=[
            {"name": "LedgerOne", "relationship": "CURRENT", "evidenceId": 1},
            {"name": "[EMPRESA]", "relationship": "MENTIONED", "evidenceId": 4},
            {"name": "InventedERP", "relationship": "OPPORTUNITY", "evidenceId": 999},
        ],
        personas=[
            {
                "speaker": "[LOCUTOR 2]",
                "role": "diretor financeiro",
                "decisionRole": "UNKNOWN",
                "evidenceId": 2,
            }
        ],
        budgets=[
            {
                "amount": 4000,
                "currency": "BRL",
                "kind": "PRICE",
                "approval": "UNKNOWN",
                "period": "por mês",
                "evidenceId": 3,
            }
        ],
    )
    client = MagicMock()
    raw = json.dumps(_payload(commercial))
    client.chat_structured.return_value = (raw, 100, 50)
    client.chat_json.return_value = (raw, 100, 50)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured transport unavailable")
    with (
        caplog.at_level("INFO"),
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
        patch.object(llm_analyzer, "verify_products", side_effect=lambda _, ci, *args: (ci, 0, 0)),
    ):
        response = llm_analyzer.analyze(_request(source), Settings())
    result = response.commercial_intelligence
    assert result is not None
    assert [(p.name, p.relationship.value) for p in result.products] == [("LedgerOne", "CURRENT")]
    assert result.personas[0].speaker == "[LOCUTOR 2]"
    assert result.personas[0].decision_role.value == "UNKNOWN"
    assert result.budgets[0].amount == 4000 and result.budgets[0].kind.value == "PRICE"
    assert result.budgets[0].approval.value == "UNKNOWN"
    assert response.metadata.commercial_items_accepted == 3
    assert response.metadata.commercial_items_rejected == 2
    assert "provider_items=5 accepted=3 rejected=2" in caplog.text
    assert "LedgerOne" not in caplog.text
    assert "diretor financeiro" not in caplog.text
    request = client.chat_structured.call_args.kwargs
    rendered = re.search(r"Transcrição da reunião.*?```\n(.*?)\n```", request["user_prompt"], re.S)[
        1
    ]
    assert "".join(item["text"] for item in json.loads(rendered)) == source
    assert request["user_prompt"].count(rendered) == 1
    assert source not in request["user_prompt"]
    assert (
        request["json_schema"]["$defs"]["CommercialProduct"]["properties"]["evidenceId"]["maximum"]
        == 4
    )
    assert "evidenceId" not in response.model_dump_json()
    if fallback:
        assert client.chat_json.call_args.kwargs["user_prompt"] == request["user_prompt"]


@pytest.mark.parametrize("fallback", [False, True])
def test_core_never_builds_or_resolves_commercial_evidence(fallback):
    source = "[LOCUTOR 1]: Usamos LedgerOne no financeiro."
    client = MagicMock()
    raw = json.dumps(_payload({"untrusted": "commercial data"}))
    client.chat_structured.return_value = (raw, 100, 50)
    client.chat_json.return_value = (raw, 100, 50)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured transport unavailable")
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(llm_analyzer, "segment_evidence") as segment,
        patch.object(llm_analyzer, "resolve_evidence") as resolve,
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
    ):
        response = llm_analyzer.analyze(_request(source, enabled=False), Settings())
    segment.assert_not_called()
    resolve.assert_not_called()
    assert response.commercial_intelligence is None
    assert response.metadata.commercial_items_accepted == 0
    assert response.metadata.commercial_items_rejected == 0
    request = client.chat_structured.call_args.kwargs
    assert source in request["user_prompt"]
    assert request["json_schema"]["properties"]["commercialIntelligence"] == {"type": "null"}


@pytest.mark.parametrize("fallback", [False, True])
def test_effective_contract_separates_vendor_competitors_from_customer_product_relationships(
    fallback,
):
    source = (
        "[LOCUTOR 1]: Já usamos LedgerOne e queremos substituí-lo.\n"
        "[LOCUTOR 1]: Não usamos NovaSuite e estamos comparando com sua proposta.\n"
        "[LOCUTOR 1]: Queremos comprar FreshReports para os relatórios."
    )
    request = _request(source)
    request.tenant_context.competitors = ["LedgerOne", "NovaSuite", "FreshReports"]
    original_context = request.tenant_context.model_dump(by_alias=True)
    commercial = _commercial(
        products=[
            {"name": "LedgerOne", "relationship": "CURRENT", "evidenceId": 1},
            {"name": "NovaSuite", "relationship": "COMPETITOR", "evidenceId": 2},
            {"name": "FreshReports", "relationship": "OPPORTUNITY", "evidenceId": 3},
        ]
    )
    client = MagicMock()
    client.chat_structured.return_value = (json.dumps(_payload(commercial)), 100, 50)
    client.chat_json.return_value = (json.dumps(_payload(commercial)), 100, 50)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured transport unavailable")
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
        patch.object(llm_analyzer, "verify_products", side_effect=lambda _, ci, *args: (ci, 0, 0)),
    ):
        response = llm_analyzer.analyze(request, Settings())
    call = client.chat_structured.call_args.kwargs
    context = json.loads(
        re.search(r"Contexto do tenant:\n\n```json\n(.*?)\n```", call["user_prompt"], re.S)[1]
    )
    assert "competitors" not in context
    assert context["vendorCompetitorReference"] == original_context["competitors"]
    assert request.tenant_context.model_dump(by_alias=True) == original_context
    relationship = call["json_schema"]["$defs"]["CommercialProduct"]["properties"]["relationship"]
    assert relationship["type"] == "string"
    assert set(relationship["enum"]) == {"CURRENT", "COMPETITOR", "OPPORTUNITY", "MENTIONED"}
    nodes = [call["json_schema"]]
    while nodes:
        node = nodes.pop()
        if isinstance(node, dict):
            if "$ref" in node:
                assert set(node) == {"$ref"}
            nodes.extend(node.values())
        elif isinstance(node, list):
            nodes.extend(node)
    rules = relationship["description"]
    assert "CUSTOMER'S relationship" in rules
    assert "CURRENT always wins" in rules
    assert "COMPETITOR only if NOT currently used" in rules
    assert "explicitly evaluated as an alternative" in rules
    assert "vendorCompetitorReference list never establishes" in rules
    assert "nunca a use para definir" in call["system_prompt"]
    assert response.commercial_intelligence is not None
    assert [(p.name, p.relationship.value) for p in response.commercial_intelligence.products] == [
        ("LedgerOne", "CURRENT"),
        ("NovaSuite", "COMPETITOR"),
        ("FreshReports", "OPPORTUNITY"),
    ]
    if fallback:
        assert client.chat_json.call_args.kwargs["system_prompt"] == call["system_prompt"]
