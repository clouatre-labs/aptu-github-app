<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->

# Roadmap

Ideas and direction for aptu-github-app. Not a commitment schedule.

## Core Principle

Provide a stateless Cloudflare Worker that validates GitHub webhook signatures and dispatches
`repository_dispatch` events to GitHub Actions, enabling aptu-powered issue triage and PR
review for any repository with the app installed.

## Phase 1: Internal Foundation (complete)

- [x] Cloudflare Worker: validate X-Hub-Signature-256, dispatch repository_dispatch
- [x] GitHub Actions workflows: issue triage on `repository_dispatch` (event_type: aptu-triage)
- [x] GitHub Actions workflows: PR review on `repository_dispatch` (event_type: aptu-review)
- [x] GitHub App registration and installation flow
- [x] Wrangler deployment pipeline with secret management
- [x] Documentation: deployment guide, `.github/aptu.yml` schema
- [x] Config-driven opt-in via `.github/aptu.yml` per repo
- [x] Per-repo `exclude_paths` support via `config/repos.json`

## Phase 2: Multi-Account Support (in progress)

Enable installation on accounts outside `clouatre-labs` (starting with `clouatre` personal account).

- [ ] Fix dispatch token: use App-level token for `repository_dispatch` call, not installation token (#27)
- [ ] Add `ALLOWED_OWNERS` allowlist to worker to gate external installations (#28)
- [ ] Update `ROADMAP.md` Core Principle to reflect multi-account scope (this PR)

## Phase 3: Public Release

Open the app to any GitHub account. Requires Phase 2 complete.

- [ ] Per-installation quota and rate limiting via Cloudflare KV (#29)
- [ ] Global concurrent workflow run cap on triage/review workflows (#29)
- [ ] Implement `@aptu` mention commands, or remove from app description (#30)
- [ ] Landing page at aptu.dev (Astro + Tailwind, Cloudflare Pages) (#2)
- [ ] Remove or graduate `ALLOWED_OWNERS` allowlist once quota controls are in place

## What We Won't Build

- A persistent server (stateless Worker covers all use cases)
- A dashboard or metrics layer (see goose-metrics for that)
