# aptu-github-app

## Purpose

Cloudflare Worker and GitHub Actions that automate issue triage and PR review for repositories in the `clouatre-labs` org, powered by aptu.

## Architecture

A single Cloudflare Worker validates GitHub webhook HMAC signatures and dispatches `repository_dispatch` events. GitHub Actions workflows handle App authentication and invoke the aptu CLI for triage and reviews. The Worker is stateless: validate signature, dispatch, return 200.

## Key Files

- `worker/` -- Cloudflare Worker source
- `worker/src/worker.ts` -- Webhook handler (HMAC validation, dispatch)
- `worker/src/worker.test.ts` -- Worker test suite
- `worker/wrangler.jsonc` -- Worker configuration (secrets, routes)
- `.github/workflows/` -- CI, deploy, issue-triage, pr-review workflows
- `.github/workflows/ci.yml` -- Lint, typecheck, test, ci-result
- `.github/workflows/deploy.yml` -- Deploy Worker to Cloudflare
- `.github/workflows/issue-triage.yml` -- aptu-powered issue triage
- `.github/workflows/pr-review.yml` -- aptu-powered PR review
- `.github/workflows/scan-security.yml` -- Security scanning workflow
- `.github/workflows/aptu-review.yml` -- aptu review dispatch handler
- `.github/workflows/aptu-triage.yml` -- aptu triage dispatch handler
- `.github/workflows/aptu-scan-security.yml` -- aptu scan dispatch handler
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
  Cloudflare via `bunx wrangler deploy`.
- **Release**: No release automation. Releases are cut manually: `git tag -s vX.Y.Z <sha> -m "vX.Y.Z"`,
  `git push origin vX.Y.Z`, then `gh release create vX.Y.Z --target <sha> --generate-notes`. Bump
  version per conventional-commit types accumulated since the last tag (`feat` -> minor, `fix`/`chore`/`docs` -> patch, breaking change -> major).

## Secrets Model

- `WEBHOOK_SECRET` -- Wrangler secret; never hardcoded
- `CLOUDFLARE_API_TOKEN` -- GitHub Action secret for wrangler deploy
- `CLOUDFLARE_ACCOUNT_ID` -- GitHub Action variable
- App private key and ID -- installed via `actions/create-github-app-token` in workflows
- No secrets in committed files; SPDX headers on all TypeScript and YAML source files

## Workflow Security

- Reusable workflow `uses:` refs and action pins must use commit SHAs, not mutable tags (see CVE-2025-30066)
- Every workflow step must have a `name:` key for readable CI logs
- Do not duplicate workflow YAML in Markdown files; link to the source file instead (Renovate cannot update SHA pins in Markdown)
- Renovate manages SHA pin updates via `matchManagers: ["github-actions"]`

## SPDX Headers

REUSE compliance is managed via `REUSE.toml`. Inline headers are required only for TypeScript and YAML files. Markdown files are covered by the `**.md` annotation in `REUSE.toml` -- do not add `<!-- SPDX-... -->` comments to `.md` files.

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

## Markdown Links

Always use absolute URLs in Markdown files (e.g., `https://github.com/clouatre-labs/aptu-github-app/blob/main/CONTRIBUTING.md#section`). Relative links break when files are rendered outside the repository root (GitHub release notes, forks, mirrored docs).

## Diagrams

- Mermaid diagrams use `graph TD` only, no `classDef`/`linkStyle`, node labels 1-3 words, no `<br/>`
- Load-bearing detail (event names, endpoints, field names) belongs in edge labels or prose, not multi-line node labels

## Test Conventions

- Vitest test runner via `bun test`
- Tests live in `worker/src/*.test.ts`
- Run `bun test` before opening pull requests
- All checks must pass before merge (enforced by branch ruleset)
