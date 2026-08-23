# aptu-github-app

A Cloudflare Worker and GitHub Actions that automate issue triage and PR review for any
repository with the aptu GitHub App installed, powered by [aptu](https://aptu.dev). The Worker
validates GitHub webhook signatures, reads each repository's `.github/aptu.yml` opt-in config,
and dispatches `repository_dispatch` events to the originating repository to trigger
aptu-powered triage, review, and security scan workflows via reusable workflows.

## Architecture

```text
GitHub event (issues.opened / pull_request.opened|synchronize|reopened|ready_for_review
              / issue_comment.created / pull_request_review_comment.created)
  -> Cloudflare Worker
       1. Verify X-Hub-Signature-256 (HMAC)
       2. Deduplicate by X-GitHub-Delivery (ReplayGuard Durable Object)
       3. Validate source IP against GitHub /meta hook CIDRs (fail-open)
       4. Get installation token (scoped to originating repo)
       5. Fetch .github/aptu.yml from originating repo
       6. Check per-installation quota (enforced for all installations)
       7. For PRs: skip draft PRs; evaluate review.paths filters
       8. Get dispatch token (scoped to originating repo)
       9. POST repository_dispatch to originating repo
  -> Caller's .github/workflows/aptu.yml (repository_dispatch handler)
       -> Calls reusable workflow from aptu-github-app repo
            -> Checkout caller repo, run aptu CLI with caller's AI API key
  -> GitHub Reviews API (inline comments as github-actions[bot])
```

The Worker uses two Durable Objects: `InstallationQuota` for per-installation rate limiting
(50 events per event type per 24h rolling window, enforced for all installations), and
`ReplayGuard` for webhook deduplication. No external database is required.

### Mention commands

Commenting `@aptu` on an issue or PR review comment triggers triage or review respectively.
The commenter must be a collaborator with at least read permission on the repository.

## Repository configuration

Each repository opts in by adding a `.github/aptu.yml` file. The Worker fetches this file on
every webhook event; if the file is absent or invalid, no dispatch occurs.

### Schema

```yaml
version: 1                                        # required; must be 1

triage:
  enabled: true                                   # required if triage block present

review:
  enabled: true                                   # required if review block present
  instructions-file: .github/instructions/pr-review.md  # optional; path in the target repo
  skip-labeled: false                             # optional; aptu skips review if PR has a label
  paths:                                          # optional; suppress PR review when no file qualifies
    - "src/**"                                    # bare patterns are includes
    - "!src/data/**"                              # '!'-prefixed patterns are excludes

scan:
  enabled: true                                   # required if scan block present
  fail-on: critical,high                          # optional: comma-separated severities that fail the scan
  path: src/                                      # optional: root directory to scan (default ".")

ai:
  provider: openrouter                            # required if ai block present
  model: google/gemma-4-26b-a4b-it                # required if ai block present
```

### Scan configuration

The `scan` block enables aptu's local pattern-based security scanning. Scan runs without an AI
provider -- no `ai` block is required. Results are uploaded as SARIF code scanning alerts to the
originating repository. `fail-on` takes a comma-separated list of severities (`critical`, `high`,
`medium`, `low`); the scan fails only if a finding matches one of the listed severities. Omitting
`fail-on` reports findings without failing the check.

### Field reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | integer | -- | Config schema version. Must be `1`. |
| `triage.enabled` | boolean | -- | Dispatch `aptu-triage` on `issues.opened` events. |
| `review.enabled` | boolean | -- | Dispatch `aptu-review` on `pull_request` opened/synchronize/reopened/ready_for_review events. |
| `review.instructions-file` | string | `.github/instructions/pr-review.md` | Path to PR review instructions file, relative to the target repo root. Passed to aptu as `--instructions-file`. |
| `review.skip-labeled` | boolean | `false` | Passed to aptu as `--skip-labeled`. When true, aptu skips review if the PR already carries a label. |
| `review.paths` | string[] | -- | Glob patterns (picomatch) evaluated against the full PR file list. Bare patterns are includes; `!`-prefixed patterns are excludes. A PR is dispatched if at least one file qualifies. If no file qualifies, the review dispatch is suppressed. |
| `ai.provider` | string | -- | AI provider name passed to aptu as `--provider`. Supported: `gemini`, `anthropic`, `openrouter`. Required if `ai` block present. |
| `ai.model` | string | -- | AI model name passed to aptu as `--model`. Required if `ai` block present. |
| `scan.enabled` | boolean | `false` | Enable aptu scan-security on pull requests. Runs local pattern-based secret scanning and uploads SARIF results to GitHub Code Scanning. No `ai` block required. |
| `scan.fail-on` | string | -- | Comma-separated severities that fail the scan (`critical`, `high`, `medium`, `low`). Omit to report findings without failing the check. |
| `scan.path` | string | `.` | Root directory to scan. |

All fields under `triage`, `review`, `scan`, and `ai` are validated strictly: unknown keys are
ignored, but a missing `enabled` boolean causes the entire config to be rejected (no dispatch).
Both `ai` fields (`provider` and `model`) are required if the `ai` block is present; a partial
or empty-string block is rejected.

### Minimal opt-in example

```yaml
version: 1
triage:
  enabled: true
review:
  enabled: true
```

### External installation example

Each installation provides its own AI API key via a GitHub repository secret in the caller's
repo. The caller installs `.github/workflows/aptu.yml` (see [Installation](#installation))
which receives `repository_dispatch` events and calls reusable workflows from the
`clouatre-labs/aptu-github-app` repository. The reusable workflow runs in the caller's context,
using the caller's `GITHUB_TOKEN` for repository operations and the caller's AI API key secret
for AI provider calls. This is the BYOK (bring your own key) model: the operator's AI keys are
never exposed to any installation.

```yaml
version: 1
triage:
  enabled: true
review:
  enabled: true
ai:
  provider: openrouter
  model: google/gemma-4-26b-a4b-it
```

## Installation

Each repository that uses the aptu GitHub App must install two files:

1. `.github/aptu.yml` -- opt-in configuration (see [Repository configuration](#repository-configuration) above)
2. `.github/workflows/aptu.yml` -- dispatch handler that calls reusable workflows

The dispatch handler receives `repository_dispatch` events from the Worker and calls the
appropriate reusable workflow hosted in `clouatre-labs/aptu-github-app`. The caller's AI API
key secret is passed to the reusable workflow via the `secrets:` block.

Create a repository secret (e.g., `APTU_AI_API_KEY`) with your AI provider's API key, then
add the following workflow file:

```yaml
# .github/workflows/aptu.yml
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

name: Aptu Dispatch Handler

on:
  repository_dispatch:
    types:
      - aptu-review
      - aptu-triage
      - aptu-scan-security

permissions:
  contents: read
  pull-requests: write
  issues: write
  security-events: write
  statuses: write

jobs:
  review:
    name: Review PR
    if: github.event.action == 'aptu-review'
    uses: clouatre-labs/aptu-github-app/.github/workflows/pr-review.yml@main
    with:
      originating_repo: ${{ github.event.client_payload.originating_repo }}
      pull_number: ${{ github.event.client_payload.pull_number }}
      instructions_file: ${{ github.event.client_payload.instructions_file || '.github/instructions/pr-review.md' }}
      skip_labeled: ${{ github.event.client_payload.skip_labeled || false }}
      ai_provider: ${{ github.event.client_payload.ai_provider || 'openrouter' }}
      ai_model: ${{ github.event.client_payload.ai_model || 'google/gemma-4-26b-a4b-it' }}
    secrets:
      ai-api-key: ${{ secrets.APTU_AI_API_KEY }}

  triage:
    name: Triage Issue
    if: github.event.action == 'aptu-triage'
    uses: clouatre-labs/aptu-github-app/.github/workflows/issue-triage.yml@main
    with:
      originating_repo: ${{ github.event.client_payload.originating_repo }}
      issue_number: ${{ github.event.client_payload.issue_number }}
      ai_provider: ${{ github.event.client_payload.ai_provider || 'openrouter' }}
      ai_model: ${{ github.event.client_payload.ai_model || 'google/gemma-4-26b-a4b-it' }}
    secrets:
      ai-api-key: ${{ secrets.APTU_AI_API_KEY }}

  scan:
    name: Scan Security
    if: github.event.action == 'aptu-scan-security'
    uses: clouatre-labs/aptu-github-app/.github/workflows/scan-security.yml@main
    with:
      originating_repo: ${{ github.event.client_payload.originating_repo }}
      head_sha: ${{ github.event.client_payload.head_sha }}
      pull_number: ${{ github.event.client_payload.pull_number }}
      scan_path: ${{ github.event.client_payload.scan_path || '.' }}
      fail_on: ${{ github.event.client_payload.fail_on || '' }}
```

Replace `APTU_AI_API_KEY` with the name of your repository secret that holds your AI provider
API key. The same secret is passed to all provider inputs (anthropic, gemini, openrouter);
the aptu action selects the correct one based on the `provider` field.

## Deployment

### Worker deployment

Merging to `main` triggers `deploy.yml`, which deploys the Worker to Cloudflare via
`bunx wrangler deploy`.

GitHub secrets and variables:

- `CLOUDFLARE_API_TOKEN` -- Cloudflare API token with Workers edit permission
- `CLOUDFLARE_ACCOUNT_ID` -- Cloudflare account ID (repository variable)
- `APP_ID` -- GitHub App ID (repository variable, required for Worker to mint installation tokens)
- `APP_PRIVATE_KEY` -- GitHub App private key in PKCS#8 PEM format (repository secret, required for Worker)

AI API keys are configured per installation in the caller's repository, not in `aptu-github-app`.
Each caller creates a repository secret (e.g., `APTU_AI_API_KEY`) and references it in their
`.github/workflows/aptu.yml` dispatch handler.

Wrangler secrets (set via `bunx wrangler secret put`):

- `WEBHOOK_SECRET` -- must match the value configured in the GitHub App
- `APP_PRIVATE_KEY` -- GitHub App private key in PKCS#8 PEM format

Wrangler variables (in `wrangler.toml` `[vars]`):

- `APP_ID` -- GitHub App ID
- `APTU_BOT_ID` -- aptu bot user ID (used to ignore self-mentions)
- `SENTRY_DSN` -- Sentry DSN for error tracking (optional; set via `bunx wrangler secret put`)

### DNS prerequisite

The Worker is bound to the route `aptu.dev/webhook` via `wrangler.toml`. Cloudflare route
bindings require a proxied DNS record for the zone root:

| Type | Name | Content | Proxied |
| --- | --- | --- | --- |
| AAAA | aptu.dev | `100::` | Yes |

`100::` is the [Cloudflare-documented placeholder](https://developers.cloudflare.com/workers/configuration/routing/routes/)
for route-based Workers with no real origin.

### App credentials

See [clouatre-labs/aptu#94](https://github.com/clouatre-labs/aptu/issues/94) for GitHub App
registration and credential setup.

### Operator procedures

See [RUNBOOK.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/RUNBOOK.md)
for post-deploy steps, secret rotation, and incident response.

## Releases

Merging to `main` triggers [Release Please](https://github.com/googleapis/release-please-action)
to create GitHub Releases automatically from [Conventional Commits](https://www.conventionalcommits.org/).
See [CONTRIBUTING.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/CONTRIBUTING.md#releases--versioning)
for details.

## Development

**Prerequisites:** [Bun](https://bun.sh/), [Wrangler](https://developers.cloudflare.com/workers/wrangler/)

```bash
bun install
bun test
bun run biome check
bunx wrangler dev
```

## License

Apache-2.0. See [LICENSE](LICENSE).
