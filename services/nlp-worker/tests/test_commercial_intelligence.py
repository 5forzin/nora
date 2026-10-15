from __future__ import annotations

import json
import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from nora_nlp.clients.llm import LlmClient, build_json_schema_for_analysis
from nora_nlp.main import app
from nora_nlp.models import AnalyzeRequest, CommercialIntelligence, MeetingAnalysisV1
from nora_nlp.services import llm_analyzer, stub_analyzer
from nora_nlp.services.commercial_grounding import (
    ground_commercial_intelligence,
    normalize_quote,
    quoted_amounts,
)
from nora_nlp.services.commercial_money import written_monetary_amounts
from nora_nlp.settings import Settings


def _request(transcript: str, *, enabled: bool = True) -> AnalyzeRequest:
    return AnalyzeRequest(
        meetingId="commercial-fixture",
        tenantId="00000000-0000-4000-8000-000000000001",
        language="pt-BR",
        transcript=transcript,
        tenantContext={
            "companyName": "ACME",
            "valueProposition": "Business software",
            "products": [{"name": "ERP"}],
            "competitors": ["AlternativeCRM"],
        },
        options={"includeCustomerConfidence": enabled},
    )


def _payload(commercial: dict | None = None) -> dict:
    return {
        "summary": "We discussed the current software and the next commercial steps.",
        "decisions": [],
        "actionItems": [],
        "risks": [],
        "opportunities": [],
        "sentimentOverall": "NEUTRAL",
        "topics": [],
        "participants": [],
        "productivity": None,
        "customerConfidence": None,
        "commercialIntelligence": (
            {"products": [], "personas": [], "budgets": [], "sentimentByTopic": [], **commercial}
            if commercial is not None
            else None
        ),
    }


def _commercial(**fields) -> CommercialIntelligence:
    return CommercialIntelligence.model_validate(fields)


def test_quote_grounding_preserves_evidence_and_discards_paraphrases():
    source = "LOCUTOR_01: Usamos\tERP no financeiro.\r\nA migração precisa melhorar."
    valid = {"name": "ERP", "relationship": "CURRENT", "sourceQuote": "Usamos ERP no financeiro."}
    invented = {**valid, "sourceQuote": "O cliente utiliza ERP no financeiro."}
    absent_name = {**valid, "name": "DifferentProduct"}
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(products=[valid, invented, absent_name]), source, "pt-BR"
    )
    assert intelligence is not None
    assert [item.model_dump(by_alias=True) for item in intelligence.products] == [valid]
    assert (accepted, rejected) == (1, 2)


@pytest.mark.parametrize(
    "speaker",
    ["LOCUTOR_01", "Speaker 2", "[LOCUTOR 23]", "[SPEAKER_2]", "[[PERSON_NAME_9]]"],
)
def test_personas_keep_only_literal_anonymous_speakers_and_roles(speaker):
    quote = f"{speaker}: Sou diretor financeiro e aprovo o investimento."
    persona = {
        "speaker": speaker,
        "role": "diretor financeiro",
        "decisionRole": "DECISION_MAKER",
        "sourceQuote": quote,
    }
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(personas=[persona]), quote, "pt-BR"
    )
    assert intelligence is not None and intelligence.personas[0].speaker == speaker
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "change",
    [
        {"speaker": "Maria da Silva"},
        {"speaker": "LOCUTOR_02"},
        {"speaker": "LOCUTOR_0"},
        {"role": "CEO"},
    ],
)
def test_personas_do_not_reconstruct_identity_or_assign_unquoted_roles(change):
    quote = "LOCUTOR_01: Sou diretor financeiro."
    persona = {
        "speaker": "LOCUTOR_01",
        "role": "diretor financeiro",
        "decisionRole": "UNKNOWN",
        "sourceQuote": quote,
        **change,
    }
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(personas=[persona]), quote, "pt-BR"
    )
    assert intelligence is not None and intelligence.personas == []
    assert (accepted, rejected) == (0, 1)


@pytest.mark.parametrize(
    "speaker",
    [
        "[LOCUTOR 23",
        "LOCUTOR 23]",
        "[[LOCUTOR 23]]",
        "[SPEAKER_2",
        "SPEAKER_2]",
        "[SPEAKER]",
        "[LOCUTOR A]",
        "[Maria da Silva]",
        "Maria da Silva",
        "[LOCUTOR 23]:",
    ],
)
def test_personas_reject_malformed_or_named_labels_even_when_the_quote_contains_them(speaker):
    quote = f"{speaker}: Sou diretor financeiro."
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            personas=[
                {
                    "speaker": speaker,
                    "role": "diretor financeiro",
                    "decisionRole": "UNKNOWN",
                    "sourceQuote": quote,
                }
            ]
        ),
        quote,
        "pt-BR",
    )
    assert intelligence is not None and intelligence.personas == []
    assert (accepted, rejected) == (0, 1)


