"""Observable quality counts must remain deterministic and independent of a provider."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from nora_nlp.clients.llm import build_json_schema_for_analysis
from nora_nlp.models import AnalyzeMetadata, AnalyzeResponse, CommercialIntelligence
from nora_nlp.quality_models import AnalysisQuality
from nora_nlp.services.analysis_quality import measure, transcript_metrics

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "packages/shared-contracts/analysis-quality-observations-v1.examples.json"
    ).read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", FIXTURES, ids=lambda case: case["name"])
def test_transcript_counts_match_the_shared_observations(case):
    assert transcript_metrics(case["text"]).model_dump(by_alias=True) == case["expected"]


def response(**updates):
    return AnalyzeResponse(
        meetingId="meeting",
        summary="A sufficiently long summary for this deterministic quality test.",
        sentimentOverall="NEUTRAL",
        metadata=AnalyzeMetadata(modelVersion="test", promptVersion="test"),
        **updates,
    )


def test_traceability_checks_only_normalized_protected_source_and_retained_items():
    analysis = response(
        actionItems=[
            {
                "title": "Confirm the proposal",
                "assignee": "[[PERSON_NAME_1]]",
                "dueDate": "2026-10-16",
                "priority": "HIGH",
                "sourceQuote": "The pilot\nwas approved.",
            },
            {
                "title": "An unsupported suggestion",
                "assignee": None,
                "dueDate": None,
                "priority": "LOW",
                "sourceQuote": "The entire contract was approved.",
            },
        ]
    )
    original = analysis.model_dump()
    quality = measure(
        "Raw text does not contain either quote.", "The pilot was approved.", analysis
    )
    assert quality.origin == "WORKER"
    assert quality.extraction.action_items.total == 2
    assert quality.extraction.action_items.with_source_quote == 2
    assert quality.extraction.action_items.matched_source_quote == 1
    assert quality.extraction.action_items_with_assignee == 1
    assert quality.extraction.action_items_with_due_date == 1
    assert analysis.model_dump() == original
    assert "accuracy" not in quality.model_dump_json()


def test_core_quality_does_not_count_commercial_content_even_if_an_upstream_object_exists():
    analysis = response(commercialIntelligence=CommercialIntelligence())
    assert measure("Source.", "Source.", analysis).extraction.commercial is not None
    assert (
        measure("Source.", "Source.", analysis, include_commercial=False).extraction.commercial
        is None
    )


def test_quality_never_enters_the_generation_schema():
    assert "quality" not in build_json_schema_for_analysis()["properties"]


def test_quality_schema_is_a_separate_optional_response_contract():
    path = Path(__file__).resolve().parents[3] / "docs/api/analysis-quality-v1.schema.json"
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    assert schema.pop("$id") == "urn:nora:schemas:analysis-quality:v1"
    schema.pop("$schema")
    assert schema == AnalysisQuality.model_json_schema(by_alias=True)
    payload = measure("Source.", "Source.", response()).model_dump(by_alias=True)
    Draft202012Validator(schema).validate(payload)
    assert "quality" in AnalyzeResponse.model_json_schema(by_alias=True)["properties"]


def test_case_and_person_identities_are_not_fuzzily_matched_or_returned():
    analysis = response(
        risks=[
            {
                "text": "A relevant risk.",
                "severity": "LOW",
                "category": "OTHER",
                "sourceQuote": "THE PILOT WAS APPROVED.",
            }
        ]
    )
    quality = measure("Actual customer name: Private Person.", "The pilot was approved.", analysis)
    assert quality.extraction.risks.matched_source_quote == 0
    assert "Private Person" not in quality.model_dump_json()
