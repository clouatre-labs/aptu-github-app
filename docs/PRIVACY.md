# Privacy Policy

## Purpose

aptu-github-app is a hosted automation service: a Cloudflare Worker plus a set of
GitHub Actions reusable workflows that bring AI-assisted issue triage, PR review,
and security scanning to any repository with the `aptu-dev` GitHub App installed.
This document describes what data the service processes, who it is shared with,
how long it is retained, and how to exercise data-subject rights. It complements
[SECURITY.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/SECURITY.md)
(vulnerability disclosure and attack surface) and
[ARCHITECTURE.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/ARCHITECTURE.md)
(system design and data flow), and does not restate their content.

## Data Categories Collected

The Worker and its downstream workflows process the following categories of data
as part of normal operation:

- **GitHub event payloads** -- issue, pull request, and comment webhook bodies,
  including author usernames, comment and issue/PR text, timestamps, and
  repository metadata.
- **Personal data embedded in caller content** -- commit author names and email
  addresses, commenter and reviewer identities, and any personal data a caller
  has embedded in source code, diffs, issue text, or PR review instructions.
- **Technical metadata** -- source IP address (`CF-Connecting-IP`, validated
  against GitHub's published webhook IP ranges), webhook delivery IDs, and
  installation IDs.
- **Repository configuration** -- the `.github/aptu.yml` opt-in file, including
  the caller's chosen AI provider and model.
- **Aggregate, anonymized telemetry** (opt-in only) -- counters such as
  `reviews_total` and `truncation_events_total` with no repo, PR, or actor
  identifiers; see `telemetry.enabled` in
  [README.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/README.md#repository-configuration).

The Worker itself never persists webhook payload content; it is stateless
beyond the Durable Object counters described under
[Retention by Data Store](#retention-by-data-store).

## Processing Purposes

Data is processed only to operate the service: validating webhook authenticity,
enforcing per-installation quota, resolving repository configuration, minting
scoped GitHub tokens, dispatching automation workflows, and (where a caller has
configured an `ai` block) forwarding review or triage content to the caller's
chosen AI provider for analysis. No data is used for advertising, profiling, or
sold to third parties.

## Recipients / Subprocessors

| Recipient | Purpose | Processing basis |
| --- | --- | --- |
| GitHub | Hosts the App installation, webhook delivery, Actions runners, and the caller's repository (source of truth for all processed content) | Necessary to provide the service; caller's own GitHub account relationship |
| Cloudflare | Runs the stateless Worker at the edge and the Durable Objects listed under [Retention by Data Store](#retention-by-data-store) | Necessary to provide the service (webhook receipt, quota, replay protection, telemetry) |
| OpenRouter (and its upstream model providers) | Default AI routing target when a caller selects `ai.provider: openrouter`; may route to third-party model providers behind OpenRouter | Caller's explicit opt-in via `.github/aptu.yml`; BYOK -- caller's own API key |
| Anthropic | AI provider when a caller selects `ai.provider: anthropic` | Caller's explicit opt-in via `.github/aptu.yml`; BYOK -- caller's own API key |
| Gemini (Google) | AI provider when a caller selects `ai.provider: gemini` | Caller's explicit opt-in via `.github/aptu.yml`; BYOK -- caller's own API key |
| Sentry | Worker exception capture for operational error tracking | Necessary to operate and maintain the service; not yet active (see [Data Residency](#data-residency)) |

No AI provider is contacted unless a caller has configured an `ai` block in
their own `.github/aptu.yml`; `scan` runs local pattern-based scanning with no
AI provider involved.

## BYOK Secret Model

The service uses a bring-your-own-key (BYOK) model: the operator never holds or
transmits a caller's AI provider credentials. A caller sets `ai.provider` in
their own `.github/aptu.yml` (`anthropic`, `gemini`, or `openrouter`); the
caller's own dispatch handler workflow then resolves one of three fixed
repository secret names -- `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or
`OPENROUTER_API_KEY` -- from the caller's own repository, and passes it to the
reusable workflow via the `secrets:` block. The default model when `ai.provider`
is unset is `openrouter` / `google/gemma-4-26b-a4b-it`, with `openrouter` /
`inception/mercury-2` as the fallback. See
[ARCHITECTURE.md's Caller-Supplied AI Keys section](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/ARCHITECTURE.md#caller-supplied-ai-keys-byok)
for the full mechanism.

## Content Minimization

The `pr-review.yml` reusable workflow bounds how much caller content reaches an
AI provider: `max-prompt-chars: '200000'` and `max-full-content-files: '0'`
(no full-file content is sent by default; only diffs). Redaction of sensitive
content, SARIF content policy, and OpenRouter zero-data-retention (ZDR)
provider controls are implemented and documented upstream in
[clouatre-labs/aptu#1494](https://github.com/clouatre-labs/aptu/issues/1494)
and
[clouatre-labs/aptu PR #1495](https://github.com/clouatre-labs/aptu/pull/1495);
this document does not restate that implementation detail.

## Retention by Data Store

| Data store | Retention | Notes |
| --- | --- | --- |
| GitHub Actions workflow logs | Governed by the org/repo GitHub Actions log retention setting; currently the 90-day GitHub default, with no documented override in this repository | Revisit before GitHub's 2026-10-01 retention-scope unification; see [issue #138](https://github.com/clouatre-labs/aptu-github-app/issues/138) |
| SARIF scan artifact | 30 days | Set via `retention-days: 30` on the `findings-sarif` artifact in `scan-security.yml`; the SARIF result itself is uploaded to the caller's own GitHub Code Scanning, governed by the caller's repository settings |
| `InstallationQuota` Durable Object | Rolling 24-hour window per installation/event-type counter | Timestamps older than 24 hours are pruned on each request |
| `ReplayGuard` Durable Object | 300-second delivery-ID TTL | Deduplicates `X-GitHub-Delivery` IDs; expires after 300 seconds of inactivity |
| `TelemetryRollup` Durable Object | Indefinite, aggregate-only | Stores a single global aggregate of anonymized, opt-in counters with no repo, PR, or actor identifiers |
| `TelemetryRateLimit` Durable Object | Rolling window, per-IP | Bounds unauthenticated telemetry POST volume |
| OpenRouter (provider-side) | Zero-data-retention (`zdr`/`deny`) per [clouatre-labs/aptu#1494](https://github.com/clouatre-labs/aptu/issues/1494) | Applies when a caller routes through OpenRouter |
| Anthropic / Gemini (provider-side) | Not documented at this project's account tier | Open item; flagged rather than assumed |

## Data Residency

- No Cloudflare Regional Services or Data Localization Suite is configured; the
  Worker and its Durable Objects run on Cloudflare's global edge network with no
  region pinning.
- No AI provider is called through a region-pinned endpoint; OpenRouter,
  Anthropic, and Gemini requests route according to each provider's own
  infrastructure and the caller's selected provider/model.
- GitHub-hosted Actions runners (`ubuntu-24.04-arm`) do not guarantee a
  processing region; GitHub does not expose a region-selectable runner label
  for this workflow.
- Sentry error-tracking processing region is undocumented; `SENTRY_DSN` is not
  yet provisioned in `worker/wrangler.toml` (Sentry integration is wired in
  code via `@sentry/cloudflare` but inactive in production until a DSN is set).

See the
[Processing Locations table in ARCHITECTURE.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/ARCHITECTURE.md#processing-locations)
for the corresponding component-by-component breakdown.

## Data Subject Rights

Individuals whose personal data appears in GitHub event content processed by
this service (for example, as a commit author, commenter, or reviewer) may
request access to, correction of, or deletion of that data by contacting the
address under [Contact](#contact). Because the underlying data originates from
and is stored in the caller's own GitHub repository, most such requests are
best directed to the caller (repository owner) in the first instance; this
project holds no independent copy of caller repository content once a webhook
request completes processing.

## Breach Notification

Suspected or confirmed breaches involving this service's Worker, Durable
Objects, or GitHub App credentials are reported following the same process as
[SECURITY.md's vulnerability disclosure process](https://github.com/clouatre-labs/aptu-github-app/blob/main/SECURITY.md#reporting-a-vulnerability):
initial response within 48 hours, status updates within 5 business days, and a
fix timeline scaled to severity. Affected installations are notified directly
where contact information is available once the scope of a confirmed breach is
established.

## Vendor / Subprocessor Monitoring

Subprocessors listed under [Recipients / Subprocessors](#recipients--subprocessors)
are reviewed whenever this document is updated, and whenever a new
subprocessor (such as Sentry, once `SENTRY_DSN` is provisioned) begins
processing data on this project's behalf. Renovate-managed dependency updates
and the periodic architecture audits under
[docs/audit/](https://github.com/clouatre-labs/aptu-github-app/tree/main/docs/audit)
serve as the review cadence; there is no separate formal vendor-audit schedule
at this project's current scale.

## Contact

For privacy concerns: hugues+aptu-github-app-security@linux.com
For general questions: open a GitHub issue