def test_unknown_persona_fields_remain_null_without_inventing_identity():
    quote = "LOCUTOR_01: Vou usar o sistema diariamente."
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(personas=[{"decisionRole": "USER", "sourceQuote": quote}]), quote, "pt-BR"
    )
    assert intelligence is not None
    assert intelligence.personas[0].speaker is None
    assert intelligence.personas[0].role is None
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "role,words",
    [
        ("diretor financeiro", "Sou diretor financeiro. Aprovo a verba de R$ 50000."),
        ("diretor financeiro", "Eu sou o diretor financeiro. Aprovo a verba."),
        ("finance director", "I am the finance director. I approve the budget."),
        ("finance director", "I'm a finance director. I approve the budget."),
    ],
)
def test_explicit_self_declarations_keep_the_role_speaker_and_authority(role, words):
    quote = f"[LOCUTOR 1]: {words}"
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            personas=[
                {
                    "speaker": "LOCUTOR 1",
                    "role": role,
                    "decisionRole": "DECISION_MAKER",
                    "sourceQuote": quote,
                }
            ]
        ),
        quote,
        "pt-BR",
    )
    assert result is not None
    assert result.personas[0].speaker == "LOCUTOR 1"
    assert result.personas[0].role == role
    assert result.personas[0].decision_role.value == "DECISION_MAKER"
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "words",
    [
        "A executiva responsável é a [[PERSON_NAME_1]].",
        "A [[PERSON_NAME_1]] disse: Sou executiva responsável.",
        "'Sou executiva responsável', disse [[PERSON_NAME_1]].",
    ],
)
def test_a_third_partys_role_remains_unattributed_without_transferring_authority(words):
    quote = "[LOCUTOR 62]: " + words
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            personas=[
                {
                    "speaker": "LOCUTOR 62",
                    "role": "executiva responsável",
                    "decisionRole": "INFLUENCER",
                    "sourceQuote": quote,
                }
            ]
        ),
        quote,
        "pt-BR",
    )
    assert result is not None
    assert result.personas[0].speaker is None
    assert result.personas[0].role == "executiva responsável"
    assert result.personas[0].decision_role.value == "UNKNOWN"
    assert result.personas[0].source_quote == quote
    assert (accepted, rejected) == (1, 0)


def test_a_nested_speaker_label_cannot_assign_someone_elses_self_declaration():
    quote = "[LOCUTOR 67]: [LOCUTOR 52]: Sou especialista em nuvem."
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            personas=[
                {
                    "speaker": "LOCUTOR 67",
                    "role": "especialista em nuvem",
                    "decisionRole": "DECISION_MAKER",
                    "sourceQuote": quote,
                }
            ]
        ),
        quote,
        "pt-BR",
    )
    assert result is not None
    assert result.personas[0].speaker is None
    assert result.personas[0].role == "especialista em nuvem"
    assert result.personas[0].decision_role.value == "UNKNOWN"
    assert (accepted, rejected) == (1, 0)


def test_own_turn_self_declaration_is_preserved_among_other_speakers_and_financial_facts():
    quote = (
        "LOCUTOR_0: A receita é R$ 2000000 e o NPS é 80. "
        "LOCUTOR_1: Sou diretor financeiro. Aprovo o orçamento de R$ 50000 para a aquisição. "
        "LOCUTOR_0: Precisamos da proposta."
    )
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            personas=[
                {
                    "speaker": "LOCUTOR_1",
                    "role": "diretor financeiro",
                    "decisionRole": "DECISION_MAKER",
                    "sourceQuote": quote,
                }
            ],
            budgets=[
                {
                    "amount": 50000,
                    "currency": None,
                    "kind": "BUDGET",
                    "approval": "APPROVED",
                    "sourceQuote": quote,
                }
            ],
        ),
        quote,
        "pt-BR",
    )
    assert result is not None
    assert result.personas[0].speaker == "LOCUTOR_1"
    assert result.personas[0].decision_role.value == "DECISION_MAKER"
    assert result.budgets[0].amount == 50000
    assert result.budgets[0].currency == "BRL"
    assert result.budgets[0].kind.value == "BUDGET"
    assert result.budgets[0].approval.value == "APPROVED"
    assert (accepted, rejected) == (2, 0)


