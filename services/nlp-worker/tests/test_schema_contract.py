"""Contract between the canonical JSON Schema and the worker output (ADR 0006).

Ensures that (a) the canonical schema in docs/ is a valid JSON Schema and (b) the
worker response — including the customerConfidence block with accountName —
validates against that schema. Keeps models.py and the canonical schema in sync.
"""

from __future__ import annotations

import copy
import json
import pathlib

import pytest
from jsonschema import Draft202012Validator

from nora_nlp.clients.llm import build_json_schema_for_analysis
from nora_nlp.models import (
    AnalyzeRequest,
    CommercialIntelligence,
    LiveHighlightsV1,
    MeetingAnalysisV1,
)
from nora_nlp.services.live_analyzer import _build_json_schema_for_live
from nora_nlp.services.stub_analyzer import analyze

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data" / "synthetic"
SCHEMA_PATH = REPO_ROOT / "docs" / "api" / "llm-schemas" / "meeting-analysis-v1.schema.json"


def _canonical_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _stub_response(transcript_file: str, tenant: str) -> dict:
    transcript = (DATA_DIR / "meetings" / transcript_file).read_text(encoding="utf-8")
    tenant_ctx = json.loads(
        (DATA_DIR / "tenants" / f"{tenant}.context.json").read_text(encoding="utf-8")
    )
    req = AnalyzeRequest.model_validate(
        {
            "meetingId": "00000000-0000-4000-8000-000000000aaa",
            "tenantId": "00000000-0000-4000-8000-000000000001",
            "language": "pt-BR",
            "transcript": transcript,
            "tenantContext": tenant_ctx,
        }
    )
    # by_alias=True -> camelCase, same as what the backend receives.
    return analyze(req).model_dump(by_alias=True, mode="json")


def test_canonical_schema_is_valid_json_schema():
    """The canonical schema must be a valid Draft 2020-12."""
    Draft202012Validator.check_schema(_canonical_schema())


def test_commercial_v1_artifact_matches_runtime_and_the_optional_analysis_extension():
    artifact = json.loads(
        (SCHEMA_PATH.parent / "commercial-intelligence-v1.schema.json").read_text(encoding="utf-8")
    )
    Draft202012Validator.check_schema(artifact)
    assert artifact.pop("$id") == "urn:nora:schemas:commercial-intelligence:v1"
    artifact.pop("$schema")
    assert artifact == CommercialIntelligence.model_json_schema(by_alias=True)
    canonical = _canonical_schema()
    for name, definition in artifact["$defs"].items():
        assert canonical["$defs"][name] == definition
    assert canonical["$defs"]["CommercialIntelligence"] == {
        key: value for key, value in artifact.items() if key != "$defs"
    }
    assert "commercialIntelligence" not in canonical["required"]
    legacy = _provider_payload()
    legacy.pop("commercialIntelligence", None)
    Draft202012Validator(canonical).validate(legacy)


def test_canonical_schema_declares_account_name():
    """accountName was added to the customerConfidence properties (Slice 2)."""
    cc = _canonical_schema()["properties"]["customerConfidence"]
    account_name = cc["properties"]["accountName"]
    assert account_name["type"] == ["string", "null"]
    assert account_name["maxLength"] == 120
    # The description must no longer mark the field as reserved/not emitted.
    desc = cc["description"].upper()
    assert "RESERVADO" not in desc
    assert "AINDA NÃO EMITIDO" not in desc
    assert "EMITIDO" in desc


