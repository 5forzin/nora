from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from nora_nlp.clients.llm import build_json_schema_for_analysis
from nora_nlp.main import app
from nora_nlp.models import AnalyzeRequest, CommercialIntelligence
from nora_nlp.services import llm_analyzer
from nora_nlp.services.commercial_evidence import (
    product_evidence_choices,
    product_evidence_windows,
    segment_evidence,
)
from nora_nlp.services.product_verifier import ProductVerificationError, verify_products
from nora_nlp.settings import Settings, get_settings
from nora_nlp.time_budget import LlmBudgetExceededError, TimeBudget


def _intelligence():
    return CommercialIntelligence(
        products=[
            {
                "name": "OldSuite",
                "relationship": "CURRENT",
                "sourceQuote": "We installed OldSuite.",
            },
            {"name": "LedgerOne", "relationship": "COMPETITOR", "sourceQuote": "We use LedgerOne."},
            {"name": "overview", "relationship": "CURRENT", "sourceQuote": "This is an overview."},
        ],
        budgets=[{"kind": "BUDGET", "approval": "UNKNOWN", "sourceQuote": "No budget is defined."}],
    )


def _review():
    return {
        "product0": {"relationship": "MENTIONED", "choice": 0},
        "product1": {"relationship": "CURRENT", "choice": 0},
        "product2": {"relationship": None, "choice": None},
    }


@pytest.mark.parametrize("fallback", [False, True])
def test_review_uses_existing_evidence_without_changing_names_or_other_fields(fallback):
    client = MagicMock()
    response = (json.dumps(_review()), 71, 19)
    client.chat_structured.return_value = response
    client.chat_json.return_value = response
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Strict output unsupported")
    original = _intelligence()
    transcript = (
        "We installed OldSuite.\nWe use LedgerOne.\nThis is an overview.\n"
        "Later we abandoned OldSuite and returned its licences. Email [[EMAIL_1]]."
    )
    result, tokens_in, tokens_out = verify_products(client, original, transcript, "en")
    assert [(item.name, item.relationship.value) for item in result.products] == [
        ("OldSuite", "MENTIONED"),
        ("LedgerOne", "CURRENT"),
    ]
    assert all(item.source_quote == transcript for item in result.products)
    assert result.budgets == original.budgets
    assert original.products[0].relationship.value == "CURRENT"
    assert (tokens_in, tokens_out) == (71, 19)
    request = client.chat_structured.call_args.kwargs
    user_data = json.loads(request["user_prompt"])
    assert "".join(item["text"] for item in user_data["transcriptSegments"]) == transcript
    assert set(user_data) == {"language", "transcriptSegments", "products"}
    assert "sourceQuote" not in user_data["products"]["product0"]
    schema = request["json_schema"]
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(_review())
    assert schema["additionalProperties"] is False
    assert set(schema["properties"]) == {"product0", "product1", "product2"}
    assert set(schema["properties"]["product0"]["properties"]) == {"relationship", "choice"}
    assert "returned licences" in request["system_prompt"]
    if fallback:
        assert client.chat_json.call_args.kwargs["user_prompt"] == request["user_prompt"]
        assert client.chat_json.call_args.kwargs["system_prompt"] == request["system_prompt"]