def test_unknown_role_keeps_a_literal_speaker_without_inventing_a_job():
    quote = "[LOCUTOR 3]: Vamos começar a conversa."
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            personas=[
                {
                    "speaker": "[LOCUTOR 3]",
                    "role": None,
                    "decisionRole": "UNKNOWN",
                    "sourceQuote": quote,
                }
            ]
        ),
        quote,
        "pt-BR",
    )
    assert result is not None
    assert result.personas[0].speaker == "[LOCUTOR 3]"
    assert result.personas[0].role is None
    assert result.personas[0].decision_role.value == "UNKNOWN"
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "quote,amount,currency,kind,period",
    [
        ("O orçamento aprovado é R$ 150 mil por ano.", 150000, "BRL", "BUDGET", "por ano"),
        ("A proposta é de R$ 1.234,56.", 1234.56, "BRL", "PROPOSAL", None),
        ("Nosso faturamento é R$ 2,5 milhões ao ano.", 2500000, "BRL", "REVENUE", "ao ano"),
        ("Ainda não definimos o orçamento.", None, None, "BUDGET", None),
    ],
)
def test_money_keeps_its_kind_currency_scale_and_literal_period(
    quote, amount, currency, kind, period
):
    item = {
        "amount": amount,
        "currency": currency,
        "kind": kind,
        "period": period,
        "approval": "UNKNOWN",
        "sourceQuote": quote,
    }
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(budgets=[item]), quote, "pt-BR"
    )
    assert intelligence is not None and intelligence.budgets[0].amount == amount
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "quote,change",
    [
        ("Nosso NPS é 80 e temos 300 funcionários.", {"amount": 80}),
        ("O orçamento não foi definido. Nosso NPS é 80.", {"amount": 80}),
        ("O orçamento não foi definido. Temos 300 funcionários.", {"amount": 300}),
        ("O orçamento não foi definido. A margem é 20%.", {"amount": 20}),
        ("Nosso faturamento é R$ 2 milhões.", {"amount": 2000000}),
        ("O orçamento é R$ 150 mil.", {"amount": 170000}),
        ("O orçamento é 150 mil.", {"amount": 150000, "currency": "USD"}),
        ("O orçamento é R$ 150 mil por ano.", {"amount": 150000, "period": "por mês"}),
    ],
)
def test_money_rejects_invented_amounts_and_does_not_turn_revenue_or_nps_into_budget(quote, change):
    item = {
        "amount": None,
        "currency": None,
        "period": None,
        "kind": "BUDGET",
        "approval": "UNKNOWN",
        "sourceQuote": quote,
        **change,
    }
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(budgets=[item]), quote, "pt-BR"
    )
    assert intelligence is not None and intelligence.budgets == []
    assert (accepted, rejected) == (0, 1)


def test_english_monetary_separators_and_scaling():
    assert 1234.56 in {float(amount) for amount in quoted_amounts("Price: USD 1,234.56", "en")}
    assert 2000000 in quoted_amounts("Revenue: 2 million dollars", "en")


@pytest.mark.parametrize(
    "quote,amount,kind,language",
    [
        ("O custo não dava nem mil reais por mês.", 1000, "PRICE", "pt-BR"),
        ("Nossa receita é mais de10milhões ao ano.", 10000000, "REVENUE", "pt-BR"),
        ("O orçamento chega até50mil reais.", 50000, "BUDGET", "pt-BR"),
        ("O preço é cerca de20mil reais.", 20000, "PRICE", "pt-BR"),
        ("O custo é aproximadamente R$20000.", 20000, "PRICE", "pt-BR"),
        ("O custo é vinte mil reais aproximadamente.", 20000, "PRICE", "pt-BR"),
        ("O custo passa de R$1000.", 1000, "PRICE", "pt-BR"),
        ("O custo é mil reais ou menos.", 1000, "PRICE", "pt-BR"),
        ("The price is under USD 1000.", 1000, "PRICE", "en"),
        ("Revenue is more than 10 million dollars.", 10000000, "REVENUE", "en"),
    ],
)
def test_qualified_amounts_become_unknown_without_discarding_the_monetary_fact(
    quote, amount, kind, language
):
    original = _commercial(
        budgets=[{"amount": amount, "kind": kind, "approval": "NOT_APPROVED", "sourceQuote": quote}]
    )
    result, accepted, rejected = ground_commercial_intelligence(original, quote, language)
    assert result.budgets[0].amount is None
    assert result.budgets[0].kind.value == kind
    assert result.budgets[0].approval.value == "NOT_APPROVED"
    assert result.budgets[0].source_quote == quote
    assert original.budgets[0].amount == amount
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "qualified",
    [
        "Nossa receita passa de10milhões.",
        "O custo não dava nem mil reais por mês.",
        "O preço era cerca de vinte mil reais.",
        "O investimento seria até50mil.",
    ],
)
def test_qualified_values_do_not_erase_an_independent_exact_amount_in_the_same_quote(qualified):
    quote = qualified + " Aprovo orçamento de R$50000. O preço antigo era quatro mil reais."
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            budgets=[
                {"amount": 50000, "kind": "BUDGET", "approval": "APPROVED", "sourceQuote": quote},
                {"amount": 4000, "kind": "PRICE", "approval": "UNKNOWN", "sourceQuote": quote},
            ]
        ),
        quote,
        "pt-BR",
    )
    assert [item.amount for item in result.budgets] == [50000, 4000]
    assert result.budgets[0].approval.value == "APPROVED"
    assert (accepted, rejected) == (2, 0)