@pytest.mark.parametrize(
    "transcript,tenant",
    [
        ("01-acme-discovery-lead-novo.txt", "acme-software"),
        ("06-northwind-prospect-poc.txt", "northwind-fintech"),
        ("08-northwind-objecao-integracao-tecnica.txt", "northwind-fintech"),
    ],
)
def test_stub_response_validates_against_canonical_schema(transcript: str, tenant: str):
    """Stub output (with customerConfidence populated) validates against the canonical schema."""
    validator = Draft202012Validator(_canonical_schema())
    body = _stub_response(transcript, tenant)
    # Metadata is not part of the canonical schema; the schema uses
    # additionalProperties=false, so we drop the extra fields from the response.
    body.pop("metadata", None)
    body.pop("meetingId", None)
    # Sanity: this transcript exercises the customerConfidence block (not null).
    assert body["customerConfidence"] is not None
    errors = sorted(validator.iter_errors(body), key=lambda e: e.path)
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_internal_meeting_response_validates_against_canonical_schema():
    """customerConfidence = null is also valid against the schema (nullable field)."""
    transcript = (
        "[Ana] Bom dia time, vamos revisar o andamento das tarefas de hoje.\n"
        "[Bruno] Terminei o ajuste no layout da tela inicial ontem a noite.\n"
        "[Ana] Otimo. Alguem travado em algo?\n"
        "[Bruno] Nada por aqui, fluindo bem.\n"
        "[Ana] Entao seguimos. Bom trabalho a todos."
    )
    tenant_ctx = json.loads(
        (DATA_DIR / "tenants" / "solo-launch.context.json").read_text(encoding="utf-8")
    )
    req = AnalyzeRequest.model_validate(
        {
            "meetingId": "00000000-0000-4000-8000-000000000aaa",
            "tenantId": "00000000-0000-4000-8000-000000000001",
            "language": "pt-BR",
            "transcript": transcript,
            "tenantContext": tenant_ctx,
        }
    )
    body = req and analyze(req).model_dump(by_alias=True, mode="json")
    body.pop("metadata", None)
    body.pop("meetingId", None)
    assert body["customerConfidence"] is None
    validator = Draft202012Validator(_canonical_schema())
    errors = list(validator.iter_errors(body))
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_strict_llm_schema_matches_canonical_enums():
    """The strict schema enums (llm.py) match the canonical schema (source of truth)."""
    strict = build_json_schema_for_analysis()["$defs"]
    canon = _canonical_schema()["properties"]["customerConfidence"]["properties"]

    assert strict["ConfidenceBand"]["enum"] == canon["band"]["enum"]
    assert [*strict["ConfidenceTrend"]["enum"], None] == canon["trend"]["enum"]
    assert (
        strict["BuyingSignalType"]["enum"]
        == (canon["buyingSignals"]["items"]["properties"]["type"]["enum"])
    )
    assert (
        strict["ObjectionType"]["enum"]
        == (canon["objections"]["items"]["properties"]["type"]["enum"])
    )


def _provider_payload() -> dict:
    body = _stub_response("01-acme-discovery-lead-novo.txt", "acme-software")
    for field in ("metadata", "meetingId", "baselineTerms"):
        body.pop(field, None)
    body["productivity"] = {
        "score": 50,
        "band": "MEDIUM",
        "coverage": [{"expectedOutcome": "Agree on scope", "status": "PARTIAL", "evidence": None}],
        "offTopicRatio": 0.2,
        "decisionDensity": 0.4,
        "rationale": "Some outcomes still need confirmation.",
    }
    return body


def _failed_constraints(errors):
    for error in errors:
        yield error.validator
        yield from _failed_constraints(error.context)


@pytest.mark.parametrize(
    "field,limit,item",
    [
        ("decisions", 20, {"text": "Approve the next phase", "confidence": 1}),
        (
            "actionItems",
            30,
            {
                "title": "Send the revised proposal",
                "assignee": None,
                "dueDate": None,
                "priority": "HIGH",
                "sourceQuote": "We will send the revised proposal.",
            },
        ),
        (
            "risks",
            20,
            {
                "text": "Budget has not been approved",
                "severity": "HIGH",
                "category": "PRICE",
                "sourceQuote": "The budget is still under review.",
            },
        ),
        (
            "opportunities",
            20,
            {
                "text": "Add the reporting module",
                "estimatedValue": "MEDIUM",
                "category": "UPSELL",
                "sourceQuote": "We also need the reporting module.",
            },
        ),
        ("topics", 12, "Budget"),
        ("participants", 30, {"name": "[[PERSON_NAME_1]]", "role": None, "mentionCount": 1}),
    ],
)
def test_provider_and_validator_share_collection_bounds(field, limit, item):
    schema = build_json_schema_for_analysis()
    validator = Draft202012Validator(schema)
    payload = _provider_payload()
    payload[field] = [item] * limit
    validator.validate(payload)
    MeetingAnalysisV1.model_validate(payload)
    payload[field].append(item)
    assert "maxItems" in _failed_constraints(validator.iter_errors(payload))
    with pytest.raises(ValueError):
        MeetingAnalysisV1.model_validate(payload)