@pytest.mark.parametrize("fallback", [False, True])
def test_reviewer_input_is_independent_of_draft_relationship_and_citation(fallback):
    transcript = (
        "SELLER: LedgerOne can automate your documents.\nBUYER: We have not requested LedgerOne.\n"
    )
    requests = []
    for relationship, quote in [
        ("OPPORTUNITY", "SELLER: LedgerOne can automate your documents."),
        ("CURRENT", "BUYER: We have not requested LedgerOne."),
    ]:
        client = MagicMock()
        response = (json.dumps({"product0": {"relationship": "MENTIONED", "choice": 0}}), 7, 3)
        client.chat_structured.return_value = response
        client.chat_json.return_value = response
        if fallback:
            client.chat_structured.side_effect = RuntimeError("Strict output unsupported")
        intelligence = CommercialIntelligence(
            products=[{"name": "LedgerOne", "relationship": relationship, "sourceQuote": quote}]
        )
        result, _, _ = verify_products(client, intelligence, transcript, "en")
        assert result.products[0].relationship.value == "MENTIONED"
        request = client.chat_structured.call_args.kwargs
        data = json.loads(request["user_prompt"])
        assert data["products"] == {"product0": {"name": "LedgerOne", "evidenceChoices": [1, 2]}}
        requests.append(request)
        if fallback:
            assert client.chat_json.call_args.kwargs["user_prompt"] == request["user_prompt"]
    assert requests[0] == requests[1]


@pytest.mark.parametrize("fallback", [False, True])
def test_review_contract_distinguishes_approved_purchase_from_present_use(fallback):
    transcript = (
        "BUYER: We approved the budget for NovaSuite. Delivery is next month and "
        "installation is not scheduled. We have not started using it."
    )
    intelligence = CommercialIntelligence(
        products=[{"name": "NovaSuite", "relationship": "CURRENT", "sourceQuote": transcript}]
    )
    client = MagicMock()
    verdict = (json.dumps({"product0": {"relationship": "OPPORTUNITY", "choice": 0}}), 13, 5)
    client.chat_structured.return_value = verdict
    client.chat_json.return_value = verdict
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Strict output unsupported")

    result, tokens_in, tokens_out = verify_products(client, intelligence, transcript, "en")

    request = client.chat_structured.call_args.kwargs
    instructions = request["system_prompt"]
    assert "Require explicit evidence of actual present use" in instructions
    assert "Budget approval" in instructions and "a signed order or contract" in instructions
    assert "planned or ongoing installation do not establish present use" in instructions
    assert "OPPORTUNITY, never CURRENT" in instructions
    assert "does not erase that present use" in instructions
    description = build_json_schema_for_analysis()["$defs"]["CommercialProduct"]["properties"][
        "relationship"
    ]["description"]
    assert "Require actual present use" in description
    assert "whose use has not started supports OPPORTUNITY" in description
    assert result.products[0].name == "NovaSuite"
    assert result.products[0].source_quote == transcript
    assert result.products[0].relationship.value == "OPPORTUNITY"
    assert intelligence.products[0].relationship.value == "CURRENT"
    assert (tokens_in, tokens_out) == (13, 5)
    if fallback:
        assert client.chat_json.call_args.kwargs["system_prompt"] == instructions


@pytest.mark.parametrize("bad_index", [True, False, 1.0, "1", -1, 30, None, [], {}])
def test_choices_are_strict_bounded_integers(bad_index):
    client = MagicMock()
    response = _review()
    response["product1"]["choice"] = bad_index
    client.chat_structured.return_value = (json.dumps(response), 1, 1)
    with pytest.raises((ValidationError, ProductVerificationError)):
        verify_products(client, _intelligence(), _request().transcript, "en")
    client.chat_json.assert_not_called()


@pytest.mark.parametrize(
    "change", ["missing", "unknown", "invalid_enum", "extra_name", "extra_quote"]
)
def test_missing_unknown_or_extended_verdict_properties_fail_closed(change):
    client = MagicMock()
    response = _review()
    if change == "missing":
        del response["product2"]
    elif change == "unknown":
        response["product3"] = response.pop("product2")
    elif change == "invalid_enum":
        response["product1"]["relationship"] = "INVENTED"
    else:
        response["product1"]["name" if change == "extra_name" else "sourceQuote"] = "Injected"
    client.chat_structured.return_value = (json.dumps(response), 1, 1)
    with pytest.raises(ValidationError):
        verify_products(client, _intelligence(), _request().transcript, "en")