@pytest.mark.parametrize(
    "quote",
    [
        "O preço antigo era menos de R$1000. Aprovo orçamento de R$1000.",
        "O preço antigo não dava nem mil reais por mês. Aprovo orçamento de R$1000.",
        "O preço antigo era menos de R$1000, e o orçamento aprovado é R$1000.",
    ],
)
def test_an_equal_exact_neighbor_of_another_kind_does_not_prove_the_qualified_amount(quote):
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            budgets=[
                {"amount": 1000, "kind": "PRICE", "approval": "UNKNOWN", "sourceQuote": quote},
                {"amount": 1000, "kind": "BUDGET", "approval": "APPROVED", "sourceQuote": quote},
            ]
        ),
        quote,
        "pt-BR",
    )
    assert [item.amount for item in result.budgets] == [None, 1000]
    assert [item.approval.value for item in result.budgets] == ["UNKNOWN", "APPROVED"]
    assert (accepted, rejected) == (2, 0)


@pytest.mark.parametrize(
    "marker,currency",
    [
        ("R$", "BRL"),
        ("US$", "USD"),
        ("€", "EUR"),
        ("£", "GBP"),
        ("BRL", "BRL"),
        ("USD", "USD"),
        ("EUR", "EUR"),
        ("GBP", "GBP"),
        ("R$ (BRL)", "BRL"),
    ],
)
def test_missing_currency_is_restored_only_from_one_explicit_symbol_or_iso_code(marker, currency):
    quote = f"O preço é {marker} 50000."
    original = _commercial(
        budgets=[
            {
                "amount": 50000,
                "currency": None,
                "kind": "PRICE",
                "approval": "UNKNOWN",
                "sourceQuote": quote,
            }
        ]
    )
    result, accepted, rejected = ground_commercial_intelligence(original, quote, "pt-BR")
    assert result is not None
    assert result.budgets[0].currency == currency
    assert result.budgets[0].amount == 50000
    assert result.budgets[0].kind.value == "PRICE"
    assert result.budgets[0].approval.value == "UNKNOWN"
    assert original.budgets[0].currency is None
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "quote",
    [
        "O preço é 50000.",
        "O preço real é 50000.",
        "O preço é 50000 reais.",
        "O preço é $ 50000.",
        "O preço é R$ 50000 ou USD 10000.",
        "O preço é EUR 50000 ou £ 40000.",
    ],
)
def test_missing_or_ambiguous_currency_remains_unknown(quote):
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            budgets=[
                {
                    "amount": 50000,
                    "currency": None,
                    "kind": "PRICE",
                    "approval": "UNKNOWN",
                    "sourceQuote": quote,
                }
            ]
        ),
        quote,
        "pt-BR",
    )
    assert result is not None and result.budgets[0].currency is None
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "phrase,amount",
    [
        ("quatro mil reais por mês", 4000),
        ("dois milhões e quinhentos mil reais", 2500000),
        ("cento e vinte e três reais e cinquenta centavos", 123.50),
        ("cinquenta centavos", 0.50),
        ("mil e vinte e cinco reais", 1025),
        ("duzentas e trinta e duas libras", 232),
        ("BRL quatro mil", 4000),
        ("R$ quatro mil", 4000),
        ("um dólar", 1),
        ("zero reais", 0),
    ],
)
def test_explicit_pt_br_written_money_is_grounded_without_estimation(phrase, amount):
    assert amount in {float(value) for value in written_monetary_amounts(phrase)}
    quote = "O preço é " + phrase + "."
    result, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            budgets=[
                {"amount": amount, "kind": "PRICE", "approval": "UNKNOWN", "sourceQuote": quote}
            ]
        ),
        quote,
        "pt-BR",
    )
    assert result is not None and len(result.budgets) == 1
    assert (accepted, rejected) == (1, 0)


