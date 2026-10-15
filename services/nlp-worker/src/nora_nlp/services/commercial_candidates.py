"""Literal configured names are candidates, never inferred customer relationships."""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Iterable

from ..models import CommercialIntelligence, CommercialProduct, ProductRelationship
from .commercial_evidence import EvidenceSegment, product_evidence_windows
from .commercial_grounding import is_product_placeholder, normalize_quote


def add_context_product_candidates(
    intelligence: CommercialIntelligence,
    transcript: str,
    names: Iterable[str],
    segments: tuple[EvidenceSegment, ...],
    *,
    extracted_names: Iterable[str] = (),
) -> tuple[CommercialIntelligence, int]:
    products = list(intelligence.products)
    seen = {normalize_quote(name).casefold() for name in extracted_names}
    seen.update(normalize_quote(product.name).casefold() for product in products)
    starts = [segment.start for segment in segments]
    added = 0
    for configured_name in names:
        if len(products) >= 30:
            break
        name = configured_name.strip()
        key = normalize_quote(name).casefold()
        if not name or len(name) > 160 or key in seen or is_product_placeholder(name):
            continue
        for match in re.finditer(r"(?<!\w)" + re.escape(name) + r"(?!\w)", transcript, re.I):
            index = bisect_right(starts, match.end() - 1) - 1
            if index < 0:
                continue
            evidence_id = segments[index].evidence_id
            quote = product_evidence_windows(segments, [evidence_id]).get(evidence_id)
            if quote is None or len(quote) < 5 or match.group(0) not in quote:
                continue
            products.append(
                CommercialProduct(
                    name=match.group(0),
                    relationship=ProductRelationship.MENTIONED,
                    sourceQuote=quote,
                )
            )
            seen.add(key)
            added += 1
            break
    return intelligence.model_copy(update={"products": products}), added