@pytest.mark.parametrize("intelligence", [None, CommercialIntelligence()])
def test_absent_legacy_or_empty_commercial_products_do_not_call_provider(intelligence):
    client = MagicMock()
    assert verify_products(client, intelligence, "Source", "en") == (intelligence, 0, 0)
    client.chat_structured.assert_not_called()
    client.chat_json.assert_not_called()


def test_product_verification_does_not_retry_when_shared_budget_is_spent():
    client = MagicMock()
    client.chat_structured.side_effect = LlmBudgetExceededError(
        "product review", elapsed=80, total=90
    )
    with pytest.raises(LlmBudgetExceededError):
        verify_products(client, _intelligence(), "Source", "en")
    client.chat_json.assert_not_called()


def _request(enabled=True):
    return AnalyzeRequest(
        meetingId="product-review-fixture",
        tenantId="00000000-0000-4000-8000-000000000001",
        language="en",
        transcript=(
            "We installed OldSuite. We use LedgerOne. This is an overview. "
            "No budget is defined. We approved the next review."
        ),
        tenantContext={
            "companyName": "ACME",
            "products": [],
            "competitors": [],
            "valueProposition": "Software",
        },
        options={"includeCustomerConfidence": enabled},
    )


def _payload():
    return {
        "summary": "A complete summary of the systems discussed at this meeting.",
        "decisions": [],
        "actionItems": [],
        "risks": [],
        "opportunities": [],
        "sentimentOverall": "NEUTRAL",
        "topics": [],
        "participants": [],
        "commercialIntelligence": _intelligence().model_dump(by_alias=True),
    }


@pytest.mark.parametrize("enabled", [False, True])
def test_analysis_counts_all_passes_tokens_and_never_verifies_core(enabled):
    client = MagicMock()
    calls = []

    def answer(**kwargs):
        calls.append(kwargs["schema_name"])
        if kwargs["schema_name"] == "meeting_analysis":
            return json.dumps(_payload()), 100, 50
        if kwargs["schema_name"] == "meeting_summary_verification":
            return (
                json.dumps(
                    {"summary": "An independently checked summary of the products and budget."}
                ),
                20,
                10,
            )
        return json.dumps(_review()), 7, 3

    client.chat_structured.side_effect = answer
    budget = TimeBudget(90)
    with patch.object(llm_analyzer, "LlmClient", return_value=client) as factory:
        response = llm_analyzer.analyze(_request(enabled), Settings(), budget=budget)
    assert factory.call_args.kwargs["budget"] is budget
    if enabled:
        assert calls == [
            "meeting_analysis",
            "meeting_summary_verification",
            "meeting_product_verification",
        ]
        assert (response.metadata.tokens_input, response.metadata.tokens_output) == (127, 63)
        assert response.metadata.commercial_items_accepted == 3
        assert response.metadata.commercial_items_rejected == 1
        assert response.commercial_intelligence.products[0].relationship.value == "MENTIONED"
    else:
        assert "meeting_product_verification" not in calls
        assert response.commercial_intelligence is None


@pytest.mark.parametrize(
    "fault,expected",
    [
        (
            ProductVerificationError("Product verification must cover each supplied index once."),
            502,
        ),
        (LlmBudgetExceededError("product review", elapsed=80, total=90), 504),
    ],
)
def test_verification_errors_are_provider_or_budget_faults_never_configuration(
    fault, expected, caplog
):
    with patch("nora_nlp.routers.analyze.llm_analyzer.analyze", side_effect=fault):
        # Dependency overrides retain the route's real error handling.
        app.dependency_overrides[get_settings] = lambda: Settings(use_llm_stub=False)
        try:
            response = TestClient(app).post("/analyze", json=_request().model_dump(by_alias=True))
        finally:
            app.dependency_overrides.pop(get_settings, None)
    assert response.status_code == expected
    assert response.json()["detail"]["code"] != "LLM_CONFIG_INVALID"
    assert "OldSuite" not in caplog.text