@pytest.mark.parametrize(
    "phrase",
    [
        "quatro mil funcionários",
        "NPS oitenta",
        "cem e vinte reais",
        "quatro cinco reais",
        "vinte e trinta reais",
        "dois mil milhões de reais",
        "um real e cento e cinquenta centavos",
        "cerca de quatro mil reais",
        "aproximadamente quatro mil reais",
        "cerca de BRL quatro mil reais",
    ],
)
def test_written_numbers_do_not_infer_money_from_metrics_or_invalid_or_approximate_amounts(phrase):
    assert written_monetary_amounts(phrase) == set()


def test_product_names_must_match_whole_terms_not_parts_of_another_product():
    quote = "Usamos SuperERP no financeiro."
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(products=[{"name": "ERP", "relationship": "CURRENT", "sourceQuote": quote}]),
        quote,
        "pt-BR",
    )
    assert intelligence is not None and intelligence.products == []
    assert (accepted, rejected) == (0, 1)


@pytest.mark.parametrize("name", ["[EMPRESA]", "[PESSOA]", "[[PERSON_NAME_2]]", "[[TYPE_n]]"])
def test_anonymized_placeholders_never_identify_a_product_even_when_quoted(name):
    quote = f"Estamos avaliando {name} para a próxima fase."
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(products=[{"name": name, "relationship": "MENTIONED", "sourceQuote": quote}]),
        quote,
        "pt-BR",
    )
    assert intelligence is not None and intelligence.products == []
    assert (accepted, rejected) == (0, 1)


def test_topic_sentiment_requires_its_own_literal_evidence():
    intelligence, accepted, rejected = ground_commercial_intelligence(
        _commercial(
            sentimentByTopic=[
                {
                    "topic": "Implementation",
                    "sentiment": "NEGATIVE",
                    "sourceQuote": "The rollout failed.",
                },
                {
                    "topic": "Price",
                    "sentiment": "POSITIVE",
                    "sourceQuote": "The price is excellent.",
                },
            ]
        ),
        "The rollout failed.",
        "en",
    )
    assert intelligence is not None and len(intelligence.sentiment_by_topic) == 1
    assert (accepted, rejected) == (1, 1)


@pytest.mark.parametrize("amount", [float("nan"), float("inf"), -1, True, "150000"])
def test_budget_amount_rejects_non_finite_negative_or_non_numeric_values(amount):
    with pytest.raises(ValidationError):
        _commercial(
            budgets=[
                {
                    "amount": amount,
                    "kind": "BUDGET",
                    "approval": "UNKNOWN",
                    "sourceQuote": "Budget: BRL 150000",
                }
            ]
        )


def test_older_analysis_payloads_still_validate_with_null_commercial_fields():
    payload = _payload()
    assert MeetingAnalysisV1.model_validate(payload).commercial_intelligence is None
    del payload["commercialIntelligence"]
    assert MeetingAnalysisV1.model_validate(payload).commercial_intelligence is None
    assert ground_commercial_intelligence(None, "A transcript", "en") == (None, 0, 0)


@pytest.mark.parametrize("fallback", [False, True])
def test_enabled_provider_requires_commercial_object_even_without_customer_confidence(fallback):
    payload = _payload({})
    raw = json.dumps(payload)
    client = MagicMock()
    client.chat_structured.return_value = (raw, 100, 50)
    client.chat_json.return_value = (raw, 100, 50)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured transport unavailable")
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
    ):
        response = llm_analyzer.analyze(
            _request("Alinhamento interno sobre o projeto."), Settings()
        )
    assert response.customer_confidence is None
    assert response.commercial_intelligence is not None
    assert (
        response.commercial_intelligence.model_dump(by_alias=True)
        == payload["commercialIntelligence"]
    )
    structured = client.chat_structured.call_args.kwargs
    schema = structured["json_schema"]
    assert next(iter(schema["properties"])) == "commercialIntelligence"
    assert schema["required"][0] == "commercialIntelligence"
    assert schema["properties"]["commercialIntelligence"] == {
        "$ref": "#/$defs/CommercialIntelligence"
    }
    assert set(schema["$defs"]["CommercialIntelligence"]["required"]) == {
        "products",
        "personas",
        "budgets",
        "sentimentByTopic",
    }
    assert "Never omit this object" in structured["system_prompt"]
    if fallback:
        assert client.chat_json.call_args.kwargs["system_prompt"] == structured["system_prompt"]


