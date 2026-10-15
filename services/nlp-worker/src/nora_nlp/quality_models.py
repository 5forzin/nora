"""Deterministic observation counts, separate from generated analysis schemas."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class QualityModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class EvidenceCounts(QualityModel):
    total: int = Field(ge=0)
    with_source_quote: int = Field(ge=0, alias="withSourceQuote")
    matched_source_quote: int | None = Field(default=None, ge=0, alias="matchedSourceQuote")


class TranscriptMetrics(QualityModel):
    character_count: int = Field(ge=0, alias="characterCount")
    non_empty_line_count: int = Field(ge=0, alias="nonEmptyLineCount")
    speaker_label_count: int | None = Field(default=None, ge=0, alias="speakerLabelCount")
    labeled_turn_count: int | None = Field(default=None, ge=0, alias="labeledTurnCount")
    empty_labeled_turn_count: int | None = Field(default=None, ge=0, alias="emptyLabeledTurnCount")
    replacement_character_count: int = Field(ge=0, alias="replacementCharacterCount")
    control_character_count: int = Field(ge=0, alias="controlCharacterCount")
    duplicate_line_count: int = Field(ge=0, alias="duplicateLineCount")


class CommercialMetrics(QualityModel):
    products: EvidenceCounts
    personas: EvidenceCounts
    budgets: EvidenceCounts
    sentiment_by_topic: EvidenceCounts = Field(alias="sentimentByTopic")


class ExtractionMetrics(QualityModel):
    action_items: EvidenceCounts = Field(alias="actionItems")
    action_items_with_assignee: int = Field(ge=0, alias="actionItemsWithAssignee")
    action_items_with_due_date: int = Field(ge=0, alias="actionItemsWithDueDate")
    risks: EvidenceCounts
    opportunities: EvidenceCounts
    commercial: CommercialMetrics | None = None


class AnalysisQuality(QualityModel):
    version: Literal["1"] = "1"
    origin: Literal["WORKER", "LEGACY_DERIVED"]
    transcript: TranscriptMetrics | None
    extraction: ExtractionMetrics
