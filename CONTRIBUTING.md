# Contributing to aptu-github-app

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (runtime, package manager, test runner)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare Workers CLI)
- Git with GPG signing configured

### Development Setup

```bash
git clone https://github.com/clouatre-labs/aptu-github-app.git
cd aptu-github-app
bun install
```

## Development Workflow

### Feature Branch Process

```bash
git checkout -b feat/your-feature-name
# implement, test, commit
git push -u origin feat/your-feature-name
```

### Commit Message Standards

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>: <description>
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`

## Local Quality Checks

Before opening a PR, run all checks locally:

```bash
# Lint and format
bun run biome check

# Type check
bun run tsc --noEmit

# Tests
bun test

# Worker dev server
bunx wrangler dev
```

## CI/CD Workflow

All pull requests run automated checks:

- **lint** -- Biome lint and format check
- **typecheck** -- TypeScript type check
- **test** -- Bun test suite
- **release** -- Release Please automation (triggered on merge to main)
- **ci-result** -- Aggregate gate; sole required status check

All checks must pass before merge.

## Releases & Versioning

There is **no release automation**. Releases are cut manually by maintainers from signed annotated tags on `main`. Write [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.) — the version increment follows the accumulated commit types since the last tag (`feat` → minor, `fix`/`chore`/`docs` → patch, breaking change → major).

### Maintainer Release Steps

1. Land all changes on `main` via PRs (including any pin bumps; see below)
2. Tag the release commit: `git tag -a -s vX.Y.Z -m "vX.Y.Z" <sha> && git push origin vX.Y.Z` — must be a GPG-signed annotated tag; a lightweight tag is not accepted
3. Create the GitHub release with curated notes:

   ```bash
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes "..."
   ```

   Notes follow the standard format: a `## What's Changed` bullet list of merged PRs (one per line, `* <title> by @<author> in <PR URL>`) followed by a `**Full Changelog**: <compare URL>` link (see [v0.1.4](https://github.com/clouatre-labs/aptu-github-app/releases/tag/v0.1.4) for a complete example)

### Pin Updates Around a Release

Workflows reference each other by commit SHA (never mutable tags). After a release:

- The dispatcher workflows (`aptu-*.yml`) pin the reusable workflows (`pr-review.yml`, `issue-triage.yml`, `scan-security.yml`) to the tagged release commit — repin them to the new tag's SHA in a follow-up PR (the `Verify Dispatcher Pins` check enforces that pins resolve to tagged commits)
- When a new `clouatre-labs/aptu` CLI version ships, bump the aptu action pin in `pr-review.yml` and `issue-triage.yml` to that release's tagged commit via a PR; the bump is included in the next app release

## Code Review

All pull requests are reviewed before merge, enforced by the branch ruleset on `main`.

Reviewer checklist:

- **Correctness**: logic is sound, edge cases handled, no regressions
- **Security**: HMAC validation present for all webhook paths; no `WEBHOOK_SECRET` or credentials in code; Wrangler bindings used for all secrets
- **Workflow Security**: workflow `uses:` refs and action pins use commit SHAs, not mutable tags (see CVE-2025-30066); no duplicated workflow YAML in Markdown (stale SHA pins); every step has a `name:` key
- **Conventions**: conventional commits, GPG + DCO sign-off, Biome clean
- **Documentation**: public functions documented; architectural changes update `docs/`

## Code Standards

### TypeScript / Cloudflare Workers Style

- Target ES2022 / Cloudflare Workers runtime
- Use `bunx wrangler build` to verify before pushing
- Secrets via Wrangler bindings only; never hardcoded
- Validate X-Hub-Signature-256 on every webhook request

### Security

- `WEBHOOK_SECRET` must never appear in committed files; use Wrangler secrets
- Validate HMAC signature before any processing of webhook payload
- No persistent storage of GitHub event payloads

### New Files

All new source files require SPDX license headers for REUSE compliance:

```typescript
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors
```

## Project Structure

```text
worker/           # Cloudflare Worker source (webhook proxy)
docs/             # Architecture and design documentation
.github/          # GitHub Actions workflows, templates, instructions
```

## Tagging Convention

Reusable workflow files (`pr-review.yml`, `issue-triage.yml`, `scan-security.yml`) are consumed by dispatcher workflows via SHA-pinned `uses:` references. Keeping those pins current requires a tag-and-bump convention:

- Cut an annotated semver tag (e.g. `git tag -a v0.2.0 -m "v0.2.0"`) on any merge to main that
  touches a reusable workflow file referenced by a dispatcher (`pr-review.yml`, `issue-triage.yml`, `scan-security.yml`).
- In the same or a prompt follow-up PR, bump the affected dispatcher workflow's (`aptu-review.yml`,
  `aptu-triage.yml`, `aptu-scan-security.yml`) `uses:` pin to `@<new-tag-SHA> # <new-tag>` -- both the SHA and comment must change together so the comment stays truthful.
- Tags matching `v*.*.*` are protected by a repository ruleset: creation, deletion, and
  re-pointing (force-move) are restricted to repository admins.
- This lets Renovate's github-actions manager track and bump the pin automatically when a newer
  tag is cut (requires the SHA+comment form -- a bare SHA is not tracked).

## Contribution Checklist

1. Check existing issues and PRs for similar work
2. Review ROADMAP.md for planned features
3. Discuss major changes in an issue first
4. Create feature branch from main
5. Implement changes following code standards
6. Add/update tests for new behavior
7. Update documentation as needed
8. Run quality checks locally (see above)
9. Commit with conventional messages (GPG-signed, DCO sign-off)
10. Push branch and open PR with clear title, description, and test plan

## Getting Help

- **Bug Reports**: open an issue with reproduction steps
- **Feature Requests**: check ROADMAP.md first, then open an issue
- **Security Issues**: report privately to hugues+aptu-github-app-security@linux.com

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behavior to hugues+aptu-github-app-coc@linux.com.
