"""Provider-agnostic LLM client (default OpenAI direct).

Per ADR 0004, the NORA worker talks to any provider compatible with OpenAI's
Chat Completions API (OpenAI direct, Azure OpenAI, Groq, OpenRouter,
Ollama, etc.). The choice is made through environment variables:

- ``LLM_BASE_URL`` (default ``https://api.openai.com/v1``)
- ``LLM_API_KEY``
- ``LLM_MODEL``  (default ``gpt-4o-mini``)
- ``LLM_TEMPERATURE``

We use the official ``openai`` SDK pointing at the configured ``base_url``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from openai import OpenAI
from pydantic import BaseModel

from ..models import MeetingAnalysisV1
from ..settings import Settings
from ..time_budget import MIN_ATTEMPT_SECONDS, TimeBudget

logger = logging.getLogger(__name__)


class LlmClient:
    """Wrapper over the OpenAI SDK with a pluggable base_url."""

    # Total timeout for one LLM call. SDK default is 600s (10min) — on a
    # slow provider that hung the worker for 10 minutes per request.
    # 60s covers the p99 of gpt-4o-mini with prompts up to ~10K tokens.
    _LLM_TIMEOUT_SECONDS = 60.0

    # Covers transient failures (429/5xx) with the SDK's exponential backoff.
    # The caller still handles the final exception.
    _MAX_RETRIES = 2

    def __init__(self, settings: Settings, *, budget: TimeBudget | None = None) -> None:
        if not settings.llm_api_key:
            raise ValueError("LLM_API_KEY is required when USE_LLM_STUB=false.")
        self._client = OpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            timeout=self._LLM_TIMEOUT_SECONDS,
            max_retries=self._MAX_RETRIES,
        )
        self._model = settings.llm_model
        self._provider = settings.llm_provider
        self._default_temperature = settings.llm_temperature
        # What the request still has to spend, re-read before every call. Optional so a caller
        # with no deadline of its own (a script, a notebook) keeps the previous behaviour; the
        # three analyzers always pass one.
        self._budget = budget

    @property
    def model(self) -> str:
        return self._model

    @property
    def provider(self) -> str:
        return self._provider

    def _client_for(self, step: str) -> OpenAI:
        """The SDK client for ``step``, sized so its own retries fit the request's budget.

        ``max_retries`` is applied by the SDK around EACH call, so one ``chat_structured`` is up
        to ``_MAX_RETRIES + 1`` attempts of ``timeout`` seconds and the timeout on its own never
        bounded anything. Here what is left of the budget is divided by the attempts that may
        still happen; when that slice would fall under ``MIN_ATTEMPT_SECONDS`` the retries are
        given up one at a time, because a single attempt long enough to finish is worth more
        than three that are all cut off short.

        Raises ``LlmBudgetExceededError`` (via ``remaining_for``) rather than issuing a call
        whose answer would arrive after the caller's deadline.
        """
        if self._budget is None:
            return self._client
        remaining = self._budget.remaining_for(step)
        retries = self._MAX_RETRIES
        while retries > 0 and remaining / (retries + 1) < MIN_ATTEMPT_SECONDS:
            retries -= 1
        timeout = min(self._LLM_TIMEOUT_SECONDS, remaining / (retries + 1))
        return self._client.with_options(timeout=timeout, max_retries=retries)

    def chat_structured(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        json_schema: dict[str, Any],
        schema_name: str = "meeting_analysis",
        temperature: float | None = None,
        max_tokens: int = 4096,
    ) -> tuple[str, int, int]:
        """Calls the model with a strict JSON Schema. Returns (json, in, out)."""
        response = self._client_for("the structured call").chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=self._default_temperature if temperature is None else temperature,
            max_tokens=max_tokens,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": schema_name,
                    "strict": True,
                    "schema": json_schema,
                },
            },
        )
        return self._extract(response, mode="json_schema")

    def chat_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float | None = None,
        max_tokens: int = 4096,
    ) -> tuple[str, int, int]:
        """Fallback to JSON mode (no strict schema)."""
        response = self._client_for("the JSON-mode call").chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=self._default_temperature if temperature is None else temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        return self._extract(response, mode="json_object")

    def _extract(self, response: Any, *, mode: str) -> tuple[str, int, int]:
        choice = response.choices[0]
        if getattr(choice, "finish_reason", None) == "length":
            # Even syntactically complete JSON may omit observations when the token limit wins.
            raise json.JSONDecodeError("Provider output exceeded its token limit", "", 0)
        content = choice.message.content or "{}"
        usage = response.usage
        tokens_input = usage.prompt_tokens if usage else 0
        tokens_output = usage.completion_tokens if usage else 0
        logger.info(
            "LLM call completed: provider=%s model=%s mode=%s tokens_in=%d tokens_out=%d",
            self._provider,
            self._model,
            mode,
            tokens_input,
            tokens_output,
        )
        return content, tokens_input, tokens_output


def build_strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Keep provider constraints identical to the model used to validate its response."""
    schema = model.model_json_schema(by_alias=True)

    def make_strict(node: Any) -> None:
        if isinstance(node, dict):
            node.pop("default", None)
            node.pop("title", None)
            if node.get("type") == "object":
                # Strict outputs require every key, including nullable fields with defaults.
                node["required"] = list(node["properties"])
                node["additionalProperties"] = False
            for key, value in node.items():
                if key in {"properties", "$defs"}:
                    for child in value.values():
                        make_strict(child)
                else:
                    make_strict(value)
        elif isinstance(node, list):
            for value in node:
                make_strict(value)

    make_strict(schema)
    return schema


