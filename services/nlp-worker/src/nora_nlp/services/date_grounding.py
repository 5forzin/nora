"""Keep absolute deadlines only when the source explicitly supports them."""

from __future__ import annotations

import re
import unicodedata
from datetime import date

_MONTHS = (
    "janeiro january enero",
    "fevereiro february febrero",
    "marco march marzo",
    "abril april",
    "maio may mayo",
    "junho june junio",
    "julho july julio",
    "agosto august",
    "setembro september septiembre",
    "outubro october octubre",
    "novembro november noviembre",
    "dezembro december diciembre",
)

_PT_NUMBERS = (
    "zero",
    "um|primeiro",
    "dois",
    "tres",
    "quatro",
    "cinco",
    "seis",
    "sete",
    "oito",
    "nove",
    "dez",
    "onze",
    "doze",
    "treze",
    "quatorze|catorze",
    "quinze",
    "dezesseis|dezasseis",
    "dezessete|dezassete",
    "dezoito",
    "dezenove|dezanove",
)
_PT_TENS = (
    "",
    "",
    "vinte",
    "trinta",
    "quarenta",
    "cinquenta",
    "sessenta",
    "setenta",
    "oitenta",
    "noventa",
)


def _portuguese_number_pattern(value: int) -> str:
    if value < 20:
        return rf"(?:{_PT_NUMBERS[value]})"
    tens, units = divmod(value, 10)
    return _PT_TENS[tens] + (rf"\s+e\s+(?:{_PT_NUMBERS[units]})" if units else "")


def contains_explicit_date(text: str, value: date, language: str) -> bool:
    """Do not infer a year or resolve relative dates without a meeting date."""
    text = "".join(
        char
        for char in unicodedata.normalize("NFKD", text.casefold())
        if not unicodedata.combining(char)
    )
    day, month, year = value.day, value.month, value.year
    first, second = (month, day) if language.lower() == "en-us" else (day, month)
    months = "|".join(_MONTHS[month - 1].split())
    patterns = [
        rf"{year}-0?{month}-0?{day}",
        rf"0?{first}(?P<separator>[/.-])0?{second}(?P=separator){year}",
        rf"0?{day}(?:st|nd|rd|th)?\s+(?:de\s+)?(?:{months})\s+(?:de\s+)?{year}",
        rf"(?:{months})\s+0?{day}(?:st|nd|rd|th)?,?\s+{year}",
    ]
    if language.lower().startswith("pt"):
        day_words = _portuguese_number_pattern(day)
        year_pattern = str(year)
        if 2000 <= year < 2100:
            suffix = (
                rf"(?:\s+e)?\s+{_portuguese_number_pattern(year - 2000)}" if year > 2000 else ""
            )
            number_starts = "|".join((*_PT_NUMBERS, *_PT_TENS[2:]))
            spoken_year = rf"dois\s+mil{suffix}(?!\s+(?:e\s+)?(?:{number_starts})(?!\w))"
            year_pattern = rf"(?:{year}|{spoken_year})"
        patterns.append(rf"(?:0?{day}|{day_words})\s+de\s+(?:{months})\s+de\s+{year_pattern}")
    return any(re.search(rf"(?<!\w){pattern}(?!\w)", text) for pattern in patterns)