@pytest.mark.parametrize("fallback", [False, True])
def test_commercial_pipeline_keeps_current_system_role_and_historical_price_without_approval(
    fallback, caplog
):
    product_quote = "LOCUTOR_01: Usamos LedgerOne no financeiro."
    role_quote = "LOCUTOR_01: Sou diretor financeiro, mas a diretoria aprova os gastos."
    price_quote = "O preço antigo era quatro mil reais por mês."
    budget_quote = "Não temos orçamento aprovado para a aquisição."
    sentiment_quote = "O suporte do LedgerOne é péssimo."
    commercial = {
        "products": [
            {"name": "LedgerOne", "relationship": "CURRENT", "sourceQuote": product_quote},
            {
                "name": "InventedERP",
                "relationship": "OPPORTUNITY",
                "sourceQuote": "Precisamos contratar InventedERP.",
            },
        ],
        "personas": [
            {
                "speaker": "LOCUTOR_01",
                "role": "diretor financeiro",
                "decisionRole": "UNKNOWN",
                "sourceQuote": role_quote,
            }
        ],
        "budgets": [
            {
                "amount": 4000,
                "currency": "BRL",
                "kind": "PRICE",
                "approval": "UNKNOWN",
                "period": "por mês",
                "sourceQuote": price_quote,
            },
            {
                "amount": None,
                "currency": None,
                "kind": "BUDGET",
                "approval": "NOT_APPROVED",
                "period": None,
                "sourceQuote": budget_quote,
            },
        ],
        "sentimentByTopic": [
            {"topic": "Suporte", "sentiment": "NEGATIVE", "sourceQuote": sentiment_quote}
        ],
    }
    transcript = "\n".join((product_quote, role_quote, price_quote, budget_quote, sentiment_quote))
    raw = json.dumps(_payload(commercial))
    client = MagicMock()
    client.chat_structured.return_value = (raw, 100, 50)
    client.chat_json.return_value = (raw, 100, 50)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured transport unavailable")
    with (
        caplog.at_level("INFO"),
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
        patch.object(llm_analyzer, "verify_products", side_effect=lambda _, ci, *args: (ci, 0, 0)),
    ):
        response = llm_analyzer.analyze(_request(transcript), Settings())
    result = response.commercial_intelligence
    assert result is not None
    assert [(p.name, p.relationship.value) for p in result.products] == [("LedgerOne", "CURRENT")]
    assert result.personas[0].role == "diretor financeiro"
    assert result.personas[0].decision_role.value == "UNKNOWN"
    assert [(b.amount, b.kind.value, b.approval.value) for b in result.budgets] == [
        (4000, "PRICE", "UNKNOWN"),
        (None, "BUDGET", "NOT_APPROVED"),
    ]
    assert result.budgets[0].currency == "BRL"
    assert result.budgets[0].period == "por mês"
    assert result.sentiment_by_topic[0].sentiment.value == "NEGATIVE"
    assert response.customer_confidence is None
    assert response.metadata.commercial_items_accepted == 5
    assert response.metadata.commercial_items_rejected == 1
    assert "provider_items=6 accepted=5 rejected=1" in caplog.text
    for value in ("LedgerOne", "InventedERP", role_quote, price_quote):
        assert value not in caplog.text


@pytest.mark.parametrize(
    "commercial",
    [None, {}, {"products": [], "personas": [], "budgets": [], "sentimentByTopic": None}],
)
def test_missing_enterprise_extraction_retries_once_in_the_same_budget(commercial):
    invalid = _payload()
    invalid["commercialIntelligence"] = commercial
    valid = _payload({})
    client = MagicMock()
    client.chat_structured.return_value = (json.dumps(invalid), 100, 50)
    client.chat_json.return_value = (json.dumps(valid), 100, 50)
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client) as factory,
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
    ):
        response = llm_analyzer.analyze(_request("A equipe está discutindo o projeto."), Settings())
    assert response.commercial_intelligence is not None
    assert response.metadata.commercial_items_accepted == 0
    client.chat_structured.assert_called_once()
    client.chat_json.assert_called_once()
    assert factory.call_args.kwargs["budget"] is not None
    assert (
        client.chat_json.call_args.kwargs["system_prompt"]
        == (client.chat_structured.call_args.kwargs["system_prompt"])
    )


