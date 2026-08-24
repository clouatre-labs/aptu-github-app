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

```
<type>: <description>
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`

### Commit Signing and DCO

All commits must be GPG-signed with DCO sign-off. Use:

```bash
git commit -S --signoff
```

This triggers local githooks (`pre-commit`, `commit-msg`) that enforce signing key validation, email identity, conventional commit format, and DCO trailer matching your git identity.

**Never use `gh api` to create commits.** The GitHub Contents API (`PUT /repos/.../contents/`), Git Commits API (`POST /repos/.../git/commits`), and GraphQL `createCommitOnBranch` create commits server-side. These commits bypass local githooks, GPG signing, and gitconfig identity. They are always unsigned and carry GitHub's noreply email as committer, failing DCO. Always clone locally and use `git commit -S --signoff`.

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

This project uses [Release Please](https://github.com/googleapis/release-please-action) to
automate version management and changelog generation from [Conventional Commits](https://www.conventionalcommits.org/).

### How It Works

1. Every merge to `main` triggers the `release.yml` workflow
2. Release Please scans new commits for conventional commit types (`feat`, `fix`, `docs`, etc.)
3. It opens or updates a **Release PR** that bumps the version and generates a changelog
4. Merging the Release PR creates a tagged GitHub Release and updates the manifest

### Important: GITHUB_TOKEN Limitation

Release Please runs using the default `GITHUB_TOKEN`. GitHub Actions workflows triggered by
`GITHUB_TOKEN` do **not** trigger other workflows (this prevents recursive CI loops). This means
CI checks (lint, typecheck, test) do **not** run on Release Please PRs.

This is expected behaviour. Contributors should never bump versions manually or merge Release
PRs with failing status checks (the check is a formality and will always be pending, not
failing).

### What Contributors Need to Know

- Write conventional commit messages (`feat:`, `fix:`, `docs:`, etc.)
- Do **not** manually edit version numbers in `package.json`, `wrangler.jsonc`, or any manifest
- Do **not** manually create GitHub Releases
- The Release PR can be merged as soon as it appears; the changelog is generated automatically

## Code Review

All pull requests are reviewed before merge, enforced by the branch ruleset on `main`.

Reviewer checklist:

- **Correctness**: logic is sound, edge cases handled, no regressions
- **Security**: HMAC validation present for all webhook paths; no `WEBHOOK_SECRET` or credentials in code; Wrangler bindings used for all secrets
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

```
worker/           # Cloudflare Worker source (webhook proxy)
docs/             # Architecture and design documentation
.github/          # GitHub Actions workflows, templates, instructions
```

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

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
Report unacceptable behavior to hugues+aptu-github-app-coc@linux.com.