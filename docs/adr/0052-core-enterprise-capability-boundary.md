# 0052 — Enforce the Core and Enterprise capability boundary

- Status: accepted
- Date: 2026-10-14
- Related: ADR 0038 (partially superseded: the plan boundary and Enterprise scope), ADR 0046
  (the completed capability inventory), ADR 0007 and ADR 0049 (IAM decisions remain unchanged),
  ADR 0041 (MCP authorization), ADR 0050 (only delivered capabilities may be presented as available)

## Context

The product described Core and Enterprise, but every tenant could reach the company-context and
IAM interfaces. The shell displayed a fixed Core badge. Customer Confidence could appear in a
Core meeting, and the executive overview had no distinct Enterprise entry point. A plan label
therefore did not tell a presenter or a user which capabilities were available.

The final demonstration needs a working individual flow and a separate company workspace. The
requested boundary is a product capability boundary, not a checkout, a new identity provider or a
claim that the full corporate package has been delivered.

## Decision

### 1. Plans and capabilities

`FREE` and `PRO` use the Core surface. `ENTERPRISE` enables the company workspace. The authenticated
`GET /auth/me` response provides the plan, Enterprise `capabilities` and shared-action
`permissions` used by the web application. `PATCH /users/me` returns the same access metadata after a
profile update. Clients must not infer entitlement from a badge, a route name or an IAM role.

Enterprise capabilities combine the plan with the caller's IAM access. Shared-action permissions
separately cover meeting creation/capture/update/reprocessing/removal, task editing, Flows,
integrations and workspace reading/renaming, as well as meeting/task reading. The UI uses these
server-supplied values to offer applicable controls. They do not replace authorization of each
requested resource; that remains an API responsibility.

| Shared by all plans | Enterprise only |
|---|---|
| Meeting capture, transcripts, summaries, decisions and action items | Executive overview across authorized meetings |
| Optional Productivity Score, projects, tasks and trends | Company context, products, competitors and context history |
| Chat grounded in authorized meetings, including semantic search/RAG | Customer Confidence for supported commercial meetings |
| Configured integrations, Flows and read-only MCP | User invitations, users, groups, policies, boundaries, policy simulator and audit |
| Account settings, authentication, tenant isolation and data protection controls | Company administration through the Enterprise workspace |

Tenant isolation is mandatory for Core as well as Enterprise. It is never an upgrade feature.
Semantic search/RAG supports the shared chat and is not removed from Core.

### 2. Separate navigation, shared design system

The web application keeps its existing typography, tokens and components. Enterprise capabilities
have these entry points:

- `/enterprise`: executive overview.
- `/enterprise/users`: company users and invitations.
- `/enterprise/access`: groups, policies, boundaries, simulator and audit.
- `/enterprise/company`: company context and its versions.

Core navigation, command-palette entries and meeting detail do not display Enterprise controls or
Customer Confidence. Core settings retain account, security and workspace settings. The old
`/overview` and `/settings/iam` addresses preserve access for entitled users by redirecting to the
corresponding Enterprise route; they do not grant an entitlement. Company context moves out of
the shared settings surface.

### 3. Enforce the boundary on the server

Hiding links is insufficient. The API verifies the tenant plan before Enterprise operations,
including direct calls to IAM, invitations and company-context endpoints. Customer Confidence
is withheld from Core responses and exports, including the MCP surface. Core analysis requests
explicitly disable its generation. Existing IAM checks still decide what an Enterprise user may
read or change; membership alone grants no administration rights.

The tenant Root bypasses IAM policy evaluation as before, but does not bypass the plan boundary.
Authorization and tenant isolation remain active on shared features in every plan. A denied call
must not be converted into an empty successful response that implies the capability was used.

### 4. Provisioning and remaining exclusions

Enterprise is provisioned by the project operator for the demonstration. No signup, existing
workspace or database migration automatically promotes a tenant. The interface reflects the
stored plan; it does not offer an activation button that silently changes it.

Billing, checkout, corporate SSO, aggregated Account Health, commercial Next Best Action, signed
DPA/SLA and production-scale guarantees remain outside this delivery. This decision does not
reopen ADR 0038's other closed items or its operations deferrals.

## Consequences

- Existing Enterprise capabilities remain available in a dedicated workspace, subject to plan
  and IAM authorization. Existing Core workspaces keep the individual meeting flow.
- The presentation must identify what is implemented and distinguish it from the excluded
  corporate package. It must not claim exclusive features or superiority without comparative
  evidence.
- Release validation must cover Core, Enterprise Root, Enterprise member and another tenant:
  visible navigation, direct routes, direct API calls, invitations, context editing, meeting
  detail, chat sources and task state. An Enterprise member denied IAM administration must still
  be able to use the shared features permitted by their policies.
- Historical accepted ADRs remain unchanged. This record supersedes their incompatible plan
  framing without rewriting their decisions about IAM, privacy or tenant isolation.

## Alternatives considered

1. **Only hide Enterprise links.** Rejected because direct requests and exports would still expose
   the capabilities, leaving the same product boundary unenforced.
2. **Give every existing tenant Enterprise for the presentation.** Rejected because it erases the
   Core flow and makes the two surfaces impossible to validate separately.
3. **Build billing or a second application.** Rejected because neither is required to separate
   capabilities, and both add a delivery surface outside the requested flow.