@pytest.mark.parametrize("missing", [False, True])
@pytest.mark.parametrize("fallback", [False, True])
def test_repeated_null_or_missing_enterprise_extraction_is_a_safe_bad_gateway(
    monkeypatch, caplog, missing, fallback
):
    monkeypatch.setenv("USE_LLM_STUB", "false")
    payload = _payload()
    if missing:
        del payload["commercialIntelligence"]
    payload["summary"] = "Wanderleia Kranz planted response that must never reach logs."
    raw = json.dumps(payload)
    client = MagicMock()
    client.chat_structured.return_value = (raw, 100, 50)
    client.chat_json.return_value = (raw, 100, 50)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured transport unavailable")
    with patch.object(llm_analyzer, "LlmClient", return_value=client):
        response = TestClient(app).post(
            "/analyze", json=_request("A equipe discute o projeto.").model_dump(by_alias=True)
        )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "LLM_RESPONSE_INVALID"
    assert "outside the analysis schema" in response.json()["detail"]["message"]
    assert "Wanderleia" not in caplog.text
    assert "Kranz" not in caplog.text
    client.chat_structured.assert_called_once()
    client.chat_json.assert_called_once()


def test_token_limited_response_is_rejected_even_when_its_json_is_complete():
    client = object.__new__(LlmClient)
    completion = SimpleNamespace(
        choices=[SimpleNamespace(finish_reason="length", message=SimpleNamespace(content="{}"))]
    )
    with pytest.raises(json.JSONDecodeError, match="exceeded its token limit"):
        client._extract(completion, mode="structured")


def test_repeated_output_truncation_returns_a_provider_response_error(monkeypatch):
    monkeypatch.setenv("USE_LLM_STUB", "false")
    client = MagicMock()
    client.chat_structured.side_effect = json.JSONDecodeError("Output token limit", "", 0)
    client.chat_json.side_effect = json.JSONDecodeError("Output token limit", "", 0)
    with patch.object(llm_analyzer, "LlmClient", return_value=client):
        response = TestClient(app).post(
            "/analyze", json=_request("Usamos ERP no financeiro.").model_dump(by_alias=True)
        )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "LLM_RESPONSE_INVALID"


def test_provider_schema_and_runtime_enforce_commercial_collection_bounds():
    payload = _payload({"products": [], "personas": [], "budgets": [], "sentimentByTopic": []})
    product = {"name": "ERP", "relationship": "MENTIONED", "sourceQuote": "We discussed ERP."}
    payload["commercialIntelligence"]["products"] = [product] * 30
    validator = Draft202012Validator(build_json_schema_for_analysis())
    validator.validate(payload)
    MeetingAnalysisV1.model_validate(payload)
    payload["commercialIntelligence"]["products"].append(product)
    assert list(validator.iter_errors(payload))
    with pytest.raises(ValidationError):
        MeetingAnalysisV1.model_validate(payload)


def test_stub_only_emits_literal_product_mentions_and_honors_the_core_gate():
    request = _request("Usamos ERP e estamos comparando AlternativeCRM para a próxima fase.")
    response = stub_analyzer.analyze(request)
    assert response.commercial_intelligence is not None
    assert {p.name for p in response.commercial_intelligence.products} == {"ERP", "AlternativeCRM"}
    assert {p.relationship.value for p in response.commercial_intelligence.products} == {
        "MENTIONED"
    }
    assert response.metadata.commercial_items_accepted == 2
    with patch.object(stub_analyzer, "_commercial_intelligence") as extraction:
        core = stub_analyzer.analyze(_request(request.transcript, enabled=False))
    extraction.assert_not_called()
    assert core.commercial_intelligence is None
    assert core.metadata.commercial_items_accepted == 0


