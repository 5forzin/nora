"""LLM Analyzer: analysis pipeline via the agnostic LLM client.

Pipeline:
  1. Loads the versioned prompt from ``prompts/``.
  2. Injects tenant context JSON + transcript into the template.
  3. Calls the LLM with structured output (strict JSON Schema).
  4. On strict failure, falls back to JSON mode.
  5. Validates the response with Pydantic (``MeetingAnalysisV1``).
  6. Returns ``AnalyzeResponse`` with execution metadata.

Provider configured via ``LLM_BASE_URL`` / ``LLM_API_KEY`` / ``LLM_MODEL``
(ADR 0004). Default: OpenAI direct with ``gpt-4o-mini``.
"""

from __future__ import annotations

import json
import logging
import time

from ..clients.llm import LlmClient, build_json_schema_for_analysis
from ..models import AnalyzeRequest, AnalyzeResponse, MeetingAnalysisV1
from ..settings import Settings
from ..time_budget import LlmBudgetExceededError, TimeBudget
from .commercial_candidates import add_context_product_candidates
from .commercial_evidence import (
    render_evidence,
    resolve_evidence,
    segment_evidence,
    use_evidence_schema,
)
from .commercial_grounding import ground_commercial_intelligence
from .date_grounding import contains_explicit_date
from .pii_shield import admissible_tenant_terms
from .product_verifier import verify_products
from .prompt_utils import load_prompt, render_template
from .shield_walk import shield_field, shield_tree
from .summary_verifier import verify_summary

logger = logging.getLogger(__name__)


class LlmAnalysisShapeError(ValueError):
    """The provider omitted a required extraction despite returning valid JSON."""


def _parse_response(raw_json: str, *, require_commercial: bool) -> object:
    parsed = json.loads(raw_json)
    if require_commercial:
        commercial = parsed.get("commercialIntelligence") if isinstance(parsed, dict) else None
        collections = ("products", "personas", "budgets", "sentimentByTopic")
        if not isinstance(commercial, dict) or any(
            not isinstance(commercial.get(name), list) for name in collections
        ):
            raise LlmAnalysisShapeError(
                "commercialIntelligence must be an object containing all four collections."
            )
    return parsed


def _build_goal_section(
    req: AnalyzeRequest,
    redaction_counter: list[int],
    tenant_terms: frozenset[str] = frozenset(),
) -> str:
    """Renders the prompt section with the user's goal (ADR 0005).

    Without a goal, returns an explicit instruction to the LLM to emit productivity=null.
    Applies PII Shield to `purpose`, `expected_outcomes` and `project_state_snapshot`
    because they are user free-text fields that went raw to the LLM (violation
    of ADR 0012 before this PR).
    """
    if req.goal is None:
        return "Nenhum objetivo foi declarado para esta reuniao. DEVE emitir `productivity` = null."

    purpose = shield_field(req.goal.purpose, redaction_counter, tenant_terms)
    outcomes_shielded = [
        shield_field(o, redaction_counter, tenant_terms) for o in req.goal.expected_outcomes
    ]
    outcomes_md = "\n".join(f"- {o}" for o in outcomes_shielded)
    if req.goal.project_state_snapshot:
        snap = shield_field(req.goal.project_state_snapshot, redaction_counter, tenant_terms)
        state_block = f"\n\nEstado atual do projeto (informado pelo usuario):\n```\n{snap}\n```"
    else:
        state_block = ""
    return (
        f"O usuario declarou objetivo para esta reuniao. Avalie produtividade "
        f"comparando o que foi discutido com o que era esperado.\n\n"
        f"Proposito declarado: {purpose}\n\n"
        f"Outcomes esperados:\n{outcomes_md}{state_block}\n\n"
        f"Para cada outcome esperado, classifique como ADDRESSED, PARTIAL ou MISSED "
        f"e cite evidencia textual da transcricao. Calcule o score (0-100) priorizando "
        f"cobertura de outcomes; bandas: LOW (<40), MEDIUM (40-69), HIGH (>=70). "
        f"Inclua offTopicRatio e decisionDensity como floats 0-1 (ou null se nao puder estimar). "
        f"DEVE emitir o campo `productivity` populado (nao null)."
    )


