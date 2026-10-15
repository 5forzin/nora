"""Internal evidence references resolve to unchanged, request-local shielded text."""

from __future__ import annotations

import json
import re
from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

MAX_EVIDENCE_CHARACTERS = 500
_DEFINITIONS = ("CommercialProduct", "CommercialPersona", "CommercialBudget", "TopicSentiment")
_COLLECTIONS = ("products", "personas", "budgets", "sentimentByTopic")


@dataclass(frozen=True, slots=True)
class EvidenceSegment:
    evidence_id: int
    start: int
    end: int
    text: str


def segment_evidence(transcript: str) -> tuple[EvidenceSegment, ...]:
    segments = []
    start = 0
    for line in transcript.splitlines(keepends=True):
        line_end = start + len(line)
        while start < line_end:
            end = min(start + MAX_EVIDENCE_CHARACTERS, line_end)
            if end < line_end:
                boundary = max(
                    transcript.rfind(" ", start, end), transcript.rfind("\t", start, end)
                )
                if boundary > start:
                    end = boundary + 1
            segments.append(EvidenceSegment(len(segments) + 1, start, end, transcript[start:end]))
            start = end
    return tuple(segments)


def render_evidence(segments: tuple[EvidenceSegment, ...]) -> str:
    return json.dumps(
        [{"evidenceId": item.evidence_id, "text": item.text} for item in segments],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _unsafe_boundaries(source: str) -> set[int]:
    unsafe_boundaries = set()
    for placeholder in re.finditer(r"\[\[?[A-Z][A-Z0-9_ -]*\]\]?", source, re.I):
        unsafe_boundaries.update(range(placeholder.start() + 1, placeholder.end()))
    return unsafe_boundaries


def _product_evidence_range(
    segments: tuple[EvidenceSegment, ...], index: int, unsafe_boundaries: set[int]
) -> tuple[int, int] | None:
    left = right = index
    while left > 0 and segments[right].end - segments[left - 1].start <= MAX_EVIDENCE_CHARACTERS:
        left -= 1
    while (
        right + 1 < len(segments)
        and segments[right + 1].end - segments[left].start <= MAX_EVIDENCE_CHARACTERS
    ):
        right += 1
    start, end = segments[left].start, segments[right].end
    return None if start in unsafe_boundaries or end in unsafe_boundaries else (start, end)


def product_evidence_windows(
    segments: tuple[EvidenceSegment, ...], evidence_ids: Iterable[int] | None = None
) -> dict[int, str]:
    source = "".join(item.text for item in segments)
    unsafe_boundaries = _unsafe_boundaries(source)
    windows = {}
    for evidence_id in evidence_ids if evidence_ids is not None else range(1, len(segments) + 1):
        if type(evidence_id) is not int or not 1 <= evidence_id <= len(segments):
            continue
        span = _product_evidence_range(segments, evidence_id - 1, unsafe_boundaries)
        if span is not None:
            start, end = span
            windows[evidence_id] = source[start:end]
    return windows


def product_evidence_choices(
    segments: tuple[EvidenceSegment, ...], names: Iterable[str]
) -> tuple[tuple[int, ...], ...]:
    source = "".join(item.text for item in segments)
    starts = [segment.start for segment in segments]
    ends = [segment.end for segment in segments]
    unsafe = _unsafe_boundaries(source)
    ranges = {}
    choices = []
    for name in names:
        pattern = r"(?<!\w)" + r"\s+".join(re.escape(word) for word in name.split()) + r"(?!\w)"
        eligible = set()
        if not name.strip():
            choices.append(())
            continue
        for match in re.finditer(pattern, source, re.I):
            first = bisect_left(starts, match.end() - MAX_EVIDENCE_CHARACTERS)
            last = bisect_right(ends, match.start() + MAX_EVIDENCE_CHARACTERS)
            for index in range(first, last):
                if index not in ranges:
                    ranges[index] = _product_evidence_range(segments, index, unsafe)
                span = ranges[index]
                if (
                    span is not None
                    and span[0] <= match.start()
                    and span[1] >= match.end()
                    and span[1] - span[0] >= 5
                ):
                    eligible.add(segments[index].evidence_id)
        choices.append(tuple(sorted(eligible)))
    return tuple(choices)


def use_evidence_schema(schema: dict[str, Any], count: int) -> None:
    for name in _DEFINITIONS:
        definition = schema["$defs"][name]
        del definition["properties"]["sourceQuote"]
        definition["properties"]["evidenceId"] = {
            "type": "integer",
            "minimum": 1,
            "maximum": max(1, count),
            "description": (
                "ID of the transcript segment that directly supports this observation. "
                "Select a segment containing its product name, role or monetary fact. "
                "For a non-null speaker, the same segment must contain that literal speaker label. "
                "Do not invent IDs or copy a sourceQuote."
            ),
        }
        definition["required"] = [
            "evidenceId" if key == "sourceQuote" else key for key in definition["required"]
        ]


def resolve_evidence(
    commercial: dict[str, Any], segments: tuple[EvidenceSegment, ...]
) -> tuple[dict[str, Any], int]:
    by_id = {item.evidence_id: item.text for item in segments}
    result = dict(commercial)
    rejected = 0
    for name in _COLLECTIONS:
        resolved = []
        for item in commercial[name]:
            # Legacy provider responses may still contain literal quotes. Their grounding is
            # unchanged; an explicit invalid reference must never fall back to supplied text.
            if not isinstance(item, dict) or ("evidenceId" not in item and "sourceQuote" in item):
                resolved.append(item)
                continue
            evidence_id = item.get("evidenceId")
            text = by_id.get(evidence_id) if type(evidence_id) is int else None
            if text is None or len(text) < 5:
                rejected += 1
                continue
            observation = {key: value for key, value in item.items() if key != "evidenceId"}
            observation["sourceQuote"] = text
            resolved.append(observation)
        result[name] = resolved
    return result, rejected