def test_route_sends_only_shielded_source_and_already_grounded_products_to_the_verifier(
    monkeypatch,
):
    monkeypatch.setenv("USE_LLM_STUB", "false")
    client = MagicMock()
    seen = []

    def answer(**kwargs):
        name = kwargs["schema_name"]
        if name == "meeting_analysis":
            payload = _payload()
            payload["commercialIntelligence"]["products"] = [
                {
                    "name": "LedgerOne",
                    "relationship": "CURRENT",
                    "sourceQuote": "We use LedgerOne.",
                },
                {"name": "Invented", "relationship": "CURRENT", "sourceQuote": "Unseen product."},
            ]
            payload["commercialIntelligence"]["budgets"] = []
            return json.dumps(payload), 100, 50
        if name == "meeting_summary_verification":
            return json.dumps({"summary": "The customer confirmed their current system."}), 20, 10
        seen.append(json.loads(kwargs["user_prompt"]))
        return (
            json.dumps({"product0": {"relationship": "CURRENT", "choice": 0}}),
            7,
            3,
        )

    client.chat_structured.side_effect = answer
    request = _request()
    request.transcript = "We use LedgerOne. Email contact@example.com. Approved follow-up."
    with patch.object(llm_analyzer, "LlmClient", return_value=client):
        response = TestClient(app).post("/analyze", json=request.model_dump(by_alias=True))
    assert response.status_code == 200
    assert len(seen) == 1
    assert "contact@example.com" not in json.dumps(seen)
    assert "[[EMAIL_" in "".join(item["text"] for item in seen[0]["transcriptSegments"])
    assert [item["name"] for item in seen[0]["products"].values()] == ["LedgerOne"]
    assert "tenantContext" not in seen[0] and "competitors" not in seen[0]
    assert response.json()["metadata"]["commercialItemsRejected"] == 1


def test_product_verification_reuses_the_real_clients_remaining_request_budget():
    from nora_nlp.clients.llm import LlmClient

    now = [0.0]
    budget = TimeBudget(90, clock=lambda: now[0])
    with patch("nora_nlp.clients.llm.OpenAI") as sdk:
        client = LlmClient(Settings(llm_api_key="fake-test-key"), budget=budget)
        sdk.return_value.with_options.return_value.chat.completions.create.side_effect = (
            lambda **kwargs: None
        )
        # Analysis/summary have spent 60 seconds before this optional third call starts.
        now[0] = 60
        with patch.object(client, "_extract", return_value=(json.dumps(_review()), 7, 3)):
            verify_products(client, _intelligence(), _request().transcript, "en")
        options = sdk.return_value.with_options.call_args.kwargs
        assert options == {"timeout": 30, "max_retries": 0}
        sdk.return_value.with_options.reset_mock()
        now[0] = 71
        with pytest.raises(LlmBudgetExceededError):
            verify_products(client, _intelligence(), _request().transcript, "en")
        sdk.return_value.with_options.assert_not_called()


def test_product_review_strict_schema_has_no_siblings_of_reference_nodes():
    client = MagicMock()
    client.chat_structured.return_value = (json.dumps(_review()), 7, 3)
    verify_products(client, _intelligence(), _request().transcript, "en")
    schema = client.chat_structured.call_args.kwargs["json_schema"]

    def visit(node):
        if isinstance(node, dict):
            if "$ref" in node:
                assert set(node) == {"$ref"}
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for value in node:
                visit(value)

    visit(schema)


@pytest.mark.parametrize(
    "verdict",
    [
        {"relationship": "CURRENT", "choice": None},
        {"relationship": None, "choice": 0},
    ],
)
def test_relationship_and_choice_nullability_must_be_coherent(verdict):
    client = MagicMock()
    response = _review()
    response["product0"] = verdict
    client.chat_structured.return_value = (json.dumps(response), 7, 3)
    with pytest.raises(ProductVerificationError):
        verify_products(client, _intelligence(), _request().transcript, "en")