def analyze(
    req: AnalyzeRequest,
    settings: Settings,
    *,
    pii_redactions_applied: int = 0,
    budget: TimeBudget | None = None,
) -> AnalyzeResponse:
    """Analyzes the transcript via LLM with structured JSON output."""
    started = time.monotonic()

    # One budget for the whole request: the structured call and the JSON-mode retry below draw
    # on the same seconds, and the router hands one in that started before the PII shield so
    # that time counts against the caller's deadline too. See `time_budget.py`.
    budget = budget or TimeBudget.from_settings(settings)

    client = LlmClient(settings, budget=budget)

    system_prompt, user_template = load_prompt(req.options.prompt_version)

    # tenant_context is long free text throughout (companyName, industry, products,
    # valueProposition, objectionHandling, competitors, glossary) — every string leaf of it
    # goes through the shield, as defense-in-depth against a tenant that pastes PII into the
    # commercial context. The walk covers the whole structure so a field added to
    # TenantContext later is protected by default instead of by remembering to list it.
    #
    # The terms are recomputed here rather than threaded down from the router, and that is
    # deliberate: they are derived from `req.tenant_context`, which this function already holds,
    # so there is one source and no parameter to forget. Per request, no cache, no module state.
    extra_redactions = [0]
    tenant_terms = admissible_tenant_terms(
        req.tenant_context.company_name, req.tenant_context.competitors
    )
    ctx_dict = shield_tree(
        req.tenant_context.model_dump(by_alias=True), extra_redactions, tenant_terms
    )
    if req.options.include_customer_confidence:
        ctx_dict["vendorCompetitorReference"] = ctx_dict.pop("competitors")

    tenant_ctx_json = json.dumps(ctx_dict, ensure_ascii=False, indent=2)

    goal_section = _build_goal_section(req, extra_redactions, tenant_terms)

    pii_redactions_applied = pii_redactions_applied + extra_redactions[0]

    evidence = segment_evidence(req.transcript) if req.options.include_customer_confidence else ()
    provider_transcript = render_evidence(evidence) if evidence else req.transcript
    user_prompt = render_template(
        user_template,
        tenant_context_json=tenant_ctx_json,
        meeting_id=req.meeting_id,
        language=req.language,
        transcript=provider_transcript,
        goal_section=goal_section,
    )

    json_schema = build_json_schema_for_analysis()
    if req.options.include_customer_confidence:
        use_evidence_schema(json_schema, len(evidence))
        json_schema["properties"]["commercialIntelligence"] = {
            "$ref": "#/$defs/CommercialIntelligence"
        }
        commercial_schema = json_schema["properties"].pop("commercialIntelligence")
        json_schema["properties"] = {
            "commercialIntelligence": commercial_schema,
            **json_schema["properties"],
        }
        json_schema["required"].remove("commercialIntelligence")
        json_schema["required"].insert(0, "commercialIntelligence")
        system_prompt += (
            "\nCommercial intelligence extraction is enabled. "
            "Extract commercialIntelligence first, before writing the overall summary. "
            "Always return it as an object with products, personas, "
            "budgets and sentimentByTopic arrays, even when customerConfidence is null. "
            "Use an empty array only when the transcript supports no observations for it. "
            "Never omit this object, return it as null, or invent observations to fill it."
            " The transcript is a JSON array of contiguous evidenceId/text segments in order; "
            "read all segments as one complete meeting. For commercialIntelligence only, "
            "return evidenceId instead of sourceQuote, as specified by this schema. "
            "The worker resolves the exact original text; never rewrite or join evidence. "
            "For personas, select a segment containing the literal speaker label and role; "
            "if the segment has no allowed speaker label, use speaker null. "
            "All other analysis fields keep their usual sourceQuote contract."
            " vendorCompetitorReference describes the seller's catalogue competition only; "
            "it never determines a customer's product relationship. CURRENT takes priority "
            "whenever the customer already uses the product. COMPETITOR requires a NOT-currently-"
            "used alternative explicitly compared in the meeting."
        )
    else:
        json_schema["properties"]["customerConfidence"] = {"type": "null"}
        json_schema["properties"]["commercialIntelligence"] = {"type": "null"}
        system_prompt += (
            "\nCustomer Confidence is disabled for this workspace. "
            "Do not evaluate customer confidence or generate buying-signal or objection scores. "
            "Return customerConfidence and commercialIntelligence as null."
        )

    # The fallback receives the identical prompt; only the transport mode changes.
    system_prompt += "\n\nReturn JSON matching this schema:\n" + json.dumps(json_schema)

    try:
        raw_json, tokens_in, tokens_out = client.chat_structured(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            json_schema=json_schema,
            schema_name="meeting_analysis",
            max_tokens=8192 if req.options.include_customer_confidence else 4096,
        )
        parsed = _parse_response(
            raw_json, require_commercial=req.options.include_customer_confidence
        )
    except LlmBudgetExceededError:
        # Explicitly ahead of the generic branch, which would otherwise swallow it: re-sending
        # the whole prompt in JSON mode is the most expensive thing this function can do, and
        # the budget having run out is precisely the case where nobody is left to receive the
        # answer. `chat_json` would refuse anyway; failing here says why.
        raise
    except Exception as exc:
        logger.warning("Structured output failed, falling back to JSON mode: %s", exc)
        raw_json, tokens_in, tokens_out = client.chat_json(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=8192 if req.options.include_customer_confidence else 4096,
        )
        parsed = _parse_response(
            raw_json, require_commercial=req.options.include_customer_confidence
        )

    # Do NOT log raw_json: it may contain residual PII that escaped the shield
    # as text echoed in sourceQuote. ADR 0012 (PII never logged).
    logger.debug("LLM raw response: %d chars", len(raw_json))

    if not req.options.include_customer_confidence and isinstance(parsed, dict):
        parsed["customerConfidence"] = None
        parsed["commercialIntelligence"] = None
    evidence_rejected = 0
    extracted_product_names = []
    if req.options.include_customer_confidence:
        extracted_product_names = [
            item["name"]
            for item in parsed["commercialIntelligence"]["products"]
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        ]
        parsed["commercialIntelligence"], evidence_rejected = resolve_evidence(
            parsed["commercialIntelligence"], evidence
        )
    analysis = MeetingAnalysisV1.model_validate(parsed)
    candidate_added = 0
    provider_product_count = len(extracted_product_names)
    if req.options.include_customer_confidence:
        intelligence, candidate_added = add_context_product_candidates(
            analysis.commercial_intelligence,
            req.transcript,
            [product["name"] for product in ctx_dict["products"]]
            + ctx_dict["vendorCompetitorReference"],
            evidence,
            extracted_names=extracted_product_names,
        )
        analysis = analysis.model_copy(update={"commercial_intelligence": intelligence})
    intelligence, commercial_accepted, commercial_rejected = ground_commercial_intelligence(
        analysis.commercial_intelligence, req.transcript, req.language
    )
    commercial_rejected += evidence_rejected
    analysis = analysis.model_copy(update={"commercial_intelligence": intelligence})
    verified_summary, verification_in, verification_out = verify_summary(
        client, analysis.summary, req.transcript, req.language
    )
    analysis = analysis.model_copy(update={"summary": verified_summary})
    tokens_in += verification_in
    tokens_out += verification_out
    if req.options.include_customer_confidence:
        grounded_product_count = len(intelligence.products)
        intelligence, product_in, product_out = verify_products(
            client, intelligence, req.transcript, req.language
        )
        removed = len(analysis.commercial_intelligence.products) - len(intelligence.products)
        commercial_accepted -= removed
        commercial_rejected += removed
        analysis = analysis.model_copy(update={"commercial_intelligence": intelligence})
        tokens_in += product_in
        tokens_out += product_out
        logger.info(
            "Product verification: extracted=%d context_candidates=%d grounded=%d verified=%d",
            provider_product_count,
            candidate_added,
            grounded_product_count,
            len(intelligence.products),
        )
    logger.info(
        "Commercial extraction: enabled=%s provider_items=%d accepted=%d rejected=%d "
        "context_candidates=%d",
        req.options.include_customer_confidence,
        commercial_accepted + commercial_rejected - candidate_added,
        commercial_accepted,
        commercial_rejected,
        candidate_added,
    )

    for action in analysis.action_items:
        if action.due_date is not None and not all(
            contains_explicit_date(text, action.due_date, req.language)
            for text in (action.source_quote, req.transcript)
        ):
            action.due_date = None

    elapsed_ms = int((time.monotonic() - started) * 1000)

    response = AnalyzeResponse.model_validate(
        {
            **analysis.model_dump(by_alias=True),
            "meetingId": req.meeting_id,
            "metadata": {
                "modelVersion": f"{settings.llm_provider}-{settings.llm_model}",
                "promptVersion": req.options.prompt_version,
                "tokensInput": tokens_in,
                "tokensOutput": tokens_out,
                "processingMillis": elapsed_ms,
                "piiRedactionsApplied": pii_redactions_applied,
                "commercialItemsAccepted": commercial_accepted,
                "commercialItemsRejected": commercial_rejected,
            },
        }
    )

    return response
