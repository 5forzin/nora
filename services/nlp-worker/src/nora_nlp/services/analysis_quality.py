"""Count observable text properties and retained-item evidence without scoring accuracy."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

from ..models import AnalyzeResponse
from ..quality_models import (
    AnalysisQuality,
    CommercialMetrics,
    EvidenceCounts,
    ExtractionMetrics,
    TranscriptMetrics,
)

_LABEL = re.compile(
    r"(?<![\w\[])(?:\[(?P<bracket>(?:LOCUTOR|SPEAKER)[ _]*\d+)\]|"
    r"(?P<plain>(?:LOCUTOR|SPEAKER)[ _]*\d+))\s*:",
    re.IGNORECASE,
)


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def transcript_metrics(text: str) -> TranscriptMetrics:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    non_empty = [normalized for line in lines if (normalized := normalize(line))]
    labels: set[str] = set()
    turns: list[bool] = []
    matches = list(_LABEL.finditer(text))
    for index, match in enumerate(matches):
        label = match.group("bracket") or match.group("plain")
        labels.add(re.sub(r"[ _]+", "", label).upper())
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        turns.append(bool(normalize(text[match.end() : end])))
    return TranscriptMetrics(
        character_count=len(text),
        non_empty_line_count=len(non_empty),
        speaker_label_count=len(labels) if turns else None,
        labeled_turn_count=len(turns) if turns else None,
        empty_labeled_turn_count=sum(not content for content in turns) if turns else None,
        replacement_character_count=text.count("\ufffd"),
        control_character_count=sum(
            unicodedata.category(char) == "Cc" and char not in "\t\r\n" for char in text
        ),
        duplicate_line_count=sum(count - 1 for count in Counter(non_empty).values()),
    )


def measure(
    raw_text: str,
    protected_text: str,
    response: AnalyzeResponse,
    *,
    include_commercial: bool = True,
) -> AnalysisQuality:
    source = normalize(protected_text)

    def evidence(items) -> EvidenceCounts:
        quotes = [normalize(item.source_quote) for item in items if item.source_quote.strip()]
        return EvidenceCounts(
            total=len(items),
            with_source_quote=len(quotes),
            matched_source_quote=sum(quote in source for quote in quotes),
        )

    commercial = response.commercial_intelligence if include_commercial else None
    return AnalysisQuality(
        origin="WORKER",
        transcript=transcript_metrics(raw_text),
        extraction=ExtractionMetrics(
            action_items=evidence(response.action_items),
            action_items_with_assignee=sum(
                bool(item.assignee and item.assignee.strip()) for item in response.action_items
            ),
            action_items_with_due_date=sum(
                item.due_date is not None for item in response.action_items
            ),
            risks=evidence(response.risks),
            opportunities=evidence(response.opportunities),
            commercial=(
                CommercialMetrics(
                    products=evidence(commercial.products),
                    personas=evidence(commercial.personas),
                    budgets=evidence(commercial.budgets),
                    sentiment_by_topic=evidence(commercial.sentiment_by_topic),
                )
                if commercial is not None
                else None
            ),
        ),
    )
