from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from nora_nlp.models import AnalyzeRequest, CommercialIntelligence
from nora_nlp.services import llm_analyzer
from nora_nlp.services.commercial_candidates import add_context_product_candidates
from nora_nlp.services.commercial_evidence import segment_evidence
from nora_nlp.services.commercial_grounding import ground_commercial_intelligence
from nora_nlp.settings import Settings


def _add(source, names, intelligence=None, extracted_names=()):
    return add_context_product_candidates(
        intelligence or CommercialIntelligence(),
        source,
        names,
        segment_evidence(source),
        extracted_names=extracted_names,
    )


def test_literal_context_candidates_preserve_source_spelling_and_never_infer_relationships():
    source = "SPEAKER_1: We use LEDGERONE today and are comparing NovaSuite.\n"
    result, added = _add(source, ["LedgerOne", "NovaSuite", "NotMentioned"])
    assert [(item.name, item.relationship.value) for item in result.products] == [
        ("LEDGERONE", "MENTIONED"),
        ("NovaSuite", "MENTIONED"),
    ]
    assert all(item.source_quote == source for item in result.products)
    assert added == 2
    grounded, accepted, rejected = ground_commercial_intelligence(result, source, "en")
    assert grounded == result and (accepted, rejected) == (2, 0)


@pytest.mark.parametrize("source", ["We use SuperERP.", "We use ERPPlus.", "We use ERP_Cloud."])
def test_configured_names_do_not_match_substrings_of_other_names(source):
    result, added = _add(source, ["ERP"])
    assert result.products == [] and added == 0


def test_configured_names_are_literal_without_vendor_prefix_or_alias_inference():
    source = "We use NovaERP, but nobody mentioned another product."
    result, added = _add(source, ["Vendor NovaERP", "Nova ERP"])
    assert result.products == [] and added == 0


def test_placeholders_empty_and_oversized_names_never_become_candidates():
    names = ["", "   ", "[EMPRESA]", "[[PERSON_NAME_2]]", "Suite [COMPANY]", "x" * 161]
    result, added = _add("We use " + ", ".join(names) + ".", names)
    assert result.products == [] and added == 0


def test_context_duplicates_do_not_replace_existing_products_or_other_observations():
    source = "We use LedgerOne. No budget is defined."
    initial = CommercialIntelligence(
        products=[
            {"name": "LedgerOne", "relationship": "CURRENT", "sourceQuote": "We use LedgerOne."}
        ],
        budgets=[{"kind": "BUDGET", "approval": "UNKNOWN", "sourceQuote": "No budget is defined."}],
    )
    result, added = _add(source, ["ledgerone", "LedgerOne", " LedgerOne "], initial)
    assert result == initial and added == 0


def test_an_unmatched_spacing_variant_does_not_hide_a_later_literal_match():
    result, added = _add("We use Ledger One.", ["Ledger  One", "Ledger One", "LEDGER ONE"])
    assert [product.name for product in result.products] == ["Ledger One"]
    assert added == 1


def test_a_provider_product_rejected_before_grounding_is_not_resurrected_from_context():
    result, added = _add("We use LedgerOne.", ["LedgerOne"], extracted_names=["LEDGERONE"])
    assert result.products == [] and added == 0


def test_the_public_thirty_product_limit_includes_existing_and_context_candidates():
    names = [f"Suite{index}" for index in range(35)]
    source = "We discussed " + ", ".join(names) + "."
    initial = CommercialIntelligence(
        products=[
            {
                "name": names[0],
                "relationship": "CURRENT",
                "sourceQuote": source,
            }
        ]
    )
    result, added = _add(source, names, initial)
    assert len(result.products) == 30 and added == 29
    assert result.products[0] == initial.products[0]
    assert len({item.name.casefold() for item in result.products}) == 30
    assert all(
        item.source_quote in source and len(item.source_quote) <= 500 for item in result.products
    )


def _request(enabled=True):
    return AnalyzeRequest(
        meetingId="candidate-floor-fixture",
        tenantId="00000000-0000-4000-8000-000000000001",
        transcript="SPEAKER_1: We use LedgerOne today. Approved follow-up.",
        language="en",
        tenantContext={
            "companyName": "ACME",
            "valueProposition": "Software",
            "products": [],
            "competitors": ["LedgerOne"],
        },
        options={"includeCustomerConfidence": enabled},
    )


