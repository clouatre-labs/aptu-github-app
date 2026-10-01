# Audit: Floating Ref Evaluation for Consumer Workflow Pins -- September 2026

Audit date: 2026-09-15

Status: Closed -- No-Go. Issue [#283](https://github.com/clouatre-labs/aptu-github-app/issues/283) left a go/no-go decision open on floating workflow refs (moving the `v0.1` tag or pinning `@main`); the evidence below decisively favors no-go, so this document records the rejection rather than an implementation. Verified against `origin/main`.

## See Also

- [2026-08-byok-rollout-simplification.md](./2026-08-byok-rollout-simplification.md) -- prior audit; its R2 finding (release-tag pinning plus CI drift check) is the immediate predecessor of this evaluation.
- [AGENTS.md](../../AGENTS.md) -- "Workflow Security" section (SHA-pinning policy).
- [CONTRIBUTING.md](../../CONTRIBUTING.md) -- "Releases & Versioning" and "Pin Updates Around a Release" sections, including the Renovate automerge customManager.

## Purpose

Issue #283 asked whether consumer workflows should pin to a mutable reference -- a floating `v0.1` tag that is moved at each release, or `@main` -- instead of immutable commit SHAs, to eliminate manual pin maintenance. This document evaluates the trade-off and records the decision.

## Methodology

Review of the moved-tag attack class in GitHub's security advisories (GHSA-mrrh-fwg8-r2c3 / CVE-2025-30066), GitHub's own guidance that commit-SHA pinning is the only mechanism that provides immutability, this repository's tag-protection posture, and the existing Renovate automation in `renovate.json` and `CONTRIBUTING.md`. No claim is taken from the issue description without independent verification against the sources above.

---

## Findings

### F1 -- Floating tags reintroduce the moved-tag compromise class

**Severity:** Critical | **Confirmed:** Yes

A workflow that pins `uses:` to a tag the repository owner can re-point trusts that the tag never moves. Moving the `v0.1` tag is exactly the attack demonstrated by [GHSA-mrrh-fwg8-r2c3](https://github.com/advisories/GHSA-mrrh-fwg8-r2c3) (CVE-2025-30066): an attacker who compromises the source repo (or a maintainer account) re-points the tag to a malicious commit and every consumer executes it on the next run. SHA pinning is the only mechanism GitHub identifies as immutable; a floating tag or `@main` erases that property by construction.

### F2 -- Tags do not have branch-protection-equivalent guarantees

**Severity:** High | **Confirmed:** Yes

A floating-ref strategy is only safe if the tag cannot be force-moved. Tag rulesets can restrict creation, deletion, and re-pointing, but they can always be altered by repository admins -- the same accounts an attacker targets. Branch protection on `main` has the same limitation, so `@main` fares no better: a compromise of `main` propagates to every consumer immediately, with no review gate inside the consumer repositories. SHA pins, by contrast, are inert: a compromised source repo cannot retroactively change what consumers already execute.

### F3 -- Policy conflict

**Severity:** Medium | **Confirmed:** Yes

The SHA-pinning requirement is explicit house policy: `AGENTS.md` ("Workflow Security") states reusable workflow and action refs must use commit SHAs, not mutable tags, citing CVE-2025-30066, and `CONTRIBUTING.md` ("Pin Updates Around a Release") repeats it. Adopting floating refs for consumer workflows would contradict both documents. This evaluation does not amend that policy.

### F4 -- The maintenance cost floating refs would remove is already zero

**Severity:** Info (sound) | **Confirmed:** Yes

The problem floating refs would solve -- manual pin bumps -- is already solved:

- Same-repo dispatcher workflows use relative `uses:` paths and never need repinning.
- Cross-repo `clouatre-labs/aptu` pins are tracked by a Renovate customManager (git-tags datasource) that automerges SHA and version-comment bumps; see `renovate.json` and `CONTRIBUTING.md`. Zero-touch today, without sacrificing immutability.

A floating ref trades a real security property for a convenience that automation already provides.

---

## Recommendation

**No-Go.** Do not move the `v0.1` tag or pin consumer workflows to `@main`. Keep SHA pinning for all cross-repo `uses:` refs; rely on the Renovate automerge customManager for zero-touch bumps. Issue #283 closes with this rationale.

### Fallback

If the fleet ever outgrows Renovate's zero-touch model (for example, a large number of external consumer repositories where automerge throughput or rate limits become a burden), the floating `v0.1` tag option may be revisited -- but only with all of the following mitigations in place:

1. A repository ruleset on `clouatre-labs/aptu` restricting `v*` tag creation, deletion, and force-move to repository admins (mirroring the existing tag-protection convention).
2. Documented admin-account hardening (2FA/hardware keys) for the accounts that ruleset governs, since F2 shows the ruleset is only as strong as those accounts.
3. Explicit amendment of `AGENTS.md` and `CONTRIBUTING.md` to carve out the floating tag, so policy and practice do not diverge.

## Post-Audit Notes

This audit made no workflow, policy, or pin changes. It adds documentation only.
