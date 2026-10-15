# 0053 — Structured transcript imports and commercial evidence

- Status: accepted
- Date: 2026-10-15
- Related: ADR 0003 (structured model output), ADR 0012 and ADR 0040 (analysis privacy),
  ADR 0048 (declared participant identity), ADR 0052 (Core and Enterprise boundary)

## Context

Supplied transcript exports contain JSON arrays, JSON Lines and CSV records with meeting IDs,
client codes, dates and survey metadata. Treating the export as one transcript destroys its
meeting boundaries. Repeated source records can also inflate analysis counts. Existing commercial
signals do not separately represent products, stakeholder roles, monetary values or sentiment
about individual topics.

## Decision

### Import review

The web application reads JSON, JSONL and CSV locally, with a 64 MiB file ceiling and 2,000 source
records per review. A preview shows valid records, duplicate source IDs, invalid rows and encoding
warnings before any upload. The user selects which meetings to import. Uploads use the existing
authenticated TXT meeting endpoint, with at most two in-flight analyses and an individual retry per
failure. A slot remains occupied until analysis completes or fails. A polling timeout or uncertain
upload pauses unsent records until the user checks the accepted meeting's status;
limiting only POST requests would exhaust the API's bounded executor queue on a large export.
The browser can pause unsent records, and leaving the page stops new uploads. Accepted meetings
continue on the server. Reopening the same file reuses the stable keys for already accepted rows.
This does not add batch audio transcription.

Each meeting preserves its source ID as `attributes.externalId`, its client code as
`attributes.clientCode`, and its meeting date. Source timestamps without an offset are interpreted
as Brazil time at UTC-03:00. Additional source metadata is retained separately from transcript text.
Revenue bands and survey NPS are not purchase budgets or conversation sentiment.

Repeated IDs with matching text are skipped within a file. Conflicting text under one source ID
is reported for review. Identical text under distinct IDs remains distinct: repeated words alone
do not establish that two meeting records are duplicates. Stable import idempotency keys reuse
the existing tenant/user-scoped upload reservation; a changed payload under a reserved key is a
conflict, never an instruction to overwrite an existing meeting.

### Commercial extraction

Enterprise analysis adds an optional `commercialIntelligence` object with products and their
relationships, stakeholder roles, monetary mentions with their kind and approval status, and
sentiment by topic. Every extracted item includes a source quotation. Unknown monetary amounts,
currencies, roles and approval status remain null or explicitly unknown. Comparators and
estimates are not persisted as exact monetary amounts; independently supported exact values
in the same passage remain usable.

Persona extraction describes a role supported by the conversation, not reconstructed personal
identity. A speaker label must come from the protected transcript. Binding a stated job role to
a speaker requires an explicit self-declaration in that speaker's own turn. Otherwise the role
and its quotation can remain anonymous, without transferring the speaker's decision authority.
Products remain configurable through tenant context; no vendor-specific commercial rules are
embedded in product code.
Before grounding, literal configured product or competitor names found in the protected
transcript may supply additional MENTIONED candidates. They preserve source spelling, are
deduplicated within the same 30-product limit, and cannot recover a previously rejected item.
Catalogue membership establishes no usage, interest or competitive relationship; candidates
must pass the same grounding and semantic review as provider-extracted products.

The analysis privacy shield runs before extraction. Enterprise provider requests label protected
transcript segments with request-local evidence IDs. The worker resolves those IDs into original
quotations before returning the public contract; IDs are never exposed as commercial evidence.
New commercial items whose quotations cannot be grounded in the protected transcript are excluded.
Products receive a separate review against the complete protected transcript without the seller's
catalogue. That pass can reclassify or remove accepted products and select a better supporting
quotation from product-specific eligible evidence choices. The strict response requires each
product key exactly once and bounds its local choice index to windows containing that product's
literal name; it cannot select an unrelated source ID or fall back to an old quotation.
The worker constructs a contiguous window of complete source
segments up to 500 characters and checks the unchanged product name and quotation again. The
review cannot generate a name or quotation, or recover a previously rejected product.

All analysis passes share the request deadline, and metadata includes their combined token usage.
Product review adds a provider call only when Enterprise extraction or literal context candidates
produce grounded products.
Lexical checks and model review are safeguards, not a claim that all commercial interpretations
are correct or that confidence is a calibrated
probability of sale. The user can inspect the supporting quotations.

### Client history and access

Imported client codes identify a customer's meeting history within its tenant. History orders
meetings by their actual meeting date and filters each meeting through existing IAM checks before
returning content. The client code does not prove that different meetings concern the same
opportunity. Historical risks are not automatically resolved, and this delivery does not add
Account Health or revenue forecasting.

Structured commercial intelligence and client history are Enterprise capabilities. Core retains
structured import, summaries, decisions, tasks and the existing shared features. The API masks
commercial fields on Core responses, exports and read-only MCP, including after a downgrade.

## Consequences

- Old analyses remain readable with absent commercial intelligence.
- Input format validation and extraction quality are evaluated separately. A successful import
  does not prove a correct commercial interpretation.
- Release validation must use representative supplied transcripts with the real provider,
  including missing fields, commercial objections, monetary distinctions, repeated imports,
  client chronology, permission boundaries and a long transcript.
- Corpus files, source conversations, credentials and private validation accounts remain outside
  the public repository. Only synthetic regression cases belong in source control.
- This decision extends the import and commercial analysis scope of ADR 0052. Its other
  exclusions, and the privacy limits of ADR 0040, remain unchanged.
