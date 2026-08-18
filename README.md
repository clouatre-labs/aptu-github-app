# aptu-github-app

A Cloudflare Worker and GitHub Actions that automate issue triage and PR review for repositories
in the clouatre-labs org, powered by [aptu](https://aptu.dev). The Worker validates GitHub
webhook signatures, reads each repository's `.github/aptu.yml` opt-in config, and dispatches
`repository_dispatch` events to trigger aptu-powered triage and review workflows.

## Architecture

```
GitHub event (issues.opened / pull_request.opened|synchronize|reopened)
  -> Cloudflare Worker
       1. Verify X-Hub-Signature-256
       2. Get installation token (scoped to originating repo)
       3. Fetch .github/aptu.yml from originating repo
       4. Check ALLOWED_OWNERS allowlist -- 403 if not allowed
       5. Get dispatch token (scoped to TARGET_REPO)
       6. POST repository_dispatch to TARGET_REPO
  -> GitHub Actions workflow (actions/create-github-app-token, run aptu CLI)
  -> GitHub Reviews API (inline comments as aptu[bot])
```

The Worker is stateless: validate HMAC signature, fetch the target repo's `aptu.yml`, check
the allowlist, call `POST /repos/{owner}/{repo}/dispatches` if opted in, return 200. The
workflow handles all App authentication and aptu invocation. No persistent server required.

## Repository configuration

Each repository opts in to triage and review by adding a `.github/aptu.yml` file. The Worker
fetches this file on every webhook event; if the file is absent or invalid, no dispatch occurs.

### Schema

```yaml
version: 1                                        # required; must be 1

triage:
  enabled: true                                   # required if triage block present

review:
  enabled: true                                   # required if review block present
  instructions-file: .github/instructions/pr-review.md  # optional; path in the target repo
  paths:                                          # optional; suppress PR review when no file qualifies
    - "src/**"                                    # bare patterns are includes
    - "!src/data/**"                              # '!'-prefixed patterns are excludes

ai:
  provider: gemini                                # required if ai block present
  model: gemini-3.1-flash-lite                    # required if ai block present
  api-key-secret: GEMINI_API_KEY                  # required; name of GitHub Actions secret
```

All fields under `triage`, `review`, and `ai` are validated strictly: unknown keys are ignored,
but a missing `enabled` boolean causes the entire config to be rejected (no dispatch). All three
`ai` fields are required if the `ai` block is present; a partial or empty-string block is
rejected.

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | integer | -- | Config schema version. Must be `1`. |
| `triage.enabled` | boolean | -- | Dispatch `aptu-triage` on `issues.opened` events. |
| `review.enabled` | boolean | -- | Dispatch `aptu-review` on `pull_request` opened/synchronize/reopened events. |
| `review.instructions-file` | string | `.github/instructions/pr-review.md` | Path to PR review instructions file, relative to the target repo root. Passed to aptu as `--instructions-file`. |
| `review.skip-labeled` | boolean | `false` | Skip dispatch when the PR already carries a label. Passed to aptu as `--skip-labeled`. |
| `review.paths` | string[] | -- | Glob patterns (picomatch) evaluated against the full PR file list. Bare patterns are includes; `!`-prefixed patterns are excludes. A PR is dispatched if at least one file qualifies (matches an include when includes are present, and matches no exclude). If no file qualifies, the review dispatch is suppressed. |
| `ai.provider` | string | -- | AI provider name passed to aptu as `--provider`. Required if `ai` block present. |
| `ai.model` | string | -- | AI model name passed to aptu as `--model`. Required if `ai` block present. |
| `ai.api-key-secret` | string | -- | Name of a GitHub Actions secret in the caller's repository containing the API key. Required if `ai` block present. Must match `^[A-Z0-9_]+$`. |

### Minimal opt-in example

```yaml
version: 1
triage:
  enabled: true
review:
  enabled: true
  instructions-file: .github/instructions/pr-review.md
```

### External installation example

Repositories using the aptu GitHub App must include an `ai` block with a valid
`api-key-secret` pointing to a secret in the caller's own repository. The Worker
never has access to repository secrets; the workflow resolves the key dynamically
via `${{ secrets[github.event.client_payload.ai_key_secret] }}`.

```yaml
version: 1
triage:
  enabled: true
review:
  enabled: true
ai:
  provider: openai
  model: gpt-4o
  api-key-secret: OPENAI_API_KEY
```

## Deployment

### Worker deployment

Merging to `main` triggers `deploy.yml`, which deploys the Worker to Cloudflare via
`cloudflare/wrangler-action`. Required GitHub secrets and variables:

- `CLOUDFLARE_API_TOKEN` -- Cloudflare API token with Workers edit permission
- `CLOUDFLARE_ACCOUNT_ID` -- Cloudflare account ID (repository variable)
- `WEBHOOK_SECRET` -- Wrangler secret; must match the value configured in the GitHub App

Required Wrangler variables (set in `wrangler.toml` or via `bunx wrangler secret put`):

- `APP_ID` -- GitHub App ID
- `TARGET_REPO` -- `owner/repo` that receives `repository_dispatch` events (i.e., this repo)
- `ALLOWED_OWNERS` -- comma-separated list of GitHub account/org names (e.g., `clouatre-labs,clouatre`). Requests whose `repository.owner.login` (or `organization.login`) does not appear in this list are rejected with `403 Forbidden` before any event processing. This is a hard early gate; it is not a bypass for the `ai` block requirement.

### DNS prerequisite

The `wrangler.toml` configuration binds the Worker to the route `aptu.dev/webhook` using
the `routes` pattern. Cloudflare route bindings require a proxied DNS record for the zone
root to exist; without one the domain does not resolve and GitHub cannot deliver webhooks
(`ERR_NAME_NOT_RESOLVED`).

Add the following record in the Cloudflare dashboard under the `aptu.dev` zone before or
after the first deploy:

| Type | Name | Content | Proxied |
|------|------|---------|---------|
| AAAA | aptu.dev | `100::` | Yes |

`100::` is the [Cloudflare-documented placeholder](https://developers.cloudflare.com/workers/configuration/routing/routes/)
for route-based Workers with no real origin. The address is never contacted; Cloudflare
intercepts all proxied requests and the Worker route handles `/webhook` before any origin
is reached.

Note: `custom_domain = true` in `wrangler.toml` would have Cloudflare manage DNS
automatically, but it binds the Worker to the entire domain. Because only `/webhook` is
intercepted, the `routes` + `AAAA 100::` pattern is correct.

### App credentials

See [clouatre-labs/aptu#94](https://github.com/clouatre-labs/aptu/issues/94) for GitHub
App registration and credential setup.

### Operator procedures

See [RUNBOOK.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/RUNBOOK.md)
for post-deploy steps, secret rotation, and incident response.

## Releases

Merging to `main` triggers [Release Please](https://github.com/googleapis/release-please-action)
to create GitHub Releases automatically from [Conventional Commits](https://www.conventionalcommits.org/).
No manual version bump is required. Each release generates a changelog entry and a tagged
GitHub Release. See the [Releases & Versioning](https://github.com/clouatre-labs/aptu-github-app/blob/main/CONTRIBUTING.md#releases--versioning)
section of CONTRIBUTING.md for details.

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
