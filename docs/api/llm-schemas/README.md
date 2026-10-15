# JSON Schemas — Structured LLM Output

These schemas are the **source of truth** for the formats the NLP Worker requires from the LLM.

- **Standard**: Draft 2020-12.
- **Usage**: pass as `response_format: { type: "json_schema", json_schema: ... }` in the call to the LLM provider (provider-agnostic — default is OpenAI directly with `gpt-4o-mini`; Azure OpenAI in Enterprise. See ADR 0004).
- **Validation**: Pydantic (Python) and Bean Validation (Java) must mirror these schemas.
- **Versioning**: breaking changes increment the suffix of the file name (`-v2`).

> **Fidelity caveat (2026-05-21):** `meeting-analysis-v1.schema.json` is the documentary contract, but the worker emits via `build_json_schema_for_analysis()` (`services/nlp-worker/src/nora_nlp/clients/llm.py`) and validates via the Pydantic `MeetingAnalysisV1` (`models.py`). The `customerConfidence` field is present in the schema, **is** emitted by the worker and persisted (see ADR 0015); `participants` and `baselineTerms` are emitted by the worker and were added to the schema in this reconciliation. Changing a field here requires synchronizing Pydantic + the inline builder.
>
> **`participants` is emitted and consumed by nothing (recorded 2026-08-17, ADR 0048).** The distinction the paragraph above draws between "emitted" and "persisted" is load-bearing for this one field, so it is spelled out: `WorkerDtos.AnalyzeResponse` in `services/api` has no `participants` member, the backend never reads the array, and the names in it are `[[PERSON_NAME_n]]` placeholders anyway because the shield runs before the analyzer. Participant identity (US13) is decided in the API over the roster declared on upload. The field is kept rather than removed because removing it is a contract change that belongs to whoever next versions this schema.

| File | Content |
|---|---|
| `meeting-analysis-v1.schema.json` | Complete output of the main meeting analysis prompt |
| `commercial-intelligence-v1.schema.json` | Optional Enterprise product, persona, monetary and topic-sentiment observations, each with source evidence |
| `pii-redaction-v1.schema.json` | Result of the PII shield before sending to the LLM |
| `tenant-context-embedding-v1.schema.json` | Indexable chunk of the tenant's context for RAG |

## Rules

1. **No optional fields without a clear default value.** If the AI does not know, it returns `null` or an empty array.
2. **Every source quote is mandatory** for actionable items (action items, risks, opportunities).
3. **Confidences are `0.0–1.0`**, never percentages.
4. **Closed enums.** Free-form categories only inside `topics`.
5. **Markdown only in the `summary` field** (rendered on the web via `react-markdown`). All other text fields are plain text, without markdown.

`commercialIntelligence` is an optional nullable extension of the meeting-analysis envelope;
older responses without it remain valid. Its independently versioned v1 schema defines four
collections capped at 30 observations each. `includeCustomerConfidence=false` suppresses both
commercial blocks, including when a provider returns them despite the disabled schema.
For enabled extractions, the provider must return the object with all four arrays, using empty
arrays when evidence is absent. Both structured and JSON-mode responses enforce this requirement.
An omitted or null extraction can trigger the existing JSON-mode retry within the same request
budget; a repeated omission is rejected, never silently persisted.
Enabled provider schemas generate this block first and describe each collection separately;
an empty collection is still valid when no supported observation exists. Operational logs expose
only provider-item, accepted and rejected counts, never the observations or source quotes.
The internal Enterprise transport replaces commercial `sourceQuote` fields with an integer
`evidenceId` into contiguous shielded transcript segments of at most 500 characters. The worker
restores the original text before validation and grounding; these IDs never enter the public
response or these schemas. Invalid references are discarded and counted. Legacy literal quotes
retain their existing validation. See the worker's [context](../../../services/nlp-worker/CONTEXT.md).

The worker retains only observations whose `sourceQuote` occurs in the shielded transcript
after whitespace normalization. Product names and persona roles must also occur in the quote;
persona speakers may only be literal numbered speaker labels or person-name placeholders.
When a persona includes a role, the speaker must explicitly self-declare that role in their own
turn. Otherwise the grounded role and quote remain, but speaker becomes null and decision role
UNKNOWN; a third party's role is never assigned to whoever mentioned it.
Monetary amounts, currencies and periods must be supported by their own quote. Revenue is a
separate kind from budget; no monetary value is inferred from headcount, NPS or percentages.
An absent currency is normalized only when the quote contains one unambiguous explicit currency
symbol or ISO code; words such as "real" or "reais" alone never establish the currency.
This verifies textual support, not the correctness of every semantic classification.
Product relationships describe the customer's usage, not the seller's competitor catalogue.
Literal configured names present in the shielded transcript can supply additional MENTIONED
candidates before grounding, deduplicated within the same 30-product cap. They do not restore
previously rejected observations or establish usage, interest or competition. The same product
verifier reviews them, with no extra provider call.
Current usage takes priority even when switching away is discussed; `COMPETITOR` requires an
explicitly compared alternative that the customer does not currently use.
Enterprise analyses with grounded products additionally verify their relationships against the
complete shielded transcript, without a seller catalogue. The internal reviewer can only
reclassify or remove existing product keys and select a bounded local choice from that product's
eligible original evidence IDs. Every eligible window contains its literal name under the same
case and whitespace rules as grounding. The strict product0/product1/... property set and each
choice's numeric bound prevent cross-product or nonexistent selections without large ID enums.
Names cannot change and quote text cannot be generated or fall back to an old quote. The source
appears once as ordered evidence segments.
The worker resolves a contiguous window of complete segments up to 500 characters, preferring
previous neighbors before adding following ones, without skipping text or cutting placeholders.
The selected name and recovered original-source quote are grounded again. Historical abandoned
implementations and returned licences do not establish current use. This conditional third
provider call shares the request budget and contributes its tokens to response metadata.
Bounds and approximate monetary values become amount null, preserving kind, approval and
evidence; unrelated exact amounts in the same quote remain valid.
`metadata.commercialItemsAccepted` and `metadata.commercialItemsRejected` count retained and
discarded observations; they do not measure extraction completeness or model accuracy.
