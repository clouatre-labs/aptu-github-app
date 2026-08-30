# Audit: Post-BYOK-Migration Public-Readiness Review -- August 2026

Audit date: 2026-08-23

Status: Open. One Critical finding blocks the stated goal (aptu-dev fully functional for every installer, at zero operator cost). Verified against `origin/main` at commit `70b70a6` (PR #156, "migrate to true BYOK with caller-dispatched reusable workflows", closing #154).

## See Also

- [2026-08-pre-public-release.md](./2026-08-pre-public-release.md) -- prior security and cost
  audit; findings S1/S2/C3 from that audit are the ones PR #156 set out to close
- [2026-08-scan-privacy-residency.md](./2026-08-scan-privacy-residency.md) -- prior scan/privacy
  audit
- [ARCHITECTURE.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/ARCHITECTURE.md) -- module map and data flow
- [RUNBOOK.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/RUNBOOK.md) -- operational procedures
- [SECURITY.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/SECURITY.md) -- vulnerability disclosure policy

## Purpose

Point-in-time audit triggered by the owner's request to re-verify public-release readiness after PR #156 migrated `aptu-github-app` to a "true BYOK" model. Three explicit goals were given for this audit:

1. The `aptu-dev` GitHub App must be fully public, with **no possibility of the operator
   incurring cost** from its own AI API keys -- every installer must use their own key.
2. `aptu-dev` must be **fully functional for everyone, in all circumstances** -- public
   caller repo, private caller repo, or otherwise.
3. A factual, no-speculation audit, followed by a PR and (if warranted) filed issues.

Four axes were examined:

1. **Functionality** -- can the documented installation path actually work, for any caller,
   today
2. **Security** -- whether the AI-key exposure vulnerability class from the prior audit (S1)
   is actually closed
3. **Cost** -- operator-side cost exposure, both AI-API and Cloudflare-infrastructure
4. **CI/CD and documentation** -- workflow hygiene, and whether docs match shipped code

## Methodology

Three read-only Explore delegates investigated in parallel: workflow files and `wrangler.toml` for pattern consistency and stale references; `README.md`/`docs/ARCHITECTURE.md`/`ROADMAP.md`/ `SECURITY.md` for accuracy against current source; and `bun test`/`bunx biome check` re-run live plus the Cloudflare cost model. Every delegate claim below was independently re-verified against source line numbers, `gh api`/`gh repo view` output, or a command actually run in this repo before being included. No claim in this document is taken on trust from a PR description or a prior audit.

---

## Summary Table

| # | Axis | Severity | Finding | Confirmed | Blocks stated goal | Status |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Functionality | **Critical** | `aptu-github-app` is a private repo with Actions cross-repo access `none`; the reusable workflows every installer's `aptu.yml` depends on cannot be invoked by anyone, including the operator's own other repos | Yes | **Yes** | Open -- issue filed |
| D1 | Docs | Medium | `README.md`/`docs/ARCHITECTURE.md` document the `uses: clouatre-labs/aptu-github-app/...@main` calling convention but never state it requires the repo to be public | Yes | Yes (compounds F1) | Open -- same issue |
| D2 | Docs | Medium | `docs/ARCHITECTURE.md` retains a full "GitHub Actions Workflows" section, an "`enforceQuota`/`checkGlobalQuota`" section, and a "`GlobalQuota` Durable Object" section describing an architecture that no longer exists in source, self-contradicting the file's own later "Token Model" and "Caller-Supplied AI Keys" sections | Yes | No | Open -- same issue |
| S1 | Security | Low | Dormant repo secret `APTU_AI_KEY` in `aptu-github-app`, created 2026-08-23, referenced by zero current workflows | Yes | No | Open -- same issue |
| C1 | Cost | Medium | Aggregate/global quota ceiling (`GlobalQuota`, added PR #88) was permanently removed in PR #123 and never reinstated; only the 50-events/24h per-installation cap remains, so Cloudflare Durable Object request costs scale unbounded with install count | Yes | No | Open -- same issue |
| F2 | Security | Medium | `secret_scanning`, `secret_scanning_push_protection`, and `code_security` are all `disabled` on `aptu-github-app` (`gh api repos/clouatre-labs/aptu-github-app --jq .security_and_analysis`); should be enabled before visibility flips to public | Yes | Yes (precondition for F1's fix) | Open -- same issue |
| F3 | CI/CD | Medium | `main` has no branch protection (`gh api repos/clouatre-labs/aptu-github-app/branches/main/protection` -> 404 "Branch not protected") -- no required review, no required status checks; should be set before the repo accepts public traffic | Yes | Yes (precondition for F1's fix) | Open -- same issue |
| S2 | Security | **Info (sound)** | The prior audit's S1 vulnerability class (caller-supplied AI-key secret name resolving against the operator's own repo) is now structurally impossible: `AiConfig` in `config.ts` carries no field that can name a secret at all | Yes | N/A (sound) | N/A (sound) |
| C2 | Cost | **Info (sound)** | No AI API key of any kind ever leaves the caller's own repository; the Worker's dispatch payload and every reusable workflow carry only `ai_provider`/`ai_model`, never a key or a key-name | Yes | N/A (sound) | N/A (sound) |
| C3 | Cost | **Info (sound)** | GitHub Actions minutes for `workflow_call` jobs invoked via `uses: clouatre-labs/aptu-github-app/...@main` bill to the calling repository, not to `aptu-github-app` -- the operator's Actions-minutes exposure from the prior audit (C3) is closed by this architecture, contingent on F1 being resolved so the calls can execute at all | Yes (billing model); contingent on F1 | N/A | N/A (sound once F1 resolved) |
| CI1 | CI/CD | **Info (sound)** | `issue-triage.yml`, `pr-review.yml`, `scan-security.yml`, `ci.yml`, `deploy.yml` are internally consistent: SHA-pinned actions, minimal `permissions:` blocks, no stale references to `TARGET_REPO`/`ALLOWED_OWNERS`/`ai_key_secret`/`api-key-secret`/`APTU_AI_KEY` in any active code path | Yes | N/A (sound) | N/A (sound) |
| CI2 | CI/CD | **Info (sound)** | `bun test`: 114 pass, 0 fail (275 assertions). `bunx biome check .`: exit 0, no findings. Both re-run live against current `main`, not assumed from the PR description | Yes | N/A (sound) | N/A (sound) |

**Verdict: OPEN. The AI-key exposure and unbounded-Actions-minutes vulnerabilities from the prior audit (S1, C3) are correctly closed by PR #156's architecture. But that architecture depends on `aptu-github-app` being reachable by external callers via GitHub's reusable-workflow `uses:` mechanism, and the repo has not been made public. As shipped on `main` today, no installation -- external or internal -- can successfully run triage, review, or scan. F1 must be resolved before the App can be considered functional for anyone, let alone "fully public."**

---

## Confirmed Blocking Finding

### F1 -- `aptu-github-app` is private; its reusable workflows are unreachable by any caller

**Severity:** Critical | **Confirmed:** Yes | **Blocks stated goal:** Yes | **Issue:** [#162](https://github.com/clouatre-labs/aptu-github-app/issues/162)

**Description:**

PR #156 replaced the broken caller-supplied-secret-name model with a new one: the Worker dispatches `repository_dispatch` to the *caller's own repository* (`worker/src/index.ts:767`, `798`, `671`), and the caller is expected to have installed `.github/workflows/aptu.yml` (documented in `README.md:144-202`) whose jobs invoke reusable workflows via:

```yaml
uses: clouatre-labs/aptu-github-app/.github/workflows/pr-review.yml@main
```

(`.github/workflows/aptu.yml:24`, mirrored at lines 38 and 50 for triage and scan.)

GitHub only resolves a `uses:` reference to a reusable workflow defined in another repository when that repository is **public**, or when the calling repository is in the same organization/enterprise **and** that org/enterprise-scoped access has been explicitly granted in the defining repository's settings. Neither condition is met:

- `gh repo view clouatre-labs/aptu-github-app --json isPrivate,visibility` returns
  `{"isPrivate":true,"visibility":"PRIVATE"}`.
- `gh api repos/clouatre-labs/aptu-github-app/actions/permissions/access` returns
  `{"access_level":"none"}` -- meaning zero repositories, not even other `clouatre-labs` repositories, are currently permitted to invoke this repo's reusable workflows.

The practical effect: every `.github/workflows/aptu.yml` installed per the documented instructions will fail its `review`/`triage`/`scan` job with a workflow-resolution error the moment `repository_dispatch` fires, for every installer, public or private repo alike, including the operator's own repositories in the `clouatre-labs` org. This is not a theoretical edge case -- it is the only path through which any of the three features currently run, since the Worker no longer executes anything itself (`worker/src/index.ts` contains no AI-invocation code; it only validates, checks quota, and dispatches).

By contrast, `clouatre-labs/aptu` (`gh repo view clouatre-labs/aptu --json visibility` -> `"PUBLIC"`), the composite action invoked *inside* the reusable workflows (`.github/workflows/pr-review.yml:50`), is public and is not part of this blocker -- `uses:` references to actions (as opposed to reusable `workflow_call` workflows) from a public repo work for any caller regardless of the caller's own visibility.

**Files:** `.github/workflows/aptu.yml:24,38,50`, `README.md:169,183,195`, `docs/ARCHITECTURE.md:44-59`, `worker/src/index.ts:767,798`

**Fix (choose one):**

- Make `clouatre-labs/aptu-github-app` a public repository. This satisfies GitHub's reusable
  workflow access rule for any external caller with no further configuration, matches the repo's already-public-release-ready state (Apache-2.0 `LICENSE`, `LICENSES/Apache-2.0.txt`, REUSE-compliant SPDX headers per `REUSE.toml`), and requires no code changes. Recommended, contingent on a full git-history secret scan first (this audit did not run one; the user has deferred that check to a separate follow-up before flipping visibility).
- Alternatively, stop depending on cross-repo reusable workflows: distribute the review/triage/
  scan job bodies as a copy-paste template that installers embed directly into their own `.github/workflows/aptu.yml`, so nothing is fetched from `aptu-github-app` at run time. This works with the repo staying private, but gives up centrally-versioned workflow logic -- every installer must manually pick up future fixes, which the reusable-workflow design was built to avoid.

**Resolved:** Not resolved. Filed as issue (see below); the choice between remediation options is the operator's, not applied in this audit.

---

### External validation for the "make public" recommendation

Two questions were researched independently after this audit, to confirm the recommended fix against GitHub's documented behavior and industry practice rather than inference:

**GitHub's rule has no cross-org exception.** Per [GitHub Docs: Sharing actions and workflows from your private repository](https://docs.github.com/en/actions/creating-actions/sharing-actions-and-workflows-from-your-private-repository), a private (or internal) repository's reusable workflows are resolvable only by callers in the *same organization or enterprise*, with access explicitly granted in Settings > Actions > General > Access. There is no mechanism, at any visibility level short of public, for a private repo's reusable workflows to be called from outside that org/enterprise. Reusable-workflow GA'd private/internal sharing in [December 2022](https://github.blog/changelog/2022-12-13-github-actions-sharing-actions-and-reusable-workflows-from-private-repositories-is-now-ga/); no subsequent changelog entry (through 2026) altered this boundary. Since external installers by definition sit outside `clouatre-labs`, no private-repo configuration can satisfy audit goal 2 ("fully functional for everyone").

**Industry precedent keeps the wrapper repo public.** Commercial and OSS Actions-based products that need work to bill to the caller's own runners -- Snyk (`snyk/actions`), Codecov (`codecov/codecov-action`), CodeQL (`github/codeql-action`), SonarSource (`sonarqube-scan-action`) -- all keep their workflow/action-defining repository public. In every case the proprietary logic lives in a closed-source CLI, binary, or backend service invoked *by* the public YAML; the YAML wrapper itself carries no secret-sauce risk. This repo already follows that exact shape: `clouatre-labs/aptu` (`gh repo view clouatre-labs/aptu --json visibility` -> `"PUBLIC"`), the composite action that does the actual AI review/triage work, is already public. `aptu-github-app`'s three reusable workflows (`pr-review.yml`, `issue-triage.yml`, `scan-security.yml`) are thin `workflow_call` wrappers (50-154 lines each) around that already-public action -- making `aptu-github-app` public discloses no logic that isn't already open. What remains private either way are the Worker's runtime secrets (`WEBHOOK_SECRET`, `APP_PRIVATE_KEY`, `CLOUDFLARE_API_TOKEN`), which are GitHub/Wrangler secrets, never committed to source.

A variant considered and rejected: splitting the three thin workflow files into a separate, minimal public repo while keeping the Worker source private. Technically viable, but it adds a second repo to maintain with no security benefit over making `aptu-github-app` public outright, since the Worker's actual secrets are unaffected by either choice.

---

## Confirmed Non-Blocking Findings

### D1 -- Documentation never states the public-repo prerequisite (compounds F1)

**Severity:** Medium | **Confirmed:** Yes

`README.md:109-206` ("External installation example" and "Installation") gives an accurate, byte-for-byte-correct `aptu.yml` template matching the real file, and correct cost-isolation language ("the operator's AI keys are never exposed to any installation", `README.md:116-117`). `docs/ARCHITECTURE.md:44-47` describes the same `uses:` mechanism. Neither document states, anywhere, that this mechanism requires `aptu-github-app` to be public, or mentions GitHub's reusable-workflow cross-repo access control at all. A new installer following the docs exactly has no way to know why their workflow run fails.

**Files:** `README.md:109-206`, `docs/ARCHITECTURE.md:44-59`

**Fix:** Once F1 is resolved, add a line to both documents stating the prerequisite explicitly (e.g., "`aptu-github-app` must be publicly readable for these `uses:` references to resolve").

**Resolved:** Not resolved. Folded into the F1 issue.

---

### D2 -- `docs/ARCHITECTURE.md` self-contradicts: stale sections describe a non-existent architecture

**Severity:** Medium | **Confirmed:** Yes

`docs/ARCHITECTURE.md` was touched by the PR #156 commit itself (`git log -- docs/ARCHITECTURE.md` shows `70b70a6` as the most recent commit) but was only partially updated. The following sections describe an architecture that does not match current source, and directly contradict other sections of the *same file*:

- **Lines 10-11** ("Overview"): "External repositories never run workflows themselves... all
  processing happens centrally here." This is false under the current model -- reusable workflows execute in the *caller's* Actions runners (correctly stated later at `docs/ARCHITECTURE.md:220`, "The reusable workflow runs in the caller's context").
- **Lines 42-59** ("GitHub Actions Workflows"): states "Both workflows run in this repository
  (`clouatre-labs/aptu-github-app`), not in the originating repository" and "Workflows mint scoped installation tokens via `actions/create-github-app-token` using the App ID and private key stored in this repository." Neither is true: `rg -n 'create-github-app-token'` across `.github/workflows/*.yml` on `main` returns zero matches; `pr-review.yml:53` uses `secrets.GITHUB_TOKEN` directly, scoped to the caller's own repo by GitHub Actions.
- **Lines 68-73** ("`GlobalQuota` Durable Object") and **lines 248-256**
  (`enforceQuota`/`checkGlobalQuota`) describe a Durable Object and functions that do not exist in `worker/src/quota.ts` or `worker/src/index.ts` on `main` -- `rg -n 'enforceQuota|checkGlobalQuota|GlobalQuota' worker/src/*.ts` returns zero matches. `GlobalQuota` was added in PR #88 and permanently removed in PR #123 (`deleted_classes = ["GlobalQuota"]` migration in `wrangler.toml`); this section predates even PR #156 and was never removed.
- **Line 169** ("Operational Prerequisites"): lists `OPENROUTER_API_KEY` (organization secret)
  as a required prerequisite for `aptu-github-app` to "handle webhook events or run workflows." No current workflow or Worker code path reads this secret; it is a leftover from a pre-BYOK architecture.

**Files:** `docs/ARCHITECTURE.md:10-11,42-59,68-73,169,248-256`

**Fix:** Remove or rewrite the stale sections to match the current model already correctly described elsewhere in the same file (Token Model, Caller-Supplied AI Keys, Security Boundaries sections at lines 128-239 are accurate).

**Resolved:** Not resolved. Folded into the F1 issue.

---

### S1 -- Dormant `APTU_AI_KEY` repo secret in `aptu-github-app`

**Severity:** Low | **Confirmed:** Yes

`gh secret list --repo clouatre-labs/aptu-github-app` shows a repository secret named `APTU_AI_KEY`, created 2026-08-23 (the same day as this audit). No current workflow references `secrets.APTU_AI_KEY` -- the caller-side convention is a differently-named secret (`APTU_AI_API_KEY`) that lives in the *caller's* repository, not this one (`README.md:141,204`, `.github/workflows/aptu.yml:33,45`). This secret has no active exploit path today, but its presence in the operator's own repo is unnecessary residual exposure: an accidental future workflow edit that references `secrets.APTU_AI_KEY` would silently reintroduce operator-key exposure to caller-controlled dispatch content, the same failure mode as the prior audit's S1.

**Files:** GitHub repository secrets, `clouatre-labs/aptu-github-app` (not in source control)

**Fix:** Delete the `APTU_AI_KEY` repository secret.

**Resolved:** Not resolved. Folded into the F1 issue (operator action, not a code change).

---

### C1 -- No aggregate quota ceiling; Cloudflare Durable Object costs scale unbounded with install count

**Severity:** Medium | **Confirmed:** Yes

The prior audit's C3 finding (unbounded GitHub Actions minutes) is closed: Actions minutes for reusable-workflow jobs bill to the calling repository, not to `aptu-github-app` (standard GitHub Actions billing behavior for `workflow_call`, not specific to this repo's configuration). However, a related and previously-mitigated exposure has reopened on the Cloudflare side. PR #88 added a `GlobalQuota` Durable Object providing an org-wide aggregate cap; PR #123 removed it ("remove GlobalQuota, add AI-key exemption") and it was never reinstated by PR #156. `worker/src/quota.ts` on `main` defines only `InstallationQuota` (50 events/event-type/24h, `quota.ts:19-20`); no aggregate cap exists. Each new installation adds its own Durable Object instance and request volume with no ceiling tied to total install count -- Cloudflare bills Durable Object requests and duration on the Workers Paid plan, so this cost scales with adoption with no configured stop.

**Files:** `worker/src/quota.ts`, `wrangler.toml`

**Fix:** Reinstate an aggregate/global quota Durable Object (as in the now-removed PR #88 design), or set and monitor a Cloudflare-side spend/request alert as a stopgap.

**Resolved:** Not resolved. Folded into the F1 issue.

---

## Confirmed Sound Controls

### S2 -- AI-key secret-name injection (prior S1) is now structurally impossible

**Severity:** Info | **Confirmed:** Yes

The prior audit's S1 finding relied on `AptuConfig.ai` carrying an `api-key-secret` field whose value the Worker forwarded as `ai_key_secret` in the dispatch payload, letting a caller name any secret in the operator's own repo. `worker/src/config.ts:9-12` (`AiConfig`) now has exactly two fields, `provider` and `model` -- there is no field left that can carry a secret name, and `worker/src/index.test.ts` (lines 408, 439, 1142, 1162, 1175, 1195, 1203, 1223, 2268, 2274,
2308) explicitly asserts `ai_key_secret`/`api-key-secret` never appear in any dispatch payload.
This closes the vulnerability class by construction, not by convention or gating.

### C2 -- No AI API key ever leaves the caller's own repository

**Severity:** Info | **Confirmed:** Yes

Every dispatch payload in `worker/src/index.ts` (lines 674-679, 771-778, 799-806, 412-428) carries only `ai_provider`/`ai_model`, never a key or a key name. The reusable workflows resolve the actual key from `secrets.APTU_AI_API_KEY` evaluated in the *caller's* own `.github/workflows/aptu.yml` (`.github/workflows/aptu.yml:33,45`) -- a GitHub Actions `secrets:` expression in a workflow file always resolves against the repository that file lives in, never against `aptu-github-app`.

### C3 -- Actions-minutes billing correctly shifted to the caller (contingent on F1)

**Severity:** Info | **Confirmed:** Yes (billing model), contingent on F1 for it to matter

When repo A calls a reusable workflow defined in repo B via `uses: B/.../file.yml@ref`, the resulting job's Actions minutes bill to repo A, the caller -- standard GitHub Actions behavior, not specific configuration in this repo. Once F1 is resolved and the calls can actually execute, the operator's prior C3 exposure (unbounded Actions minutes on its own private repo) is closed by this architecture.

### CI1 -- Workflow and Worker source hygiene

**Severity:** Info | **Confirmed:** Yes

`issue-triage.yml`, `pr-review.yml`, `scan-security.yml` consistently use `permissions: {}` at the top level with minimal job-level grants, SHA-pinned actions with version comments, and `secrets.ai-api-key` passthrough. `ci.yml` and `deploy.yml` carry no leftover references to `TARGET_REPO`, `ALLOWED_OWNERS`, `ai_key_secret`, `api-key-secret`, or `APTU_AI_KEY`. `wrangler.toml` declares only `QUOTA` and `REPLAY_GUARD` Durable Object bindings, `APP_ID` and `APTU_BOT_ID` vars, and `WEBHOOK_SECRET`/`APP_PRIVATE_KEY` secrets -- no operator AI key.

### CI2 -- Test suite and lint independently re-verified

**Severity:** Info | **Confirmed:** Yes

`bun test` on current `main`: **114 pass, 0 fail**, 275 `expect()` assertions across 3 test files. `bunx biome check .`: exit 0, no findings. Both commands were run directly in this audit rather than trusted from PR #156's description.

---

## Filed Issue

- [#162](https://github.com/clouatre-labs/aptu-github-app/issues/162) -- tracks F1, F2, F3, D1,
  D2, S1, and C1 as a single decision: whether to make `aptu-github-app` public (recommended, confirmed as the only option that satisfies external callers) or restructure away from cross-repo reusable workflows, plus the documentation corrections and secret cleanup that follow from whichever path is chosen. Blocked by #164 and #165.
- [#164](https://github.com/clouatre-labs/aptu-github-app/issues/164) -- pre-public-release scan:
  full git-history secret scan (all branches/tags), enabling `secret_scanning` and `secret_scanning_push_protection` (F2), and branch protection on `main` (F3).
- [#165](https://github.com/clouatre-labs/aptu-github-app/issues/165) -- align CI workflows with
  `clouatre-labs/template-repo` (missing `security.yml`, `scorecard.yml`, `scheduled-security-audit.yml`, and three others).

---

## Post-Audit Notes

- This audit made no code, workflow, or repository-configuration changes. It did not run a
  git-history secret scan and did not change `aptu-github-app`'s visibility -- both are explicitly deferred to the operator's decision, per direction given during this audit.
- A stray local git worktree (`.worktrees/157/`) containing an older, pre-PR-156 checkout was
  observed in the working directory during this audit. It is untracked (`git ls-files` confirms it is not part of the committed repository) and is not part of this audit's scope.
