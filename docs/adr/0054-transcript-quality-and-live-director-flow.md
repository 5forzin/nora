# 0054 — Measurable transcript quality and the live director workflow

- Status: accepted
- Date: 2026-10-15
- Related: ADR 0052 (plan boundaries), ADR 0053 (structured import and evidence),
  ADR 0004 (provider independence), ADR 0040 (privacy scope)

## Context

The Sprint 4 demonstration must show a director moving from a transcript to an action inside
the running product. The supplied challenge also asks for measurable data quality. Existing
import validation and source quotations do not establish transcription accuracy or extraction
recall. Decorative sample reports and explanatory filler distract from the actual workflow.

The user also requested a Google API integration and a measured comparison with OpenAI.

## Decision

- Compute transcript diagnostics and extraction completeness deterministically. Report counts
  and their scope, without an arbitrary quality score, word-error rate, calibrated confidence,
  or a claim of complete extraction.
- Keep generated model schemas separate from these diagnostics. Quality measurements must
  not depend on a model grading its own answer. Preserve the input, source evidence and the
  Core/Enterprise access boundary.
- Preserve old analyses. Where the original protected transcript is unavailable, a derived
  legacy view must leave protected-source verification unknown rather than manufacture it.
- Demonstrate import, processing, source review, client history, task ownership and task
  progress in the application. Reanalysis must not silently discard tracked work.
- Keep application copy functional and brief. Remove decorative fabricated business figures
  rather than removing their disclaimer and making them appear real.
- Integrate Google through its documented OpenAI-compatible API for analysis and chat.
  The complete nested analysis schema is rejected by Google in real-provider checks; use JSON
  mode with the schema in the prompt and retain the full server-side validation.
  Credentials are provider-specific and remain on the server. Provider configuration must not
  send an OpenAI credential to Google or the reverse.
- Compare the same bounded input samples, including a financial distinction, missing fields
  and a supplied transcript. Record model IDs, latency, token use, catalogue cost and semantic
  checks. A small comparison does not establish general superiority. Audio comparison uses
  the same audio and preserves the distinction between file and streaming transcription.
- Keep the presentation account empty and separate from validation tenants. Change the
  production provider only after the relevant product paths have passed real-provider tests.

## Consequences

The director can inspect the information available and the work that remains, with observable
diagnostics instead of an unexplained score. Existing privacy and permission limits still apply.
No billing, SSO, Account Health forecasting or automatic commercial decision is added.
