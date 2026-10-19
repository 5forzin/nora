![NORA](docs/assets/nora-readme-banner.svg)

NORA turns meeting transcripts into summaries, decisions, tasks, and commercial signals. It helps business directors follow conversations across teams without reading every transcript.

## How it works

Import a transcript or record a meeting with the Windows desktop app. Review risks and opportunities, ask questions across meetings with references to the source, and track follow-up tasks.

## Example

Translated excerpt from a [synthetic customer meeting](data/samples/sample-short-risk.srt):

> "We're seriously considering leaving Acme. The support ticket has been open for three weeks without a technical response."

| Signal | Finding |
|---|---|
| Churn risk | Unresolved performance issues and delayed support. |
| Competitor | The customer is also talking to OmniBusiness. |
| Follow-up | Document a 30-day recovery plan by the next day. |

## Built with

Next.js, TypeScript, Spring Boot, FastAPI, PostgreSQL, and Tauri/Rust. Google and OpenAI adapters provide analysis, chat, and streaming transcription.

## Project

Development is complete. The source code and documentation are kept here for reference.

[Architecture](docs/engineering/architecture.md) · [Documentation](docs/adr/README.md) · [AGPL-3.0 license](LICENSE)
