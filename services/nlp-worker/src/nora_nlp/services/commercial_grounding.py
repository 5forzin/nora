"""Keep commercial observations tied to the shielded text, never reconstructed identities."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Literal

from ..models import CommercialBudget, CommercialIntelligence, CommercialPersona, DecisionRole
from .commercial_money import monetary_amount_is_qualified, written_monetary_amounts

_SPEAKER = re.compile(
    r"\[(?:LOCUTOR|SPEAKER)[ _#-]*\d+\]|"
    r"(?:LOCUTOR|SPEAKER)[ _#-]*(?:\d+|[A-Z])|\[\[PERSON_NAME_\d+\]\]",
    re.I,
)
_TURN = re.compile(r"(?P<label>" + _SPEAKER.pattern + r")\s*:", re.I)
_PRODUCT_PLACEHOLDER = re.compile(r"\[\[?[A-Z][A-Z0-9_ -]*\]\]?", re.I)
_NUMBER = re.compile(
    r"(?<![\d.,])(?P<number>\d+(?:[.,]\d+)*)(?:\s*(?P<scale>"
    r"milh[oõ]es|milh[aã]o|millions?|thousand|mil|[kK]))?(?!\w)",
    re.I,
)
_KINDS = {
    "BUDGET": r"\b(?:or[cç]amento|budget|verba|teto)\b",
    "PROPOSAL": r"\b(?:proposta|proposal|cota[cç][aã]o|quotation|quote)\b",
    "PRICE": r"\b(?:pre[cç]o|price|mensalidade|custo|cost|investimento|investment|valor)\b",
    "REVENUE": r"\b(?:faturamento|receita|revenue|turnover)\b",
    "OTHER": r"R\$|US\$|[$€£]|\b(?:BRL|USD|EUR|GBP|reais|dollars|euros|pounds)\b",
}
_CURRENCIES = {
    "BRL": r"R\$|\b(?:BRL|reais|real)\b",
    "USD": r"US\$|\b(?:USD|dollars?|d[oó]lares?)\b",
    "EUR": r"€|\b(?:EUR|euros?)\b",
    "GBP": r"£|\b(?:GBP|pounds?)\b",
}
_EXPLICIT_CURRENCIES = {
    "BRL": r"R\$|\bBRL\b",
    "USD": r"US\$|\bUSD\b",
    "EUR": r"€|\bEUR\b",
    "GBP": r"£|\bGBP\b",
}


def normalize_quote(text: str) -> str:
    return " ".join(text.split())


def is_product_placeholder(name: str) -> bool:
    return _PRODUCT_PLACEHOLDER.search(name) is not None


def _contains(quote: str, value: str) -> bool:
    return (
        re.search(r"(?<!\w)" + re.escape(normalize_quote(value)) + r"(?!\w)", quote, re.I)
        is not None
    )


def _persona_supported(item: CommercialPersona, quote: str) -> bool:
    if item.speaker is not None and (
        not _SPEAKER.fullmatch(item.speaker) or not _contains(quote, item.speaker)
    ):
        return False
    if item.role is not None and (not item.role.strip() or not _contains(quote, item.role)):
        return False
    return bool(item.speaker or item.role or item.decision_role != DecisionRole.UNKNOWN)


def _safe_persona_attribution(item: CommercialPersona, quote: str) -> CommercialPersona:
    if item.speaker is None or item.role is None:
        return item
    speaker_key = re.sub(r"[\[\]\s_#-]", "", item.speaker).casefold()
    turns = list(_TURN.finditer(quote))
    self_declaration = re.compile(
        r"(?:^|[.!?;]\s+)(?:(?:eu\s+)?sou|i\s+am|i['\u2019]m)\s+"
        r"(?:(?:o|a|um|uma|the|an)\s+)?" + re.escape(normalize_quote(item.role)) + r"(?!\w)",
        re.I,
    )
    for index, turn in enumerate(turns):
        turn_key = re.sub(r"[\[\]\s_#-]", "", turn["label"]).casefold()
        if turn_key != speaker_key:
            continue
        end = turns[index + 1].start() if index + 1 < len(turns) else len(quote)
        own_words = quote[turn.end() : end].strip()
        if self_declaration.search(own_words):
            return item
    return item.model_copy(update={"speaker": None, "decision_role": DecisionRole.UNKNOWN})


def quoted_amounts(
    quote: str, language: str, *, precision: Literal["exact", "qualified", "all"] = "exact"
) -> set[Decimal]:
    amounts = (
        written_monetary_amounts(quote, precision=precision)
        if language.lower().startswith("pt")
        else set()
    )
    for match in _NUMBER.finditer(quote):
        before, after = quote[: match.start()], quote[match.end() :]
        qualified = monetary_amount_is_qualified(before, after)
        if before and (before[-1].isalnum() or before[-1] == "_") and not qualified:
            continue
        if re.search(r"\b(?:NPS|nota|score)\s*(?:[=:]|[eé])?\s*$", before, re.I) or re.match(
            r"\s*(?:%|por\s+cento\b|percent\b|funcion[aá]rios\b|employees\b|pessoas\b|people\b)",
            after,
            re.I,
        ):
            continue
        if (precision == "exact" and qualified) or (precision == "qualified" and not qualified):
            continue
        number = match["number"]
        if language.lower().startswith("pt"):
            number = number.replace(".", "").replace(",", ".")
        else:
            number = number.replace(",", "")
        if number.count(".") > 1:
            continue
        amount = Decimal(number)
        scale = (match["scale"] or "").lower()
        if scale.startswith(("milh", "million")):
            amount *= 1_000_000
        elif scale:
            amount *= 1000
        amounts.add(amount)
    return amounts


def _safe_budget_amount(item: CommercialBudget, quote: str, language: str) -> CommercialBudget:
    if item.amount is None:
        return item
    amount = Decimal(str(item.amount))
    if amount not in quoted_amounts(quote, language, precision="qualified"):
        return item
    # The same number can be an approximate price and an exact approved budget. Keep
    # those occurrences separate rather than letting a set of values prove both facts.
    kinds = "|".join(
        f"(?P<{kind}>{pattern})" for kind, pattern in _KINDS.items() if kind != "OTHER"
    )
    exact_for_kind = False
    for sentence in re.split(r"(?<=[.!?;])\s+", quote):
        cues = list(re.finditer(kinds, sentence, re.I))
        for index, cue in enumerate(cues):
            if cue.lastgroup != item.kind.value:
                continue
            end = cues[index + 1].start() if index + 1 < len(cues) else len(sentence)
            local = sentence[cue.start() : end]
            if amount in quoted_amounts(local, language, precision="qualified"):
                return item.model_copy(update={"amount": None})
            exact_for_kind |= amount in quoted_amounts(local, language)
    return item if exact_for_kind else item.model_copy(update={"amount": None})


def _budget_supported(item: CommercialBudget, quote: str, language: str) -> bool:
    if not re.search(_KINDS[item.kind.value], quote, re.I):
        return False
    if item.amount is not None and Decimal(str(item.amount)) not in quoted_amounts(quote, language):
        return False
    if item.currency is not None and not re.search(
        _CURRENCIES.get(item.currency, rf"\b{re.escape(item.currency)}\b"), quote, re.I
    ):
        return False
    return item.period is None or (bool(item.period.strip()) and _contains(quote, item.period))


def ground_commercial_intelligence(
    intelligence: CommercialIntelligence | None, transcript: str, language: str
) -> tuple[CommercialIntelligence | None, int, int]:
    if intelligence is None:
        return None, 0, 0
    source = normalize_quote(transcript)
    accepted, rejected = 0, 0
    retained: dict[str, list] = {}
    for field in ("products", "personas", "budgets", "sentiment_by_topic"):
        retained[field] = []
        for item in getattr(intelligence, field):
            quote = normalize_quote(item.source_quote)
            supported = bool(quote) and quote in source
            if field == "products":
                supported = (
                    supported
                    and bool(item.name.strip())
                    and not is_product_placeholder(item.name)
                    and _contains(quote, item.name)
                )
            elif field == "personas":
                supported = supported and _persona_supported(item, quote)
                if supported:
                    item = _safe_persona_attribution(item, quote)
            elif field == "budgets":
                item = _safe_budget_amount(item, quote, language)
                supported = supported and _budget_supported(item, quote, language)
                if supported and item.currency is None:
                    currencies = {
                        code
                        for code, pattern in _EXPLICIT_CURRENCIES.items()
                        if re.search(pattern, quote, re.I)
                    }
                    if len(currencies) == 1:
                        item = item.model_copy(update={"currency": currencies.pop()})
            if supported:
                retained[field].append(item)
                accepted += 1
            else:
                rejected += 1
    return intelligence.model_copy(update=retained), accepted, rejected
