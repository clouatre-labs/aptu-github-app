# aptu-github-app

A Cloudflare Worker and GitHub Actions that automate issue triage and PR review for repositories
in the clouatre-labs org, powered by [aptu](https://aptu.dev). The Worker validates GitHub
webhook signatures, reads each repository's `.github/aptu.yml` opt-in config, and dispatches
`repository_dispatch` events to trigger aptu-powered triage, review, and security scan workflows.

## Architecture

```text
GitHub event (issues.opened / pull_request.opened|synchronize|reopened|ready_for_review
              / issue_comment.created / pull_request_review_comment.created)
  -> Cloudflare Worker
       1. Verify X-Hub-Signature-256 (HMAC)
       2. Deduplicate by X-GitHub-Delivery (ReplayGuard Durable Object)
       3. Validate source IP against GitHub /meta hook CIDRs (fail-open)
       4. Check ALLOWED_OWNERS allowlist -- 403 if not allowed
       5. Get installation token (scoped to originating repo)
       6. Fetch .github/aptu.yml from originating repo
       7. Check per-installation quota (skipped if ai block present)
       8. For PRs: skip draft PRs; evaluate review.paths filters
       9. Get dispatch token (scoped to TARGET_REPO)
      10. POST repository_dispatch to TARGET_REPO
  -> GitHub Actions workflow (actions/create-github-app-token, run aptu CLI)
  -> GitHub Reviews API (inline comments as aptu[bot])
```

The Worker uses two Durable Objects: `InstallationQuota` for per-installation rate limiting
(bypassed when a repo provides its own AI key), and `ReplayGuard` for webhook deduplication.
No external database is required.

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
| `ai.api-key-secret` | string | -- | Name of the GitHub repository secret in `aptu-github-app` that holds the AI provider API key. Must match `^[A-Z0-9_]+$`. Required if `ai` block present. This is the BYOK (bring your own key) model: each installation specifies which org-level secret to use. |
| `scan.enabled` | boolean | `false` | Enable aptu scan-security on pull requests. Runs local pattern-based secret scanning and uploads SARIF results to GitHub Code Scanning. No `ai` block required. |
| `scan.fail-on` | string | -- | Comma-separated severities that fail the scan (`critical`, `high`, `medium`, `low`). Omit to report findings without failing the check. |
| `scan.path` | string | `.` | Root directory to scan. |

All fields under `triage`, `review`, `scan`, and `ai` are validated strictly: unknown keys are
ignored, but a missing `enabled` boolean causes the entire config to be rejected (no dispatch).
All three `ai` fields (`provider`, `model`, and `api-key-secret`) are required if the `ai` block is present; a partial
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

Repositories using the aptu GitHub App may configure custom AI models via the `ai` block.
Each installation specifies which API key secret to use via `ai.api-key-secret`. The Worker
passes the secret name (not the value) in the dispatch payload, and the workflow resolves it
against the `aptu-github-app` repository secrets. This is the BYOK (bring your own key) model:
the caller controls which secret is used, and the secret value never passes through the webhook.

```yaml
version: 1
triage:
  enabled: true
review:
  enabled: true
ai:
  provider: openrouter
  model: google/gemma-4-26b-a4b-it
  api-key-secret: OPENROUTER_API_KEY
```

## Deployment

### Worker deployment

Merging to `main` triggers `deploy.yml`, which deploys the Worker to Cloudflare via
`bunx wrangler deploy`.

GitHub secrets and variables:

- `CLOUDFLARE_API_TOKEN` -- Cloudflare API token with Workers edit permission
- `CLOUDFLARE_ACCOUNT_ID` -- Cloudflare account ID (repository variable)
- `APP_ID` -- GitHub App ID (repository variable, required for workflows to mint scoped tokens)
- `APP_PRIVATE_KEY` -- GitHub App private key in PKCS#8 PEM format (repository secret, required for workflows)

AI API key secrets are configured per installation via `ai.api-key-secret` in `.github/aptu.yml`.
The named secret must exist in the `aptu-github-app` repository. For example, if a repo sets
`api-key-secret: OPENROUTER_API_KEY`, then `OPENROUTER_API_KEY` must be created as a repository
secret in `aptu-github-app`.

Wrangler secrets (set via `bunx wrangler secret put`):

- `WEBHOOK_SECRET` -- must match the value configured in the GitHub App
- `APP_PRIVATE_KEY` -- GitHub App private key in PKCS#8 PEM format

Wrangler variables (in `wrangler.toml` `[vars]`):

- `APP_ID` -- GitHub App ID
- `TARGET_REPO` -- `owner/repo` that receives `repository_dispatch` events (i.e., this repo)
- `APTU_BOT_ID` -- aptu bot user ID (used to ignore self-mentions)
- `ALLOWED_OWNERS` -- comma-separated GitHub account/org names (e.g., `clouatre-labs,clouatre`).
  Requests whose `repository.owner.login` does not appear in this list are rejected with `403`.
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
