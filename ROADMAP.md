<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->

# Roadmap

Ideas and direction for aptu-github-app. Not a commitment schedule.

## Core Principle

Provide a stateless Cloudflare Worker that validates GitHub webhook signatures and dispatches
`repository_dispatch` events to GitHub Actions, enabling aptu-powered issue triage and PR
review for any repository in the clouatre-labs org without per-repo workflow setup.

## Upcoming

### Phase 1: Initial Implementation (clouatre-labs/aptu#94)

- [ ] Cloudflare Worker: validate X-Hub-Signature-256, dispatch repository_dispatch
- [ ] GitHub Actions workflows: issue triage on `repository_dispatch` (event_type: aptu-triage)
- [ ] GitHub Actions workflows: PR review on `repository_dispatch` (event_type: aptu-pr-review)
- [ ] GitHub App registration and installation flow
- [ ] Wrangler deployment pipeline with secret management
- [ ] Documentation: deployment guide, secret rotation runbook

## What We Won't Build

- A persistent server (stateless Worker covers all use cases)
- Support for webhooks from outside the clouatre-labs org (out of scope)
- A dashboard or metrics layer (see goose-metrics for that)