def build_json_schema_for_analysis() -> dict[str, Any]:
    schema = build_strict_json_schema(MeetingAnalysisV1)
    # TF-IDF terms belong to the worker, never to the provider's extraction.
    del schema["properties"]["baselineTerms"]
    schema["required"].remove("baselineTerms")
    del schema["$defs"]["BaselineTerm"]
    schema["properties"]["summary"]["description"] = (
        "Executive summary in Markdown, in the transcript's language. Preserve explicitly "
        "recorded monetary amounts, approved budget ceilings, overruns, quantities, corrected "
        "dates and approval conditions. Distinguish a proposal from approval and completed "
        "documentation from financial authorization. Keep each date tied to its stated event; "
        "a delivery date does not establish an installation date. Do not invent missing values."
    )
    schema["$defs"]["Risk"]["properties"]["sourceQuote"]["description"] = (
        "Verbatim evidence of the cause of the risk, including stated amounts, limits or "
        "conditions when relevant. A request to record a risk alone is not its underlying "
        "evidence. Keep PII placeholders unchanged."
    )
    schema["properties"]["participants"]["description"] = (
        "At most 30 participant references supported by the transcript. PERSON_NAME "
        "placeholders identify individual redacted occurrences, not distinct people. "
        "Keep placeholders intact; never reconstruct names or merge them into identities. "
        "Count only mentions supported by the visible text."
    )
    schema["$defs"]["ActionItem"]["properties"]["dueDate"]["description"] = (
        "ISO 8601 date (YYYY-MM-DD), or null when the transcript only gives a relative "
        "date such as tomorrow or Friday. Never invent an absolute date."
    )
    commercial = schema["$defs"]["CommercialIntelligence"]
    commercial["description"] = (
        "Extract commercial observations from the whole transcript independently of "
        "customerConfidence, account identification and the tenant's product catalogue. "
        "Check each collection for explicit evidence before returning an empty array."
    )
    descriptions = {
        "products": (
            "Named software, systems, products or modules explicitly discussed, even when absent "
            "from tenantContext. Classify each by the relationship field's customer-usage rules, "
            "not by the seller's catalogue or vendorCompetitorReference. "
            "Skip anonymized names such as [COMPANY] or [[PERSON_NAME_1]]: "
            "they identify no product."
        ),
        "personas": (
            "Explicit job roles, decision authority, influence or usage responsibilities. "
            "A stated role is sufficient even when no name is known: keep speaker null if no "
            "allowed literal label is available, and decisionRole UNKNOWN "
            "if authority is unstated. "
            "Associate a role with a non-null speaker only when that speaker explicitly "
            "self-declares it in their own turn, such as 'Sou diretor financeiro' or "
            "'I am the finance director'. A role mentioned about another person does not belong "
            "to the speaker: keep the role but set speaker null and decisionRole UNKNOWN. "
            "With multiple speaker labels, isolate the selected speaker's own words first. "
            "Never require an identified customer or reconstruct a redacted identity."
        ),
        "budgets": (
            "Explicit monetary discussions: budgets, proposals, prices, revenue or other money. "
            "Keep their distinct kinds. Include an explicitly absent or unapproved budget with "
            "amount null; include a historical price as PRICE without treating it as approval. "
            "Convert exact digit or written amounts and stated scales only. R$ means BRL, "
            "For estimates or bounds such as 'under a thousand', 'more than ten million', "
            "'up to fifty thousand' or 'about twenty thousand', amount must be null; "
            "preserve the observation's kind, approval and quotation. "
            "including R$50.000 without a space. Never derive budget "
            "from revenue, NPS or headcount."
        ),
        "sentimentByTopic": (
            "Material evaluations of specific topics such as support, price, implementation or "
            "current systems. Extract supported positive, negative, neutral or mixed evaluations "
            "individually, even if sentimentOverall differs. This is not a forecast or churn score."
        ),
    }
    for field, description in descriptions.items():
        commercial["properties"][field]["description"] = description
    product = schema["$defs"]["CommercialProduct"]["properties"]
    product["name"]["description"] = (
        "Exact product name present in the selected evidence. Preserve its spelling; "
        "do not replace it with a canonical name from the seller's catalogue."
    )
    product["relationship"] = dict(schema["$defs"]["ProductRelationship"])
    product["relationship"]["description"] = (
        "Only the CUSTOMER'S relationship to this product, with these mutually exclusive rules "
        "in priority order: (1) CURRENT if the customer uses it NOW, including when replacing "
        "it is discussed; CURRENT always wins even if it competes with the seller. "
        "Past purchase, an abandoned implementation, returned licences or ended use do not "
        "prove current use; classify a solely historical reference as MENTIONED. "
        "(2) COMPETITOR only if NOT currently used and explicitly evaluated as an alternative "
        "in a comparison or switching decision. (3) OPPORTUNITY for a requested product, need "
        "or purchase interest without that explicit competing-alternative comparison. "
        "(4) MENTIONED for a reference without usage, purchase interest or comparison evidence. "
        "The seller's vendorCompetitorReference list never establishes this relationship. "
        "Example: if the seller lists LedgerOne as a competitor and the customer says 'We use "
        "LedgerOne today', return CURRENT, never COMPETITOR. 'We do not use NovaSuite and are "
        "comparing it with your offer' supports COMPETITOR. These examples are not meeting facts."
    )
    schema["$defs"]["CommercialPersona"]["properties"]["speaker"]["description"] = (
        "Literal anonymous speaker label or null. If role is non-null, keep a speaker only "
        "when their own turn explicitly self-declares that role. Otherwise keep the role "
        "with speaker null and decisionRole UNKNOWN, without reconstructing "
        "a third party's identity."
    )
    for definition in (
        "CommercialProduct",
        "CommercialPersona",
        "CommercialBudget",
        "TopicSentiment",
    ):
        schema["$defs"][definition]["properties"]["sourceQuote"]["description"] = (
            "Copy one contiguous verbatim passage from the transcript, at most 500 characters. "
            "Preserve spelling, case, punctuation, speaker labels and PII placeholders. "
            "Do not paraphrase, join distant passages, add ellipses or quote instructions/examples."
        )
    return schema
