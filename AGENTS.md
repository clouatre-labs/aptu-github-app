<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->

# aptu-github-app

## Purpose

Cloudflare Worker and GitHub Actions that automate issue triage and PR review for
repositories in the `clouatre-labs` org, powered by aptu.

## Architecture

A single Cloudflare Worker validates GitHub webhook HMAC signatures and dispatches
`repository_dispatch` events. GitHub Actions workflows handle App authentication and
invoke the aptu CLI for triage and reviews. The Worker is stateless: validate signature,
dispatch, return 200.

## Key Files

- `worker/` -- Cloudflare Worker source
- `worker/src/worker.ts` -- Webhook handler (HMAC validation, dispatch)
- `worker/src/worker.test.ts` -- Worker test suite
- `worker/wrangler.jsonc` -- Worker configuration (secrets, routes)
- `.github/workflows/` -- CI, deploy, issue-triage, pr-review, release workflows
- `.github/workflows/ci.yml` -- Lint, typecheck, test, ci-result
- `.github/workflows/deploy.yml` -- Deploy Worker to Cloudflare
- `.github/workflows/issue-triage.yml` -- aptu-powered issue triage
- `.github/workflows/pr-review.yml` -- aptu-powered PR review
- `.github/workflows/release.yml` -- Release Please automation
- `docs/` -- Architecture and design documentation

## Tooling

- **Runtime**: Bun
- **Worker deployment**: Wrangler
- **Linter/Formatter**: Biome (`bun run biome check`)
- **Tests**: Vitest via Bun (`bun test`)

## Commit Standards

Conventional commits enforced by commitlint:

```
<type>: <description>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`

All commits must be GPG-signed with DCO sign-off (`git commit -S --signoff`).

## Continuous Delivery Model

- **Deploy**: Merging to `main` triggers `deploy.yml`, which deploys the Worker to
  Cloudflare via `cloudflare/wrangler-action`.
- **Release**: Merging to `main` triggers `release.yml`, which runs
  `googleapis/release-please-action` to create GitHub Releases from conventional commits.
  Release Please opens a Release PR on main; merging it auto-bumps the version and creates
  a GitHub Release with a generated changelog.

## Secrets Model

- `WEBHOOK_SECRET` -- Wrangler secret; never hardcoded
- `CLOUDFLARE_API_TOKEN` -- GitHub Action secret for wrangler deploy
- `CLOUDFLARE_ACCOUNT_ID` -- GitHub Action variable
- App private key and ID -- installed via `actions/create-github-app-token` in workflows
- No secrets in committed files; SPDX headers on all source files

## SPDX Headers

All new source files must include SPDX license headers for REUSE compliance:

**Markdown:**
```html
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->
```

**YAML:**
```yaml
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 aptu-github-app Contributors
```

**TypeScript:**
```typescript
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors
```

## Test Conventions

- Vitest test runner via `bun test`
- Tests live in `worker/src/*.test.ts`
- Run `bun test` before opening pull requests
- All checks must pass before merge (enforced by branch ruleset)