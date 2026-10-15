"""The API's workspace entitlement suppresses commercial confidence in both analyzers."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from nora_nlp.models import AnalyzeOptions, AnalyzeRequest
from nora_nlp.services import llm_analyzer, stub_analyzer
from nora_nlp.settings import Settings


def _request() -> AnalyzeRequest:
    return AnalyzeRequest(
        meetingId="meeting-core",
        tenantId="00000000-0000-4000-8000-000000000001",
        transcript="Client: We want to proceed with the proposal. Please send it tomorrow.",
        language="en",
        tenantContext={"companyName": "Core workspace", "valueProposition": ""},
        options={"includeCustomerConfidence": False},
    )


def test_options_keep_the_wire_contract_and_older_callers():
    assert AnalyzeOptions().include_customer_confidence is True
    options = AnalyzeOptions(includeCustomerConfidence=False)
    assert options.include_customer_confidence is False
    assert options.model_dump(by_alias=True)["includeCustomerConfidence"] is False


def test_stub_does_not_run_customer_confidence_when_disabled():
    with patch.object(stub_analyzer, "_customer_confidence") as confidence:
        result = stub_analyzer.analyze(_request())
    confidence.assert_not_called()
    assert result.customer_confidence is None
    assert result.summary


@pytest.mark.parametrize("fallback", [False, True])
def test_disabled_confidence_is_null_even_if_the_provider_returns_it(fallback):
    response = stub_analyzer.analyze(_request()).model_dump(by_alias=True)
    response.pop("meetingId")
    response.pop("metadata")
    response.pop("quality", None)
    # Invalid commercial data must not survive or break the Core analysis.
    response["customerConfidence"] = {"score": 99, "unexpected": "restricted commercial result"}
    response["commercialIntelligence"] = {"products": "restricted commercial result"}
    raw = json.dumps(response)
    client = MagicMock()
    client.chat_structured.return_value = (raw, 10, 20)
    client.chat_json.return_value = (raw, 10, 20)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured transport unavailable")
    settings = Settings(llm_api_key="test-key", use_llm_stub=False)
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(
            llm_analyzer,
            "verify_summary",
            side_effect=lambda _, summary, *args: (summary, 0, 0),
        ),
    ):
        result = llm_analyzer.analyze(_request(), settings)
    assert result.customer_confidence is None
    assert result.commercial_intelligence is None
    assert result.metadata.commercial_items_accepted == 0
    assert result.metadata.commercial_items_rejected == 0
    assert "restricted commercial result" not in result.model_dump_json()
    first = client.chat_structured.call_args.kwargs
    assert first["json_schema"]["properties"]["customerConfidence"] == {"type": "null"}
    assert first["json_schema"]["properties"]["commercialIntelligence"] == {"type": "null"}
    assert "Customer Confidence is disabled" in first["system_prompt"]
    if fallback:
        prompt = client.chat_json.call_args.kwargs["system_prompt"]
        assert "Customer Confidence is disabled" in prompt
