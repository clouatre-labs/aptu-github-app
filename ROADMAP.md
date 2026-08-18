<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->

# Roadmap

Ideas and direction for aptu-github-app. Not a commitment schedule.

## Core Principle

Provide a stateless Cloudflare Worker that validates GitHub webhook signatures and dispatches
`repository_dispatch` events to GitHub Actions, enabling aptu-powered issue triage and PR
review for any repository with the app installed.

## Cost Model

External installations use **caller-supplied AI keys** configured in `.github/aptu.yml`.
Operator (clouatre-labs) bears no AI API cost for external accounts. Internal `clouatre-labs`
repos continue using operator keys from workflow secrets. No per-user billing infrastructure
required. See #34.

## Phase 1: Internal Foundation (complete)

- [x] Cloudflare Worker: validate X-Hub-Signature-256, dispatch repository_dispatch
- [x] GitHub Actions workflows: issue triage on `repository_dispatch` (event_type: aptu-triage)
- [x] GitHub Actions workflows: PR review on `repository_dispatch` (event_type: aptu-review)
- [x] GitHub App registration and installation flow
- [x] Wrangler deployment pipeline with secret management
- [x] Documentation: deployment guide, `.github/aptu.yml` schema
- [x] Config-driven opt-in via `.github/aptu.yml` per repo
- [x] `review.paths` support in `.github/aptu.yml` (include and `!`-exclude globs) replacing
  `config/repos.json`

## Phase 2: Multi-Account Support (complete)

Enable installation on accounts outside `clouatre-labs` (starting with `clouatre` personal
account). Milestone: [Phase 2: Multi-Account Support](https://github.com/clouatre-labs/aptu-github-app/milestone/1).

- [x] Fix dispatch token: use scoped token (repositoryNames) for `repository_dispatch` call, not installation token (#27)
- [x] Add `ALLOWED_OWNERS` allowlist to worker to gate external installations (#28)
- [x] Add error handling: try/catch around `dispatchEvent`, `getInstallationToken`, `fetchRepoConfig` (#32)

## Phase 3: Public Release

Open the app to any GitHub account. Requires Phase 2 complete.
Milestone: [Phase 3: Public Release](https://github.com/clouatre-labs/aptu-github-app/milestone/2).

- [x] Caller-supplied AI keys: add `ai` block to `.github/aptu.yml` schema; thread through dispatch payload (#34)
- [x] Move `review.paths` into `.github/aptu.yml` (include and `!`-exclude globs); remove
  `config/repos.json` path filter data entirely (#33)
- [ ] Per-installation quota and rate limiting via Cloudflare Durable Objects (not KV -- see #29 comments) (#29)
- [ ] Landing page at aptu.dev (Astro + Tailwind, Cloudflare Pages) (#2)
- [ ] Remove or graduate `ALLOWED_OWNERS` allowlist once quota controls and caller-supplied keys are in place

## Phase 4: Mention Commands

_This phase requires Phase 3 (quota/rate limiting #29) to be complete first._

Implement `@aptu` mention commands triggered by comments on issues and pull requests.
Without rate limiting, mention commands create a DoS vector -- authenticated or not,
every `@aptu` mention would consume AI API credits. Phase 3 (#29) must gate deployment.

- [ ] Permission gating: `GET /repos/{owner}/{repo}/collaborators/{username}/permission` to verify commenter can trigger commands
- [ ] Dispatch payload: include comment context (issue/PR number, comment body, author)
- [ ] Workflow differentiation: distinguish mention-triggered runs from auto-triggered runs in the dispatch event type
- [ ] Supported commands: `@aptu review` (trigger PR review), `@aptu triage` (trigger issue triage), `@aptu summarize` (summarize issue/PR thread)
- [ ] Feature tracked in #30

## What We Won't Build

- A persistent server (stateless Worker covers all use cases)
- A dashboard or metrics layer (see goose-metrics for that)
- Hosted SaaS billing (Stripe, per-seat pricing) -- caller-supplied keys eliminate the need