def _payload(products=()):
    return {
        "summary": "The customer discussed its current software and approved a follow-up.",
        "sentimentOverall": "NEUTRAL",
        "commercialIntelligence": {
            "products": list(products),
            "personas": [],
            "budgets": [],
            "sentimentByTopic": [],
        },
    }


@pytest.mark.parametrize("enabled", [False, True])
def test_the_same_verifier_receives_omitted_literal_candidates_but_core_runs_no_floor(
    enabled, caplog
):
    client = MagicMock()
    seen = []

    def answer(**kwargs):
        seen.append(kwargs["schema_name"])
        if kwargs["schema_name"] == "meeting_analysis":
            return json.dumps(_payload()), 100, 30
        if kwargs["schema_name"] == "meeting_summary_verification":
            return (
                json.dumps(
                    {
                        "summary": (
                            "The customer discussed its current software and approved a follow-up."
                        )
                    }
                ),
                20,
                10,
            )
        data = json.loads(kwargs["user_prompt"])
        assert data["products"] == {
            "product0": {
                "name": "LedgerOne",
                "evidenceChoices": [1],
            }
        }
        return (
            json.dumps({"product0": {"relationship": "CURRENT", "choice": 0}}),
            7,
            3,
        )

    client.chat_structured.side_effect = answer
    with (
        caplog.at_level("INFO"),
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(
            llm_analyzer, "add_context_product_candidates", wraps=add_context_product_candidates
        ) as floor,
    ):
        response = llm_analyzer.analyze(_request(enabled), Settings())
    if enabled:
        floor.assert_called_once()
        assert seen == [
            "meeting_analysis",
            "meeting_summary_verification",
            "meeting_product_verification",
        ]
        assert response.commercial_intelligence.products[0].relationship.value == "CURRENT"
        assert response.metadata.commercial_items_accepted == 1
        assert response.metadata.tokens_input == 127 and response.metadata.tokens_output == 43
        assert "extracted=0 context_candidates=1 grounded=1 verified=1" in caplog.text
        assert "LedgerOne" not in caplog.text
    else:
        floor.assert_not_called()
        assert seen == ["meeting_analysis", "meeting_summary_verification"]
        assert response.commercial_intelligence is None


def test_invalid_extracted_references_do_not_turn_into_context_candidates_in_the_pipeline():
    client = MagicMock()

    def answer(**kwargs):
        if kwargs["schema_name"] == "meeting_analysis":
            return (
                json.dumps(
                    _payload([{"name": "LedgerOne", "relationship": "CURRENT", "evidenceId": 999}])
                ),
                100,
                30,
            )
        return (
            json.dumps(
                {"summary": "The customer discussed its current software and approved a follow-up."}
            ),
            20,
            10,
        )

    client.chat_structured.side_effect = answer
    with patch.object(llm_analyzer, "LlmClient", return_value=client):
        response = llm_analyzer.analyze(_request(), Settings())
    assert response.commercial_intelligence.products == []
    assert response.metadata.commercial_items_rejected == 1
    assert client.chat_structured.call_count == 2


def test_context_names_are_shielded_before_candidate_matching():
    request = _request()
    request.tenant_context.competitors = []
    from nora_nlp.models import TenantProduct

    request.tenant_context.products = [TenantProduct(name="sales@example.com")]
    request.transcript = "The contact [[EMAIL_1]] approved a follow-up."
    client = MagicMock()
    client.chat_structured.return_value = (json.dumps(_payload()), 100, 30)
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(
            llm_analyzer, "verify_summary", side_effect=lambda _, summary, *args: (summary, 0, 0)
        ),
        patch.object(
            llm_analyzer, "add_context_product_candidates", wraps=add_context_product_candidates
        ) as floor,
    ):
        response = llm_analyzer.analyze(request, Settings())
    names = floor.call_args.args[2]
    assert "sales@example.com" not in names
    assert any("[[EMAIL_" in name for name in names)
    assert response.commercial_intelligence.products == []
    client.chat_structured.assert_called_once()