def test_a_product_without_any_literal_evidence_requires_a_null_verdict():
    client = MagicMock()
    client.chat_structured.return_value = (json.dumps(_review()), 7, 3)
    with pytest.raises(ProductVerificationError):
        verify_products(client, _intelligence(), "An unrelated discussion.", "en")
    client.chat_structured.return_value = (
        json.dumps({f"product{i}": {"relationship": None, "choice": None} for i in range(3)}),
        7,
        3,
    )
    result, _, _ = verify_products(client, _intelligence(), "An unrelated discussion.", "en")
    assert result.products == []
    assert result.budgets == _intelligence().budgets


def test_short_answer_can_select_contiguous_question_and_answer_evidence():
    source = "SPEAKER_1: What HR system do you use now?\r\nSPEAKER_2: PeopleSuite.\r\n"
    initial = CommercialIntelligence(
        products=[
            {
                "name": "PeopleSuite",
                "relationship": "CURRENT",
                "sourceQuote": "SPEAKER_2: PeopleSuite.",
            }
        ]
    )
    client = MagicMock()
    client.chat_structured.return_value = (
        json.dumps({"product0": {"relationship": "CURRENT", "choice": 1}}),
        7,
        3,
    )
    result, _, _ = verify_products(client, initial, source, "en")
    assert result.products[0].name == "PeopleSuite"
    assert result.products[0].source_quote == source
    assert initial.products[0].source_quote == "SPEAKER_2: PeopleSuite."
    assert len(result.products[0].source_quote) <= 500


def test_selected_evidence_can_capture_a_multi_turn_question_and_answer_window():
    source = (
        "SPEAKER_1: If we signed today, how long would implementation take?\n"
        "SPEAKER_2: From three\nSPEAKER_3: to six\nSPEAKER_2: months.\n"
        "SPEAKER_1: You mean implementation of LedgerOne?\nSPEAKER_2: Yes.\n"
    )
    segments = segment_evidence(source)
    assert len(segments) == 6 and len(source) < 500
    assert product_evidence_windows(segments, [5])[5] == source
    assert "".join(item.text for item in segments) == source


def test_product_context_windows_preserve_partition_offsets_and_complete_neighbors():
    source = "A" * 280 + "\r\n" + "B" * 200 + "\r\n" + "C" * 250 + "\r\n"
    segments = segment_evidence(source)
    windows = product_evidence_windows(segments)
    assert "".join(item.text for item in segments) == source
    assert windows[2] == segments[0].text + segments[1].text
    assert windows[3] == segments[1].text + segments[2].text
    assert all(len(quote) <= 500 and quote in source for quote in windows.values())


def test_windows_never_cut_placeholders_or_modify_the_analysis_partitioner():
    source = "x" * 496 + "[[EMAIL_1]]" + "x" * 10
    segments = segment_evidence(source)
    assert "".join(item.text for item in segments) == source
    assert len(segments[0].text) == 500
    assert product_evidence_windows(segments) == {}
    safe_source = "SPEAKER_1: Do you use LedgerOne?\nSPEAKER_2: Yes, contact [[EMAIL_1]].\n"
    windows = product_evidence_windows(segment_evidence(safe_source))
    assert all("[[EMAIL_1]]" in quote for quote in windows.values())


def test_the_verifier_receives_all_long_source_segments_once_and_can_select_late_evidence():
    source = "Unrelated background.\n" * 9000 + "SPEAKER_1: We use LedgerOne today.\n"
    assert len(source) > 185000
    segments = segment_evidence(source)
    initial = CommercialIntelligence(
        products=[
            {
                "name": "LedgerOne",
                "relationship": "MENTIONED",
                "sourceQuote": "We use LedgerOne today.",
            }
        ]
    )
    client = MagicMock()
    client.chat_structured.return_value = (
        json.dumps({"product0": {"relationship": "CURRENT", "choice": 0}}),
        70000,
        30,
    )
    result, tokens_in, tokens_out = verify_products(client, initial, source, "en")
    data = json.loads(client.chat_structured.call_args.kwargs["user_prompt"])
    assert "".join(item["text"] for item in data["transcriptSegments"]) == source
    assert set(data) == {"language", "transcriptSegments", "products"}
    assert len(data["transcriptSegments"]) == len(segments)
    assert result.products[0].relationship.value == "CURRENT"
    assert result.products[0].source_quote.endswith(segments[-1].text)
    assert result.products[0].source_quote in source
    assert (tokens_in, tokens_out) == (70000, 30)