@pytest.mark.parametrize("field", ["buyingSignals", "objections"])
def test_provider_limits_nested_customer_collections(field):
    payload = _provider_payload()
    item = (
        {"type": "BUDGET_DISCUSSED", "quote": "There is budget for this project.", "weight": 1}
        if field == "buyingSignals"
        else {
            "type": "PRICE",
            "quote": "The price exceeds our budget.",
            "severity": "HIGH",
            "competitor": None,
        }
    )
    payload["customerConfidence"][field] = [item] * 20
    validator = Draft202012Validator(build_json_schema_for_analysis())
    validator.validate(payload)
    payload["customerConfidence"][field].append(item)
    assert "maxItems" in _failed_constraints(validator.iter_errors(payload))


@pytest.mark.parametrize(
    "path,value,constraint",
    [
        (("summary",), "x" * 29, "minLength"),
        (("summary",), "x" * 2001, "maxLength"),
        (("topics",), ["x" * 61], "maxLength"),
        (("participants",), [{"name": "x" * 121, "role": None, "mentionCount": 1}], "maxLength"),
        (
            ("participants",),
            [{"name": "[[PERSON_NAME_1]]", "role": None, "mentionCount": 0}],
            "minimum",
        ),
        (("decisions",), [{"text": "A valid decision", "confidence": 1.1}], "maximum"),
        (("customerConfidence", "accountName"), "x" * 121, "maxLength"),
        (("customerConfidence", "rationale"), "x" * 1001, "maxLength"),
        (("customerConfidence", "score"), 101, "maximum"),
        (("customerConfidence", "score"), -1, "minimum"),
        (("productivity", "rationale"), "x" * 9, "minLength"),
        (("productivity", "decisionDensity"), 1.1, "maximum"),
        (("productivity", "offTopicRatio"), -0.1, "minimum"),
        (
            ("productivity", "coverage"),
            [{"expectedOutcome": "Agree on scope", "status": "PARTIAL", "evidence": "x" * 501}],
            "maxLength",
        ),
    ],
)
def test_provider_enforces_nested_text_and_number_bounds(path, value, constraint):
    payload = _provider_payload()
    target = payload
    for field in path[:-1]:
        target = target[field]
    target[path[-1]] = value
    validator = Draft202012Validator(build_json_schema_for_analysis())
    assert constraint in _failed_constraints(validator.iter_errors(payload))
    with pytest.raises(ValueError):
        MeetingAnalysisV1.model_validate(payload)


@pytest.mark.parametrize("build", [build_json_schema_for_analysis, _build_json_schema_for_live])
def test_provider_schema_requires_all_keys_and_forbids_extras(build):
    schema = build()
    Draft202012Validator.check_schema(schema)

    def check(node):
        if isinstance(node, dict):
            if "$ref" in node:
                assert set(node) == {"$ref"}, "Strict providers reject siblings beside $ref"
            if node.get("type") == "object":
                assert set(node["required"]) == set(node["properties"])
                assert node["additionalProperties"] is False
            assert "default" not in node
            for child in node.values():
                check(child)
        elif isinstance(node, list):
            for child in node:
                check(child)

    check(schema)
    assert "baselineTerms" not in schema["properties"]


def test_live_provider_preserves_task_fields_and_bounds():
    payload = {
        "decisions": [],
        "nextSteps": [],
        "observations": [],
        "tasks": [
            {
                "title": "Send proposal",
                "assignee": None,
                "priority": "HIGH",
                "sourceQuote": "I will send the proposal.",
            }
        ]
        * 30,
    }
    validator = Draft202012Validator(_build_json_schema_for_live())
    validator.validate(payload)
    LiveHighlightsV1.model_validate(payload)
    excess = copy.deepcopy(payload)
    excess["tasks"].append(payload["tasks"][0])
    assert any(error.validator == "maxItems" for error in validator.iter_errors(excess))
    payload["tasks"][0]["title"] = "x" * 241
    assert any(error.validator == "maxLength" for error in validator.iter_errors(payload))
