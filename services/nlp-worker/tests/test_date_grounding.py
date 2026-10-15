from datetime import date

import pytest

from nora_nlp.services.date_grounding import contains_explicit_date


@pytest.mark.parametrize(
    ("text", "language", "expected"),
    [
        ("Entregar em 2026-10-16.", "pt-BR", True),
        ("Entregar em 16/10/2026.", "pt-BR", True),
        ("Entregar em 16 de outubro de 2026.", "pt-BR", True),
        ("Deliver by October 16, 2026.", "en-US", True),
        ("Deliver by 10/16/2026.", "en-US", True),
        ("Deliver by 16/10/2026.", "en-GB", True),
        ("Entregar el 16 de octubre de 2026.", "es", True),
        ("Entregar sexta-feira.", "pt-BR", False),
        ("Entregar em 16/10.", "pt-BR", False),
        ("Entregar em 16 de outubro.", "pt-BR", False),
        ("Entregar em 2023-10-16.", "pt-BR", False),
        ("Deliver by 10/16/2026.", "pt-BR", False),
    ],
)
def test_date_requires_an_explicit_day_month_and_year(text, language, expected):
    assert contains_explicit_date(text, date(2026, 10, 16), language) is expected


@pytest.mark.parametrize(
    ("text", "value"),
    [
        ("Até quinze de outubro de dois mil e vinte e seis.", date(2026, 10, 15)),
        ("Até dezesseis de outubro de 2026.", date(2026, 10, 16)),
        ("Até vinte de outubro de dois mil e vinte e seis.", date(2026, 10, 20)),
        ("Até vinte e um de outubro de dois mil e vinte e seis.", date(2026, 10, 21)),
        ("Até trinta e um de maio de dois mil e vinte e seis.", date(2026, 5, 31)),
        ("Até primeiro de janeiro de dois mil.", date(2000, 1, 1)),
        ("Até quatorze de março de dois mil vinte e seis.", date(2026, 3, 14)),
        ("Até catorze de março de 2026.", date(2026, 3, 14)),
        ("Até 16 de outubro de dois mil e vinte e seis.", date(2026, 10, 16)),
        ("Até dezasseis de outubro de dois mil e noventa e nove.", date(2099, 10, 16)),
    ],
)
def test_absolute_portuguese_dates_survive_speech_transcription(text, value):
    assert contains_explicit_date(text, value, "pt-BR")


@pytest.mark.parametrize(
    "text",
    [
        "Até quinze de outubro de dois mil e vinte e seis.",
        "Até dezesseis de outubro de dois mil e vinte e cinco.",
        "Até dezesseis de outubro.",
        "Até dezesseis de outubro, por quatro mil e duzentos reais.",
        "Orçamento de dois mil e vinte e seis reais. Dezesseis revisões em outubro.",
        "Até sexta-feira, dia dezesseis.",
    ],
)
def test_spoken_dates_do_not_infer_missing_or_mismatched_values(text):
    assert not contains_explicit_date(text, date(2026, 10, 16), "pt-BR")


@pytest.mark.parametrize("year", [2000, 2020, 2021, 2025, 2027])
def test_spoken_year_is_not_matched_as_a_shorter_prefix(year):
    assert not contains_explicit_date(
        "Até dezesseis de outubro de dois mil e vinte e seis.", date(year, 10, 16), "pt-BR"
    )
