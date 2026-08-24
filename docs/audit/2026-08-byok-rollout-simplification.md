# Audit: BYOK Rollout Gap and Simplification Review -- August 2026

Audit date: 2026-08-23

Status: Open. One Critical finding explains today's outage ("nothing is working"). Verified
against `origin/main` at commit `f180c2e` (PR #170, "restore single-file aptu.yml with static
provider-keyed AI-key resolution").

## See Also

- [2026-08-post-byok-migration.md](./2026-08-post-byok-migration.md) -- prior audit covering
  PR #156; its Critical finding (F1, private repo blocking reusable workflows) is resolved.
  Two of its findings (D2, S1) are still open, reconfirmed below.
- [2026-08-pre-public-release.md](./2026-08-pre-public-release.md) -- earlier security/cost
  audit, resolved.
- [2026-08-scan-privacy-residency.md](./2026-08-scan-privacy-residency.md) -- scan/privacy
  audit, resolved.
- Issues [#168](https://github.com/clouatre-labs/aptu-github-app/issues/168) (closed, core
  regression fix) and [#169](https://github.com/clouatre-labs/aptu-github-app/issues/169) (open,
  rescoped per this audit's R2 recommendation).
- Follow-up issues filed from this audit:
  [#174](https://github.com/clouatre-labs/aptu-github-app/issues/174) (Critical, R1 rollout),
  [#175](https://github.com/clouatre-labs/aptu-github-app/issues/175) (Medium, D2 docs
  staleness), and
  [#176](https://github.com/clouatre-labs/aptu-github-app/issues/176) (housekeeping, S1/C1).

## Purpose

Requested review, after a day of BYOK-migration work (#154, #156, #167, #170) left the operator
unconvinced the result is simple, correct, or the right direction. Explicit goals given:

1. Users should only ever have to touch `.github/aptu.yml`. Nothing else.
2. Determine whether issue #169, as scoped, is the right next step or overengineering.
3. Produce a factual, concise, actionable audit.

## Methodology

Direct verification against live sources: `gh api`/`gh issue view`/`gh secret list` against
every repo named in #168/#169's rollout list, the aptu-dev App manifest, the `aptu` CLI's
`action.yml` contract, and GitHub's own documentation for `repository_dispatch` and
`workflow_call` semantics. A background workflow independently re-swept the remaining docs
(`RUNBOOK.md`, `SECURITY.md`, `CONTRIBUTING.md`, `AI_POLICY.md`, the two older audits) for
staleness, adversarially stress-tested this audit's central recommendation (see Finding R2), and
confirmed the platform-constraint claim in Finding P1 against official GitHub docs. No claim
below is taken from a PR description or prior audit without independent re-verification.

---

## Summary Table

| # | Finding | Severity | Confirmed | Status |
| --- | --- | --- | --- | --- |
| R1 | Zero of 11 opted-in repos have the required dispatch-handler file; triage/review/scan is silently non-functional fleet-wide, right now | **Critical** | Yes | Open |
| R2 | Issue #169 is scoped well beyond what today's fleet needs; several of its sub-tasks are already moot | High | Yes | Open -- recommendation below |
| P1 | The two-file install (`aptu.yml` + a static dispatch-handler workflow) is a GitHub Actions platform constraint, not a design choice -- "one file only" is not achievable without reintroducing AI-key custody | Info (sound, closes the KISS question) | Yes | N/A |
| D2 | `docs/ARCHITECTURE.md` still self-contradicts: stale centralized-model sections survive three PRs (#156, #167, #170) that each touched this file | Medium | Yes (reconfirmed) | Open |
| S1 | Dormant `APTU_AI_KEY` repo secret, unused since creation, still present | Low | Yes (reconfirmed) | Open |
| C1 | No aggregate quota ceiling; Cloudflare Durable Object cost scales unbounded with install count | Medium | Yes (reconfirmed) | Open, deliberate |
| F1/F2/F3 | Repo-public, secret scanning, and branch protection (prior audit's blockers) | Info (sound) | Yes | Resolved since last audit |
| CI3 | `aptu` action's input/routing contract matches every field the three reusable workflows send | Info (sound) | Yes | N/A |

---

## R1 -- Fleet-wide outage: the dispatch handler was never rolled out

**Severity:** Critical | **Confirmed:** Yes

`aptu-github-app` itself dogfoods correctly (`.github/aptu.yml` and `.github/workflows/aptu.yml`
both present, verified in this repo). But of the 11 other repos issue #168 claimed to unblock,
**none** have `.github/workflows/aptu.yml`:

```
3pillar, aptu-coder, clouatre.ca, homebrew-tap, math-mcp-learning-server, mederic.ca,
options-trading-mcp, setup-goose-action, setup-kiro-action, setup-q-cli-action, template-repo
-- all 404 on .github/workflows/aptu.yml (verified via GitHub Contents API, 2026-08-23)
```

Confirmed independently on `aptu-coder`: its last 15 Actions runs (through PR #1426) show only
CI/CodeQL/Security/Scorecard/REUSE jobs -- no `aptu-review`/`aptu-triage` dispatch job has run.
This is the direct cause of "nothing is working": #156/#167/#170 fixed the *code path*, but the
*rollout* to existing installers never happened. Issue #168 was closed on the strength of the
code fix, without verifying the fleet.

**Good news that shrinks this fix:** every one of the 11 repos sets `ai.provider: openrouter`
(`template-repo` has no `ai` block at all), and `OPENROUTER_API_KEY` is a `clouatre-labs`
**organization** secret with visibility `all` (confirmed via `gh api orgs/clouatre-labs/actions/secrets`).
Every repo already inherits it. **No secret setup is required anywhere in the fleet** -- the
only missing artifact, fleet-wide, is one identical, already-written file
(`README.md:148-212`).

**Fix:** Add the verbatim dispatch-handler template (`README.md:148-212`, byte-identical to
this repo's own `.github/workflows/aptu.yml`) to the 11 repos. This is 11 small, low-risk,
mechanical PRs (or one script looping `gh api` PR creation) -- no bot, no per-repo
customization, no waiting on anything. This alone resolves the outage.

**Resolved:** Not resolved. Recommended as an immediate, scriptable action; not applied by this
audit (write action, left to the operator per this repo's own risk posture). Tracked in
[#174](https://github.com/clouatre-labs/aptu-github-app/issues/174).

---

## R2 -- Issue #169 is scoped for a problem the fleet doesn't have yet

**Severity:** High | **Confirmed:** Yes

Issue #169 bundles: an auto-provisioning bot that opens "setup PRs" (with idempotency checks,
a backoff window, 403-handling, a template-version-marker system), pinning the three reusable
workflow refs to a release tag, an `aptu-dev` App manifest change, and an org-wide rollout
coordination effort.

Three of its stated premises are already false or moot, verified directly:

- **App manifest:** `gh api /apps/aptu-dev --jq .permissions` already returns
  `pull_requests: write` today. The manifest sub-task is done; nothing to add.
- **`aptu-coder` secret mismatch:** #169 flags `aptu-coder` requesting `openrouter` while only
  `ANTHROPIC_API_KEY` "exists there." In fact `OPENROUTER_API_KEY` is an org secret visible to
  every `clouatre-labs` repo including `aptu-coder` -- this was never actually broken.
- **Audience:** all 11 target repos, `aptu-github-app`, and the `aptu` CLI repo are owned by the
  same single operator. There is no confirmed external (non-operator) installer today. The
  bot's idempotency/backoff/403-handling machinery is designed for untrusted, arms-length
  installers -- an audience that doesn't exist yet.

Building the full bot now is solving a scaling problem before there is any scale. This is the
same class of premature engineering the operator's own standards (`AGENTS.md`: "Don't design
for hypothetical future requirements") already flag as a smell.

**Recommendation (do this instead):**

1. **Now:** the manual/scripted rollout in R1. Closes the actual outage.
2. **Now, cheap, worth doing regardless of the bot decision:** pin the three
   `uses: clouatre-labs/aptu-github-app/.github/workflows/*.yml@main` references in the
   template to a release tag (e.g. `@v1`) instead of `@main`. This is a few lines in one
   template and closes a real, independent risk: today, any breaking change merged to `main`
   changes behavior for all 11 installed repos simultaneously with no rollback path. This does
   not require the bot.
3. **Now, cheap:** a CI check in `aptu-github-app` (not cross-repo automation) that fails a PR
   touching `pr-review.yml`/`issue-triage.yml`/`scan-security.yml` without a corresponding
   version-marker bump in the template -- gives drift detection without a setup-PR bot.
4. **Defer:** the auto-provisioning bot (idempotency, backoff, 403-handling, coordinated
   re-authorization) until there is an actual external installer, or the fleet grows to a size
   where per-repo manual tracking genuinely breaks down. Neither condition holds today.

This was independently adversarially reviewed: the one legitimate gap in "just do the manual
rollout" is that it doesn't prevent a *future* 12th repo from silently missing the handler with
no alert. Items 2 and 3 above close that gap cheaply, without building the bot.

**Resolved:** Not resolved. This is a scoping recommendation, applied in place to
[#169](https://github.com/clouatre-labs/aptu-github-app/issues/169) (rescoped to items 2 and 3
above; item 4 deferred, no issue filed).

---

## P1 -- The two-file model is a GitHub platform floor, not a design choice

**Severity:** Info (closes the "should this be one file" question) | **Confirmed:** Yes

Confirmed directly against GitHub's documentation: a `repository_dispatch` event "will only
trigger a workflow run if the workflow file exists on the default branch"
([Events that trigger workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)),
and a reusable workflow's `workflow_call` target must already be committed to
`.github/workflows/` in the target repo
([Reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)).
No GitHub Apps API (including the Checks API) can define or inject a workflow to run in an
installed repository without that file already present. There is no mechanism, at any
permission level, for the operator to execute anything in a caller's Actions context without
the caller already having committed a matching workflow file.

Consequently, "the user should only ever touch `.github/aptu.yml`" is not achievable **while
keeping true BYOK** (the AI key never leaving the caller's own repo) -- the only way to drop the
second file entirely is for the operator to take custody of every installer's AI key and run
the AI call from the operator's own infrastructure (the Worker, or a backend service). That is
the exact model #154/#156 deliberately moved away from today, for real security reasons
(a caller-controlled secret name resolving in the operator's context), and it reopens the
operator-cost exposure `ROADMAP.md`'s "What We Won't Build" section already rules out.

**Conclusion:** the two-file model is already the minimal footprint achievable on GitHub's
platform for zero-custody BYOK: one config file the user edits (`aptu.yml`), and one static
file the user pastes once and never edits again (verbatim per `README.md`, identical for every
installer). The simplification that's actually available -- and actually missing -- is closing
R1 (it was never rolled out) and D2 (the docs describing it are self-contradictory), not
chasing a literal single-file install that GitHub's platform forecloses.

---

## D2 -- `docs/ARCHITECTURE.md` still self-contradicts (reconfirmed, unresolved across 3 PRs)

**Severity:** Medium | **Confirmed:** Yes

First flagged in the prior audit and folded into issue #162 (closed). PR #156, #167, and #170
all touched this file; none removed the stale sections. Still present on current `main`:

- **Lines 10-11:** "External repositories never run workflows themselves... all processing
  happens centrally here." False -- contradicted by the file's own later Token Model / BYOK
  sections.
- **Lines 42-59:** "Both workflows run in this repository... Workflows mint scoped installation
  tokens via `actions/create-github-app-token`." False -- `rg -n 'create-github-app-token'
  .github/workflows/*.yml` returns zero matches; the reusable workflows use `secrets.GITHUB_TOKEN`
  in the caller's own context.
- **Lines 68-73, 260-268:** Describe a `GlobalQuota` Durable Object and
  `enforceQuota`/`checkGlobalQuota` functions removed in PR #123 and never restored (confirmed:
  `rg 'GlobalQuota|enforceQuota|checkGlobalQuota' worker/src/*.ts` returns zero matches;
  `wrangler.toml` line 28 records `deleted_classes = ["GlobalQuota"]`).
- **Line 169:** Lists `OPENROUTER_API_KEY` as a required *organization* secret operational
  prerequisite for the Worker. False under BYOK -- no Worker code or reusable workflow reads
  this for its own operation; it is a caller-side secret name convention only.

**Fix:** Rewrite these five spots to match the file's own correct Token Model / Caller-Supplied
AI Keys / Security Boundaries sections (lines 128-251), which are accurate. This is a
documentation-only change with no code risk.

**Resolved:** Not resolved. Tracked in
[#175](https://github.com/clouatre-labs/aptu-github-app/issues/175).

---

## S1 -- Dormant `APTU_AI_KEY` secret (reconfirmed, unresolved)

**Severity:** Low | **Confirmed:** Yes

`gh secret list --repo clouatre-labs/aptu-github-app` still shows `APTU_AI_KEY` (created
2026-08-23), referenced by zero current workflows. No active exploit path, but it is
unnecessary residual exposure: a future workflow edit that accidentally references
`secrets.APTU_AI_KEY` would silently reintroduce operator-key exposure to caller-controlled
dispatch content -- the same failure class BYOK was built to close.

**Fix:** Delete the secret. One `gh secret delete APTU_AI_KEY --repo clouatre-labs/aptu-github-app`
call.

**Resolved:** Not resolved. Tracked in
[#176](https://github.com/clouatre-labs/aptu-github-app/issues/176).

---

## C1 -- No aggregate quota ceiling (reconfirmed, unresolved, deliberate)

**Severity:** Medium | **Confirmed:** Yes

`worker/src/quota.ts` defines only `InstallationQuota` (50 events/type/24h per installation);
the aggregate `GlobalQuota` Durable Object from PR #88 was removed in PR #123 and never
reinstated. Cloudflare Durable Object request/duration costs scale with total install count
with no ceiling. Low urgency today (12 total repos, all operator-owned); worth a documented
decision (reinstate, or accept with a Cloudflare billing alert as a stopgap) before any external
adoption.

**Fix:** Carried forward unchanged from the prior audit; no new information this pass.

**Resolved:** Not resolved. Tracked in
[#176](https://github.com/clouatre-labs/aptu-github-app/issues/176).

---

## Confirmed Sound Controls (since the last audit)

- **F1 (was Critical, now resolved):** `aptu-github-app` is public
  (`isPrivate:false`/`visibility:PUBLIC`, verified live). Reusable workflows are reachable by
  any caller.
- **F2 (resolved):** `secret_scanning` and `secret_scanning_push_protection` are both `enabled`
  (verified live via `security_and_analysis`).
- **F3 (resolved, prior audit's 404 was a false signal):** the classic
  `branches/main/protection` API 404s because a modern ruleset ("Protect main branch",
  enforcement `active`) governs `main` instead -- confirmed via
  `repos/.../rulesets`. Branch protection is in place.
- **CI3 -- `aptu` action contract verified sound:** every input the three reusable workflows
  pass (`github-token`, `anthropic-api-key`/`gemini-api-key`/`openrouter-api-key`, `provider`,
  `model`, `skip-labeled`, `instructions-file`, `repo`, `pull-number`/`issue-number`,
  `scan-path`, `fail-on`, etc.) exists in `clouatre-labs/aptu`'s `action.yml` at the pinned SHA
  (`v0.10.12`). Routing between issue-triage and PR-review paths is keyed off presence of
  `repo`+`issue-number` vs. `repo`+`pull-number` for `repository_dispatch` events
  (`action.yml:392,480,516`), not the vestigial `command`/`subcommand` legacy inputs the
  reusable workflows never set -- this is correct, not a bug.
- **Model string verified, not a typo:** `google/gemma-4-26b-a4b-it` (used as the default in
  both reusable workflows and every fleet repo's config) is a real, intentionally-documented
  example model in `aptu`'s own `README.md`/`docs/GITHUB_ACTION.md`/`docs/GITHUB_APP.md`, not a
  hallucinated model ID.

---

## Recommendation Summary

1. **Do now (unblocks the outage):** roll out the verbatim dispatch-handler template to the 11
   fleet repos (R1). No secrets to create anywhere -- confirmed, all inherit the org-wide
   `OPENROUTER_API_KEY`.
2. **Do now (cheap, independent of #169's bot):** pin the template's three `@main` refs to a
   release tag; add a version-marker CI drift check in this repo (R2).
3. **Rescope #169:** drop the setup-PR bot, idempotency/backoff/403-handling, and the App
   manifest sub-task (already satisfied). Keep only the release-tag pinning and CI drift check.
   Reopen the bot only if an external installer appears or the fleet materially outgrows manual
   tracking.
4. **Fix docs:** rewrite the five stale spots in `docs/ARCHITECTURE.md` (D2).
5. **Housekeeping:** delete `APTU_AI_KEY` (S1); decide and document the aggregate-quota
   question (C1).

No architecture change is recommended. The two-file install is already the simplest form
achievable on GitHub's platform without reintroducing AI-key custody (P1); what was actually
broken was rollout and documentation hygiene, not design.

## Post-Audit Notes

This audit made no code, workflow, secret, or issue changes. All fixes above are recommended,
not applied, pending the operator's direction.
