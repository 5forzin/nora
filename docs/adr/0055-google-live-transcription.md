# ADR 0055 — Google Live transcription behind the existing session broker

Status: accepted
Date: 2026-10-19

## Context

The deployed OpenAI credential stopped authenticating. Google AI Studio credentials are
available, and Google's dedicated `gemini-3.5-transcribe-live` model provides streaming
transcription without a conversational audio response. The existing Desktop implements only
OpenAI's WebSocket protocol. Changing an endpoint alone cannot switch providers.

This record supersedes the single-provider and matching capture/wire-rate assumptions in
ADR 0045. Its authentication, tenant attribution and direct audio path remain in force.

## Decision

- Select the transcription provider on the server with `NORA_STT_PROVIDER`. Keep `openai` as
  the compatibility default; `google` selects the dedicated Google broker and Desktop adapter.
- Retain `POST /stt/sessions` and its response fields. The server chooses the model, language,
  endpoint and audio format; the client cannot select a more expensive model.
- Exchange the Google account key for a single-use token at `/v1beta/auth_tokens`. Constrain
  the entire `bidiGenerateContentSetup` to the transcription model, `TEXT` response modality
  and input language. Return only the token and public session metadata.
- Use the constrained Google WebSocket endpoint with `Authorization: Token <ephemeral>`.
  Keep credentials out of URLs, logs, exception messages and persisted state.
- Distinguish the token's connection-opening deadline from the provider's session lifetime.
  `expiresAt` describes the former. A provider disconnect still obtains a new credential
  through the existing authorization and bounded reconnection path.
- Preserve 24 kHz capture and its monotonic recording clock. The Google adapter converts to
  16 kHz PCM16 little-endian mono and groups approximately 100 ms of audio per wire message.
- Wait for `setupComplete` before audio. Map interim input transcription to replaceable
  previews and finalized input transcription to committed text. Ignore model responses and
  output transcription.
- On stop, drain queued capture audio and the converter tail, send `audioStreamEnd`, and
  read final transcription within a bounded deadline. Do not require OpenAI commit events.

## Consequences

The Desktop needs a signed update to understand Google's protocol. A server configuration
change cannot add that protocol to an already installed binary.

Raw audio still travels directly from the Desktop to the selected external provider before
text redaction exists. Session-issuance telemetry remains an estimate of usage, with zero
token counts and no invented cost. Network gaps can still lose audio, as declared by ADR 0045.

## References

- [Google Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
- [Google WebSocket and ephemeral-token reference](https://ai.google.dev/api/live)
