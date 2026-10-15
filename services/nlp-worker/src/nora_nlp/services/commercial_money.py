"""Exact pt-BR written numerals next to explicit monetary units, without estimation."""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal
from typing import Literal

_VALUES = {
    "zero": 0,
    "um": 1,
    "uma": 1,
    "dois": 2,
    "duas": 2,
    "tres": 3,
    "quatro": 4,
    "cinco": 5,
    "seis": 6,
    "sete": 7,
    "oito": 8,
    "nove": 9,
    "dez": 10,
    "onze": 11,
    "doze": 12,
    "treze": 13,
    "catorze": 14,
    "quatorze": 14,
    "quinze": 15,
    "dezesseis": 16,
    "dezessete": 17,
    "dezoito": 18,
    "dezenove": 19,
    "vinte": 20,
    "trinta": 30,
    "quarenta": 40,
    "cinquenta": 50,
    "sessenta": 60,
    "setenta": 70,
    "oitenta": 80,
    "noventa": 90,
    "cem": 100,
    "cento": 100,
    "duzentos": 200,
    "duzentas": 200,
    "trezentos": 300,
    "trezentas": 300,
    "quatrocentos": 400,
    "quatrocentas": 400,
    "quinhentos": 500,
    "quinhentas": 500,
    "seiscentos": 600,
    "seiscentas": 600,
    "setecentos": 700,
    "setecentas": 700,
    "oitocentos": 800,
    "oitocentas": 800,
    "novecentos": 900,
    "novecentas": 900,
}
_SCALES = {
    "mil": 1000,
    "milhao": 1000000,
    "milhoes": 1000000,
    "bilhao": 1000000000,
    "bilhoes": 1000000000,
}
_ATOM = "(?:" + "|".join(sorted(_VALUES.keys() | _SCALES.keys(), key=len, reverse=True)) + ")"
_PHRASE = _ATOM + r"(?:\s+(?:e\s+)?" + _ATOM + ")*"
_MONEY = re.compile(
    r"(?<!\w)(?P<whole>"
    + _PHRASE
    + r")\s+(?P<unit>reais|real|dolar(?:es)?|euros?|libras?|centavos?)"
    r"\b(?:\s+e\s+(?P<cents>" + _PHRASE + r")\s+centavos?\b)?",
    re.I,
)
_PREFIXED_MONEY = re.compile(r"(?:\b(?:BRL|USD|EUR|GBP)|R\$|US\$)\s*(" + _PHRASE + r")(?!\w)", re.I)
_QUALIFIED_PREFIX = re.compile(
    r"\b(?:cerca\s+de|aproximadamente|uns|umas|mais\s+de|menos\s+de|por\s+volta\s+de|"
    r"em\s+torno\s+de|ate|quase|pelo\s+menos|no\s+minimo|no\s+maximo|acima\s+de|"
    r"abaixo\s+de|passa\s+d[eo]s?|ultrapassa|nao\s+(?:dava|da|chega|chegava)\s+(?:nem|a)|"
    r"about|approximately|around|over|under|more\s+than|less\s+than|up\s+to|"
    r"at\s+least|at\s+most)\s*(?:(?:BRL|USD|EUR|GBP|R\$|US\$|€|£)\s*)?$",
    re.I,
)
_QUALIFIED_SUFFIX = re.compile(
    r"\s*(?:(?:reais|real|dolares?|dollars?|euros?|pounds?|libras?|BRL|USD|EUR|GBP)\b\s*)?"
    r"(?:ou\s+mais|ou\s+menos|aproximadamente|no\s+maximo|no\s+minimo|or\s+more|"
    r"or\s+less|approximately)\b",
    re.I,
)


def _plain(text: str) -> str:
    return "".join(
        char
        for char in unicodedata.normalize("NFKD", text.lower())
        if not unicodedata.combining(char)
    )


def monetary_amount_is_qualified(before: str, after: str) -> bool:
    return bool(_QUALIFIED_PREFIX.search(_plain(before)) or _QUALIFIED_SUFFIX.match(_plain(after)))


def _under_thousand(words: list[str]) -> int | None:
    if len(words) == 1:
        return _VALUES.get(words[0])
    if len(words) < 3 or words[1] != "e":
        return None
    first = _VALUES.get(words[0], -1)
    rest = _under_thousand(words[2:])
    if rest is None:
        return None
    if 20 <= first <= 90 and 1 <= rest <= 9:
        return first + rest
    if first >= 100 and words[0] != "cem" and 1 <= rest <= 99:
        return first + rest
    return None


def _integer(text: str) -> int | None:
    total, previous_scale = 0, 10**12
    group: list[str] = []
    for word in text.split():
        if word not in _SCALES:
            if word == "e" and not group:
                continue
            group.append(word)
            continue
        scale = _SCALES[word]
        value = _under_thousand(group) if group else 1
        if value is None or value == 0 or scale >= previous_scale:
            return None
        total += value * scale
        previous_scale, group = scale, []
    remainder = _under_thousand(group) if group else 0
    return None if remainder is None else total + remainder


def written_monetary_amounts(
    quote: str, *, precision: Literal["exact", "qualified", "all"] = "exact"
) -> set[Decimal]:
    text = _plain(quote)
    amounts: set[Decimal] = set()
    for match in _MONEY.finditer(text):
        qualified = monetary_amount_is_qualified(text[: match.start()], text[match.end() :])
        if (precision == "exact" and qualified) or (precision == "qualified" and not qualified):
            continue
        whole = _integer(match["whole"])
        cents = _integer(match["cents"]) if match["cents"] else 0
        if whole is None or cents is None or cents > 99:
            continue
        amount = Decimal(whole)
        if match["unit"].startswith("centavo"):
            amount /= 100
        else:
            amount += Decimal(cents) / 100
        amounts.add(amount)
    for match in _PREFIXED_MONEY.finditer(text):
        qualified = monetary_amount_is_qualified(text[: match.start()], text[match.end() :])
        if (precision == "exact" and qualified) or (precision == "qualified" and not qualified):
            continue
        value = _integer(match[1])
        if value is not None:
            amounts.add(Decimal(value))
    return amounts