def test_neighbor_without_the_product_name_is_not_an_available_choice():
    first = "SPEAKER_1: We use LedgerOne today. "
    first += "x" * (499 - len(first)) + "\n"
    source = first + "SPEAKER_2: " + "Unrelated background. " * 19
    segments = segment_evidence(source)
    assert len(segments[0].text) == 500
    assert product_evidence_choices(segments, ["LedgerOne"]) == ((1,),)
    initial = CommercialIntelligence(
        products=[
            {
                "name": "LedgerOne",
                "relationship": "CURRENT",
                "sourceQuote": "We use LedgerOne today.",
            }
        ]
    )
    client = MagicMock()
    client.chat_structured.return_value = (
        json.dumps({"product0": {"relationship": "CURRENT", "choice": 1}}),
        7,
        3,
    )
    with pytest.raises(ProductVerificationError):
        verify_products(client, initial, source, "en")
    schema = client.chat_structured.call_args.kwargs["json_schema"]
    assert list(
        Draft202012Validator(schema).iter_errors(
            {"product0": {"relationship": "CURRENT", "choice": 1}}
        )
    )
    client.chat_structured.return_value = (
        json.dumps({"product0": {"relationship": "CURRENT", "choice": 0}}),
        7,
        3,
    )
    result, _, _ = verify_products(client, initial, source, "en")
    assert result.products[0].source_quote == first
    assert result.products[0].source_quote != initial.products[0].source_quote


def test_choices_follow_grounding_case_and_whitespace_rules_without_fuzzy_spelling():
    source = "SPEAKER_1: We use LEDGER\tOne today. SuperERP is separate."
    choices = product_evidence_choices(segment_evidence(source), ["Ledger One", "LedgerOne", "ERP"])
    assert choices == ((1,), (), ())


def test_duplicate_verdict_properties_are_rejected_instead_of_overwriting_a_verdict():
    client = MagicMock()
    client.chat_structured.return_value = (
        '{"product0":{"relationship":"CURRENT","choice":0},'
        '"product0":{"relationship":null,"choice":null},'
        '"product1":{"relationship":"CURRENT","choice":0},'
        '"product2":{"relationship":null,"choice":null}}',
        7,
        3,
    )
    with pytest.raises(ProductVerificationError, match="duplicate properties"):
        verify_products(client, _intelligence(), _request().transcript, "en")


def test_each_product_has_its_own_choice_bound_and_original_evidence_mapping():
    first = "We use LedgerOne. " + "a" * 481 + "\n"
    second = "We abandoned OldSuite. " + "b" * 476 + "\n"
    assert len(first) == len(second) == 500
    source = first + second
    initial = CommercialIntelligence(
        products=[
            {"name": "LedgerOne", "relationship": "CURRENT", "sourceQuote": first},
            {"name": "OldSuite", "relationship": "CURRENT", "sourceQuote": second},
        ]
    )
    client = MagicMock()
    client.chat_structured.return_value = (
        json.dumps(
            {
                "product0": {"relationship": "CURRENT", "choice": 0},
                "product1": {"relationship": "MENTIONED", "choice": 0},
            }
        ),
        7,
        3,
    )
    result, _, _ = verify_products(client, initial, source, "en")
    data = json.loads(client.chat_structured.call_args.kwargs["user_prompt"])
    assert data["products"]["product0"]["evidenceChoices"] == [1]
    assert data["products"]["product1"]["evidenceChoices"] == [2]
    assert [product.source_quote for product in result.products] == [first, second]