@pytest.mark.parametrize("fallback", [False, True])
def test_llm_grounding_keeps_the_full_long_transcript_and_reports_rejections(fallback):
    transcript = "Contexto neutro.\n" * 11600 + "Usamos ERP no financeiro."
    assert len(transcript) > 185000
    commercial = {
        "products": [
            {"name": "ERP", "relationship": "CURRENT", "sourceQuote": "Usamos ERP no financeiro."},
            {
                "name": "MissingCRM",
                "relationship": "OPPORTUNITY",
                "sourceQuote": "MissingCRM was selected.",
            },
        ]
    }
    client = MagicMock()
    raw = json.dumps(_payload(commercial))
    client.chat_structured.return_value = (raw, 50000, 500)
    client.chat_json.return_value = (raw, 50000, 500)
    if fallback:
        client.chat_structured.side_effect = RuntimeError("Structured mode unavailable")
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
        patch.object(llm_analyzer, "verify_products", side_effect=lambda _, ci, *args: (ci, 0, 0)),
    ):
        response = llm_analyzer.analyze(_request(transcript), Settings(llm_api_key="test"))
    assert response.metadata.commercial_items_accepted == 1
    assert response.metadata.commercial_items_rejected == 1
    assert response.commercial_intelligence is not None
    assert len(response.commercial_intelligence.products) == 1
    call = client.chat_json.call_args if fallback else client.chat_structured.call_args
    rendered = re.search(
        r"Transcrição da reunião.*?```\n(.*?)\n```", call.kwargs["user_prompt"], re.S
    )[1]
    segments = json.loads(rendered)
    assert "".join(item["text"] for item in segments) == transcript
    assert all(len(item["text"]) <= 500 for item in segments)
    assert call.kwargs["max_tokens"] == 8192


def test_router_grounding_uses_shielded_source_without_reconstructing_person_names(monkeypatch):
    monkeypatch.setenv("USE_LLM_STUB", "false")
    client = MagicMock()
    seen = []

    def answer(**kwargs):
        if kwargs["schema_name"] == "meeting_product_verification":
            data = json.loads(kwargs["user_prompt"])
            seen.append("".join(item["text"] for item in data["transcriptSegments"]))
            return (
                json.dumps({"product0": {"relationship": "MENTIONED", "choice": 0}}),
                10,
                10,
            )
        rendered = re.search(
            r"Transcrição da reunião.*?```\n(.*?)\n```", kwargs["user_prompt"], re.S
        )[1]
        source = "".join(item["text"] for item in json.loads(rendered))
        seen.append(source)
        return (
            json.dumps(
                _payload(
                    {
                        "personas": [
                            {
                                "speaker": "LOCUTOR_01",
                                "role": None,
                                "decisionRole": "UNKNOWN",
                                "evidenceId": 1,
                            }
                        ]
                    }
                )
            ),
            10,
            10,
        )

    client.chat_structured.side_effect = answer
    with (
        patch.object(llm_analyzer, "LlmClient", return_value=client),
        patch.object(llm_analyzer, "verify_summary", side_effect=lambda _, s, *args: (s, 0, 0)),
    ):
        response = TestClient(app).post(
            "/analyze",
            json=_request("LOCUTOR_01: Meu nome é Maria da Silva e uso ERP.").model_dump(
                by_alias=True
            ),
        )
    assert response.status_code == 200
    body = response.json()
    assert "Maria da Silva" not in seen[0]
    assert "[[PERSON_NAME_" in seen[0]
    assert body["commercialIntelligence"]["personas"][0]["sourceQuote"] == seen[0]
    assert "Maria da Silva" not in json.dumps(body["commercialIntelligence"])
    assert body["metadata"]["commercialItemsAccepted"] == 2
    assert len(seen) == 2 and seen[0] == seen[1]


def test_each_commercial_observation_survives_serialization_with_literal_evidence():
    quote = "LOCUTOR_01: Sou usuário do ERP e o preço é R$ 150 por mês."
    intelligence = _commercial(
        products=[{"name": "ERP", "relationship": "CURRENT", "sourceQuote": quote}],
        personas=[
            {
                "speaker": "LOCUTOR_01",
                "role": "usuário",
                "decisionRole": "USER",
                "sourceQuote": quote,
            }
        ],
        budgets=[
            {
                "amount": 150,
                "currency": "BRL",
                "kind": "PRICE",
                "approval": "UNKNOWN",
                "period": "por mês",
                "sourceQuote": quote,
            }
        ],
        sentimentByTopic=[{"topic": "Price", "sentiment": "NEUTRAL", "sourceQuote": quote}],
    )
    result, accepted, rejected = ground_commercial_intelligence(intelligence, quote, "pt-BR")
    assert (accepted, rejected) == (4, 0)
    assert result is not None
    body = json.loads(result.model_dump_json(by_alias=True))
    for items in body.values():
        assert all(normalize_quote(item["sourceQuote"]) in normalize_quote(quote) for item in items)
