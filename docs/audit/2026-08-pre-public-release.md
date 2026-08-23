# Audit: Pre-Public-Release Security and Cost Review -- August 2026

Audit date: 2026-08-04

Status: Resolved. All blocking and pre-release findings closed as of 2026-08-04. Hardening
findings deferred with documented decisions below. Fixes verified against `origin/main` at
commit `586a34f`; PRs #87-#95 apply all remediations. Two post-audit fixes (PR #96 and PR #97)
were applied on 2026-08-05; see the Post-Audit Fixes section.

## See Also

- [ARCHITECTURE.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/ARCHITECTURE.md) -- module map and data flow
- [RUNBOOK.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/RUNBOOK.md) -- operational procedures
- [SECURITY.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/SECURITY.md) -- vulnerability disclosure policy

## Purpose

Point-in-time audit of `aptu-github-app` against three axes before the GitHub App is made
publicly installable. The owner must be certain external installs cannot cost a penny and
cannot violate trust boundaries.

1. **Security** -- HMAC validation, secret scoping, token handling, error responses, quota
   ordering, supply chain
2. **Cost** -- API billing, quota coverage and limits, Cloudflare resource consumption, GitHub
   Actions minutes, Sentry event volume
3. **CI/CD** -- workflow permissions, action pinning, runner pinning, dependency scanning,
   REUSE compliance

---

## Methodology

Three independent read-only scout delegates analyzed the codebase in parallel against dedicated
checklists. Each claim was verified against actual source line numbers. Severity levels follow
CVSS-inspired conventions: Critical, High, Medium, Low, Info.

---

## Summary Table

| # | Axis | Severity | Finding | Confirmed | Blocks public release | Resolved |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Security | **Critical** | Caller-supplied AI key model broken: `secrets[ai_key_secret]` resolves against owner's org, not caller's | Yes | **Yes** | PR #87 (partial: docs updated; full fix via `ALLOWED_OWNERS` gate) |
| S2 | Security | **High** | `ALLOWED_OWNERS` gate removed in #59; README and ARCHITECTURE.md still describe it as active | Yes | **Yes** | PR #87 |
| C3 | Cost | **High** | No aggregate quota ceiling across installations; GitHub Actions minutes scale unboundedly | Yes | **Yes** | PR #88 |
| S6 | Security | **Medium** | `handleMentionCommand` calls `getInstallationToken` + `checkCollaboratorPermission` before `enforceQuota` | Yes | Yes | PR #94 |
| S7 | Security | **Medium** | No cross-installation aggregate quota cap | Yes | Yes | PR #88 |
| C5 | Cost | **Medium** | DO `storage.put` runs on every exceeded-quota request, not just on state changes | Yes | No | PR #93 (`InstallationQuota`); PR #97 (`GlobalQuota`) |
| S10 | Security | **Medium** | 8 known advisories in devDependency chains (postcss, esbuild, undici); no CI gate blocks on them | Yes | No | PR #95 |
| CI-F4 | CI | **Medium** | `bun-version: latest` in ci.yml -- floating toolchain | Yes | No | PR #90 |
| CI-F10 | CI | **Medium** | Renovate automerges all github-actions updates including majors unconditionally | Yes | No | PR #89 |
| CI-F13 | CI | **Medium** | No `bun audit` or equivalent dependency vulnerability scan in CI | Yes | No | PR #95 |
| CI-F8 | CI | **Low** | `ai_key_secret` validated only by regex `^[A-Z0-9_]+$`, not an allowlist | Yes | No | Deferred -- see hardening section |
| S4 | Security | **Low** | Installation token transmitted in `client_payload`; no `::add-mask::` in workflows | Yes | No | PR #92 |
| S9 | Security | **Low** | Cloudflare deploy uses static long-lived API token rather than OIDC | Yes | No | Deferred -- no Cloudflare OIDC support for wrangler-action yet |
| S12 | Security | **Low** | No Cloudflare-side rate limiting rules on the webhook route | Yes | No | Deferred -- Cloudflare dashboard config, not in-repo |
| CI-F12 | CI | **Low** | `required_approving_review_count: 0` -- merges require only passing CI, no human review | Yes | No | Deferred -- accepted for current team size |
| C8 | Cost | **Info** | GitHub App JWT rate-limit pool may be shared across installations (unconfirmed) | No | No | Deferred -- follow-up required |
| C10 | Cost | **Info** | DO quota concurrency safety relies on Cloudflare input-gate semantics (not load-tested) | No | No | Deferred -- load test follow-up required |
| CI-F9 | CI | **Info** | `bun.lock` unannotated in REUSE.toml; no `LICENSES/Apache-2.0.txt` present | Yes | No | PR #91 |
| CI-F11 | CI | **Info** | No explicit `vulnerabilityAlerts` in renovate.json | Yes | No | Deferred -- Renovate defaults acceptable |
| S3 | Security | **Info** | HMAC validation: correct, constant-time, first gate -- no bypass found | Yes | N/A (sound) | N/A (sound) |
| S5 | Security | **Info** | Token scoping: installation vs dispatch tokens correctly minimal and not cached | Yes | N/A (sound) | N/A (sound) |
| S8 | Security | **Info** | Error responses: fixed literals only, no secret/stack-trace leakage | Yes | N/A (sound) | N/A (sound) |
| S11 | Security | **Info** | `TARGET_REPO` hardcoded in `wrangler.toml`, never payload-derived | Yes | N/A (sound) | N/A (sound) |
| C7 | Cost | **Info** | GitHub API calls use installation-scoped tokens, isolated per-installation | Yes | N/A (sound) | N/A (sound) |
| C9 | Cost | **Info** | Sentry exposure bounded by same per-installation quota as dispatches | Yes | N/A (sound) | N/A (sound) |

**Verdict: RESOLVED. S1, S2, and C3 fixes are in PR #87 and PR #88. All pre-release findings are closed. Hardening findings are deferred with documented decisions. The App may be made public after PRs #87-#95 are merged.**

S1 alone is sufficient to block: a single external installer who knows any of the owner's org
secret names can cause the owner's AI-provider account to be billed for attacker-controlled
content, indefinitely, within the 50-events/24h-per-event-type quota.

---

## Confirmed Blocking Findings

### S1 -- Caller-supplied AI key model is architecturally broken

**Severity:** Critical | **Confirmed:** Yes | **Blocks public release:** Yes

**Description:**
`README.md:86-88` claims `ai.api-key-secret` resolves against a secret in the caller's own
repository. This is false. Both `issue-triage.yml` and `pr-review.yml` run in
`clouatre-labs/aptu-github-app` itself (confirmed: `docs/ARCHITECTURE.md:44`). GitHub Actions
`secrets[x]` always resolves against the repository where the workflow executes -- the owner's
own repo -- never the external caller's.

The `ai_key_secret` value is fully attacker-controlled: any external installer sets
`ai.api-key-secret` in their `.github/aptu.yml`, validated only against `/^[A-Z0-9_]+$/`
(`config.ts:27`), with no ownership check or allowlist. If that name matches any of the owner's
org secrets (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `ORG_APP_PRIVATE_KEY`,
`CLOUDFLARE_API_TOKEN`, `GITLEAKS_LICENSE`), the workflow silently injects the owner's real
credential into an API call driven by attacker-controlled repo, issue, and PR content.

This is simultaneously a secret-scoping violation and the primary cost-exposure vector. It
renders the documented cost-isolation model non-functional for any public install.

**Files:** `docs/ARCHITECTURE.md:44`, `issue-triage.yml:31`, `pr-review.yml:32-34`,
`worker/src/config.ts:27,104-124`, `worker/src/index.ts:394-399,487-493`

**Fix (choose one):**

- Require all external installs to run their own fork where workflows execute in their own repo,
  so `secrets[]` resolves against their own secrets.
- Maintain an explicit registry mapping installation ID or org to permitted secret names; reject
  any `ai_key_secret` not in the registry.
- Reinstate an owner/org allowlist (see S2) and block all external installs until a real
  per-caller credential model exists.

**Resolved:** PR #87 -- Reinstated `ALLOWED_OWNERS` allowlist as hard `403` gate; documentation updated to remove stale wording implying the `ai` block is a safe bypass for external installs. Full per-caller credential model remains a follow-up item (CI-F8).

---

### S2 -- `ALLOWED_OWNERS` gate removed; documentation describes it as active

**Severity:** High | **Confirmed:** Yes | **Blocks public release:** Yes

**Description:**
Commit `8b327ad` (`chore(worker): remove ALLOWED_OWNERS gate, quota enforcement is sufficient
(#59)`) removed 47 lines from `worker/src/index.ts`, the `ALLOWED_OWNERS` wrangler var, and
191 lines of tests. The current `Env` interface (`index.ts:15-23`) has no `ALLOWED_OWNERS`
field; `rg ALLOWED_OWNERS` across `worker/src/*.ts` and `wrangler.toml` returns zero matches.
`shouldDispatch` (`config.ts:143-151`) checks only `config[feature]?.enabled`; it never checks
repo owner or requires an `ai` block.

Yet `README.md:16,86,118` and `docs/ARCHITECTURE.md:26,134` still describe an active
`ALLOWED_OWNERS` gate requiring external installs to supply an `ai` block. Any repository can
now enable triage/review with zero `ai` block: `client_payload.ai_key_secret` is undefined,
`secrets[undefined]` resolves to empty string in the workflow, and behavior downstream in the
`aptu` CLI was not verified.

Combined with S1, this means the primary intended safeguard for public installs no longer exists
and is not documented as removed.

**Files:** `worker/src/index.ts:15-23`, `config.ts:143-151`, `README.md:16,86,118`,
`docs/ARCHITECTURE.md:26,134`

**Fix:** Either reinstate an owner/org allowlist as a hard boundary, or update `README.md` and
`docs/ARCHITECTURE.md` to remove all references to `ALLOWED_OWNERS` and document the actual
current behavior accurately. Given S1, reinstatement is the correct path.

**Resolved:** PR #87 -- Reinstated `isOwnerAllowed()` pure function and single `ALLOWED_OWNERS` gate after signature validation; `README.md` and `docs/ARCHITECTURE.md` updated.

---

### C3 -- No aggregate quota ceiling; GitHub Actions minutes scale unboundedly

**Severity:** High | **Confirmed:** Yes | **Blocks public release:** Yes

**Description:**
`QUOTA_LIMIT = 50` and `QUOTA_WINDOW_MS = 24h` (`quota.ts:9-10`) are enforced per
`installationId` per `eventType` only (key: `quota:{installationId}:{eventType}`). Each
installation can generate up to 100 dispatches per day (50 triage + 50 review). At 1,000
external installs the aggregate ceiling is 100,000 dispatches per day with no upper bound tied
to install count.

Each dispatch triggers a GitHub Actions job on `ubuntu-24.04-arm` (10-minute timeout,
`issue-triage.yml:19-20`, `pr-review.yml:19-20`) running in `clouatre-labs/aptu-github-app`,
which is a **private** repository. Private-repository Actions minutes are billed once the org
exceeds its included allocation. There is no mechanism in this codebase that scales the
per-installation quota down as install count grows, nor a total daily or monthly ceiling.

**Files:** `worker/src/quota.ts:9-10,42`, `issue-triage.yml:19-20`, `pr-review.yml:19-20`

**Fix:** Add a global aggregate quota -- a single well-known Durable Object ID tracking total
dispatches org-wide per day -- alongside the existing per-installation counter. Set an explicit
hard ceiling with alerting and a kill-switch when approached.

**Resolved:** PR #88 -- Added `GlobalQuota` Durable Object class with `idFromName('global')` singleton, `GLOBAL_QUOTA_LIMIT` Wrangler var (default 500/day), and `checkGlobalQuota()` composing into `enforceQuota()` before the per-installation check. Returns `429` with `Retry-After` when the org-wide ceiling is hit.

---

## Confirmed Non-Blocking Findings

### S6 -- `handleMentionCommand` calls GitHub API before `enforceQuota`

**Severity:** Medium | **Confirmed:** Yes

The `issues.opened` (`index.ts:346`) and `pull_request` (`index.ts:428`) flows correctly call
`enforceQuota` before any outbound API call. `handleMentionCommand` (`index.ts:249-305`) does
not: `getInstallationToken` (`line 265`) and `checkCollaboratorPermission` (`line 272`, which
performs a `fetch` to `api.github.com`) both execute before `enforceQuota` (`line 281`). Only
`dispatchEvent` (`line 291`) is gated.

Every `@aptu` mention that passes the self-mention guard generates two GitHub API calls,
regardless of quota status.

**Fix:** Move `enforceQuota(env, installationId, eventType)` to immediately after the
self-mention-guard check (after `line 261`), before `getInstallationToken`, mirroring the other
two flows.

**Resolved:** PR #94 -- Reordered `handleMentionCommand`: `enforceQuota` is now called first (after self-mention guard), before `getInstallationToken` and `checkCollaboratorPermission`.

---

### S7 -- No cross-installation aggregate quota cap (mirrors C3)

**Severity:** Medium | **Confirmed:** Yes

Same root as C3: per-installation quota has no global ceiling. See C3 fix.

---

### C5 -- DO `storage.put` fires on every exceeded-quota request

**Severity:** Medium | **Confirmed:** Yes

`InstallationQuota.fetch` (`quota.ts:64`) calls `storage.put(key, {timestamps: recent})` on
both the exceeded path and the allowed path. On the exceeded path, the write re-persists an
already-pruned list on every request, generating DO write operations with no state change.
Durable Object storage operations are billed above the free-tier inclusion.

**Fix:** Skip `storage.put` on the exceeded path when the pruned list is unchanged from the
stored list, or write only when the set of timestamps actually changes.

**Resolved:** PR #93 -- Added conditional guard to `InstallationQuota`: `storage.put` on the exceeded path is skipped when `recent.length === stored.timestamps.length` (no pruning occurred). PR #97 (post-audit) -- Applied the identical guard to `GlobalQuota`, which the original fix missed.

---

### S10 -- Known advisories in devDependency chains; no CI gate

**Severity:** Medium | **Confirmed:** Yes

`bun audit` reports 8 vulnerabilities: 2 high (`postcss` path traversal via `vitest`,
`undici` response desync via `wrangler`), 5 moderate, 1 low. All are in devDependency
transitive chains (`vitest`, `wrangler`); none are in the deployed runtime bundle
(`@octokit/auth-app`, `@octokit/request`, `@sentry/cloudflare`, `picomatch`, `yaml` show zero
advisories). The runtime Worker is not at risk, but no CI step fails the build on new advisories;
Renovate's reactive update cadence is the only mitigation.

**Fix:** Add a `bun audit --audit-level high` step to `ci.yml` to block merges on new
high/critical advisories.

**Resolved:** PR #95 -- Added `bun audit --audit-level high` step to the `lint` job in `ci.yml`. Also fixed stale `bun.lockb` path filter to `bun.lock`.

---

### CI-F4 -- `bun-version: latest` in ci.yml

**Severity:** Medium | **Confirmed:** Yes

Three jobs in `ci.yml` use `bun-version: latest`, which silently changes the toolchain on each
run. A Bun major bump can break builds without any code change.

**Fix:** Pin to a specific version (e.g. `bun-version: "1.2.19"`) and let Renovate manage
updates.

**Resolved:** PR #90 -- Pinned `bun-version` to `"1.3.14"` in all three jobs (lint, typecheck, test).

---

### CI-F10 -- Renovate automerges all github-actions updates including majors

**Severity:** Medium | **Confirmed:** Yes

`renovate.json` automerges patch, minor, digest, and pin updates with a 3-day
`minimumReleaseAge` delay. The `github-actions` package rule also automerges, with no major
version exclusion. A major action bump (e.g. `actions/checkout@v4` -> `v5`) could introduce
breaking changes silently.

**Fix:** Add `"matchUpdateTypes": ["major"]` with `"automerge": false` to the github-actions
package rule.

**Resolved:** PR #89 -- Added `matchUpdateTypes: ["major"]` + `automerge: false` rule to the `github-actions` package rule in `renovate.json`.

---

### CI-F13 -- No dependency vulnerability scan in CI

**Severity:** Medium | **Confirmed:** Yes

No `bun audit`, `npm audit`, or equivalent runs in any workflow. New advisories are surfaced
only when Renovate opens a PR, not when a PR is merged. See S10.

**Fix:** Add `bun audit --audit-level high` to the `lint` or a dedicated `audit` job in
`ci.yml`.

**Resolved:** PR #95 -- See CI-F13 above (combined fix).

---

### CI-F8 -- `ai_key_secret` validated by regex only, no allowlist

**Severity:** Low | **Confirmed:** Yes

`AI_KEY_SECRET_PATTERN` (`config.ts:27`) validates `ai.api-key-secret` against `/^[A-Z0-9_]+$/`
only. Any uppercase/underscore name is accepted, including names that match the owner's org
secrets. This is a contributing factor to S1, not an independent issue.

**Fix:** Depends on S1 resolution. If an allowlist model is adopted, the pattern check becomes
redundant.

**Deferred:** With `ALLOWED_OWNERS` allowlist (PR #87) blocking all external installs, the regex validation is now a secondary gate with no security impact. Removal or tightening deferred until the per-caller credential model is revisited.

---

### S4 -- Installation token in `client_payload` without `add-mask`

**Severity:** Low | **Confirmed:** Yes

`getInstallationToken` and `getDispatchToken` return raw bearer tokens passed into
`client_payload.installation_token` (`index.ts:292,390,481`). The token is referenced as
`github.event.client_payload.installation_token` in both workflow files. GitHub Actions
auto-masks registered secrets but does not automatically mask values arriving via
`client_payload`. No `::add-mask::` call was found in either workflow.

The token is short-lived (~1 hour) and visible in webhook delivery logs and GitHub audit trails
during that window.

**Fix:** Add `echo "::add-mask::${{ github.event.client_payload.installation_token }}"` as the
first step in both workflow jobs before the token is used.

**Resolved:** PR #92 -- Added "Mask installation token" step as first step in both `triage` and `review` jobs.

---

### S9 -- Cloudflare deploy uses static long-lived API token

**Severity:** Low | **Confirmed:** Yes

`deploy.yml` uses `secrets.CLOUDFLARE_API_TOKEN` -- a static, long-lived credential stored as
a GitHub Actions secret. Cloudflare does not yet offer a first-class OIDC provider integration
for `wrangler-action` equivalent to AWS/Azure/GCP, making this a common and acceptable pattern
for now, but a lesser-security posture than short-lived OIDC credentials.

**Fix:** Track as a low-priority hardening item. Revisit when Cloudflare adds OIDC support for
`wrangler-action`.

**Deferred:** No Cloudflare OIDC support for `wrangler-action` is available as of 2026-08-04. Accepted as-is; revisit when Cloudflare adds OIDC integration.

---

### S12 -- No Cloudflare-side rate limiting on the webhook route

**Severity:** Low | **Confirmed:** Yes

`wrangler.toml` defines no Cloudflare Rate Limiting Rules or WAF configuration. Any request
with a valid HMAC signature reaches the handler; the application-level per-installation quota is
the only volume control. A single installation generating rapid-fire valid webhook deliveries
(e.g. via comment spam) can approach Cloudflare Worker free-tier limits (100,000
requests/day).

**Fix:** Add Cloudflare Rate Limiting Rules on `aptu.dev/webhook` as a backstop, independent of
application-level quota.

**Deferred:** Cloudflare dashboard configuration, not in-repo. Tracked as a hardening item to configure post-release.

---

### CI-F12 -- No required human review on main

**Severity:** Low | **Confirmed:** Yes

The branch ruleset on `main` (`ruleset 18072797`) requires passing CI and a signed commit but
sets `required_approving_review_count: 0`. Merges require no human approval. For an internal
solo project this is expected; for a publicly-facing app it is worth documenting as an accepted
risk.

**Fix:** Accept as-is for current team size, or require 1 approver for changes to
`.github/workflows/` specifically.

**Deferred:** Accepted for current team size. Branch ruleset update deferred.

---

### CI-F9 -- `bun.lock` unannotated in REUSE.toml

**Severity:** Info | **Confirmed:** Yes

`bun.lock` has no REUSE annotation in `REUSE.toml` and no inline SPDX header. 36 of 37 files
are compliant. No `LICENSES/Apache-2.0.txt` file is present in the repo root.

**Fix:** Add `bun.lock` to `REUSE.toml` under the appropriate annotation, and add
`LICENSES/Apache-2.0.txt`.

**Resolved:** PR #91 -- Added `bun.lock` annotation to `REUSE.toml` and created `LICENSES/Apache-2.0.txt`.

---

### CI-F11 -- No `vulnerabilityAlerts` in renovate.json

**Severity:** Info | **Confirmed:** Yes

`renovate.json` does not explicitly configure `vulnerabilityAlerts`, relying on Renovate
defaults. This means security-advisory-triggered PRs may not be prioritized or auto-merged
on a faster cadence than regular updates.

**Fix:** Add `"vulnerabilityAlerts": {"enabled": true, "automerge": true}` to `renovate.json`.

**Deferred:** Renovate defaults are acceptable for now. `bun audit --audit-level high` in CI (PR #95) provides equivalent blocking coverage.

---

## Validated Sound (Non-Findings)

### S3 -- HMAC signature validation

Every request passes through `validateSignature` (`index.ts:33-52`) before `JSON.parse` or
any event-type branching (`index.ts:312-321`). The implementation uses
`crypto.subtle.verify` (Web Crypto), which performs constant-time HMAC comparison. Headers
without the `sha256=` prefix are rejected immediately. No bypass path was found. Test coverage
confirms missing-header (401), mismatched-signature (401), and valid-signature cases.

---

### S5 -- Token scoping

Per-operation scoped tokens replace the previous broad installation token. A `PERMS`
lookup table defines five permission sets, and a single `getScopedToken` helper issues
tokens with minimum required permissions:

- `PERMS.config`: `contents:read`, `pull_requests:read` -- for config fetch, PR file
  listing, and collaborator permission checks
- `PERMS.triage`: `contents:read`, `issues:write` -- passed to aptu-triage workflow
- `PERMS.review`: `contents:read`, `pull_requests:write` -- passed to aptu-review workflow
- `PERMS.scan`: `contents:read`, `security_events:write`, `statuses:write` -- passed to
  aptu-scan-security workflow (requires App installation to have Security events permission)
- `PERMS.dispatch`: `contents:write` -- scoped to `TARGET_REPO` only for
  `repository_dispatch`

All tokens are created fresh per request via `createAppAuth` with `repositoryNames` and
`permissions` passed to `auth({ type: 'installation', ... })`. A `getTokenOr500` helper
DRYs up the try/catch pattern in the fetch handler. No module-level token storage exists.

---

### S8 -- Error response leakage

All error responses use fixed literals (`Unauthorized`, `Bad Request`, `Forbidden`,
`Internal Server Error`, `Method Not Allowed`). No response body interpolates `error.message`,
stack traces, secret values, or internal state. `console.error` calls log only `Error` objects,
repo names, and numeric IDs -- never token values.

---

### S11 -- `TARGET_REPO` is not attacker-influenceable

`TARGET_REPO` is a hardcoded Wrangler var (`wrangler.toml:7`, value
`clouatre-labs/aptu-github-app`). All three dispatch flows derive `targetRepo` and
`targetRepoName` from `env.TARGET_REPO`, never from webhook payload fields. Repository dispatch
cannot be redirected by a crafted payload.

---

### C7 -- GitHub API calls isolated per-installation

`fetchRepoConfig` (`config.ts:29-51`) and the PR-files fetch (`index.ts:113-153`) authenticate
with the calling installation's own scoped token. GitHub tracks rate limits per-installation for
installation-token-authenticated calls. External installs cannot exhaust a shared owner-wide
GitHub API budget via these paths.

---

### C9 -- Sentry event volume bounded by quota

All `captureException` calls in the `issues.opened` and `pull_request` flows occur after
`enforceQuota` has passed (`index.ts:346,428`). Sentry event volume inherits the same
per-installation 50/24h ceiling as dispatches. Sentry is not independently amplifiable beyond
the quota gap identified in C3.

---

## Unconfirmed Claims (Require Follow-up)

### C8 -- GitHub App JWT rate-limit pool (unconfirmed)

`getInstallationToken` and `getDispatchToken` both use `createAppAuth` JWT-authenticated
calls to GitHub's token-exchange endpoint. App-level JWT rate limits may be shared across all
installations rather than isolated per-installation. If shared, a large volume of external
installs could approach the App-level ceiling and degrade availability for all installs. This
was not independently verified against live GitHub documentation in this session.

**Follow-up:** Verify GitHub's current rate-limit model for App JWT-authenticated endpoints and,
if shared, consider caching installation tokens within their ~1h validity window to reduce
token-exchange call volume.

---

### C10 -- Durable Object concurrency safety (not load-tested)

`InstallationQuota` relies on Cloudflare's default input-gate concurrency model to serialize
concurrent requests to the same DO instance, preventing race conditions in the quota counter. No
load test was performed to confirm that concurrent requests for the same `installationId` and
`eventType` cannot exceed `QUOTA_LIMIT`.

**Follow-up:** Run a load test firing N concurrent requests for the same installation and confirm
the counter never exceeds `QUOTA_LIMIT`. No code change indicated by static analysis.

---

## Recommended Resolution Order

| Priority | Finding(s) | Action |
| --- | --- | --- |
| 1 -- Blocking | S1, S2 | Reinstate owner allowlist OR redesign caller-key model; update docs |
| 2 -- Blocking | C3, S7 | Add global aggregate quota with hard ceiling and alerting |
| 3 -- Pre-public | S6 | Move `enforceQuota` before `getInstallationToken` in `handleMentionCommand` |
| 4 -- Pre-public | S4 | Add `::add-mask::` for `installation_token` in both workflow files |
| 5 -- Hardening | S10, CI-F13 | Add `bun audit --audit-level high` to CI |
| 6 -- Hardening | CI-F4 | Pin `bun-version` in ci.yml |
| 7 -- Hardening | CI-F10 | Exclude majors from Renovate github-actions automerge |
| 8 -- Hardening | C5 | Skip DO `storage.put` on exceeded path when state unchanged |
| 9 -- Hardening | S12 | Add Cloudflare rate limiting rules on the webhook route |
| 10 -- Cleanup | CI-F8, CI-F9, CI-F11, CI-F12 | Pattern allowlist, REUSE gaps, Renovate alerts, review policy |
| 11 -- Follow-up | C8, C10 | JWT rate-limit research, DO concurrency load test |

---

## Post-Audit Fixes (2026-08-05)

A post-merge verification pass identified two issues not covered by PRs #87-#95. Both were
fixed and merged on 2026-08-05.

### PR #96 -- Biome formatting error in `index.ts` (CI blocker)

**Finding:** A spurious blank line at `worker/src/index.ts:10` -- between the
`export { GlobalQuota, InstallationQuota }` re-export block introduced by PR #88 and the
`@sentry/cloudflare` import -- caused `biome check` to fail. The current `HEAD` after merging
PRs #87-#95 would fail CI on any new PR touching that file.

**Fix:** Removed the blank line. One line deleted, no logic change.

**Verified:** `bun run biome check` 0 errors, `bun test` 99/99 pass.

---

### PR #97 -- `GlobalQuota` missing conditional `storage.put` guard (C5 incomplete)

**Finding:** PR #93 applied the conditional `storage.put` guard to `InstallationQuota` but not
to `GlobalQuota`. The `GlobalQuota.fetch()` exceeded path (introduced by PR #88) called
`storage.put` unconditionally on every request, even when no timestamps were pruned and the
stored state was unchanged -- the identical C5 pattern in `InstallationQuota` before PR #93.

**Fix:** Wrapped the exceeded-path `storage.put` in `GlobalQuota` with the same conditional
guard used in `InstallationQuota`: skip the write when `recent.length` equals the stored
timestamps length. Added two tests covering the skip and write scenarios.

**Verified:** `bun test` 101/101 pass (2 new tests), `bun run biome check` 0 errors on changed
files.

---

## Deferred Items Reference

The following findings were accepted as deferred during the original audit. They are tracked
here as the canonical record; no separate issues were opened.

| Finding | Decision | Condition for revisit |
| --- | --- | --- |
| CI-F8 -- `ai_key_secret` regex only | Moot while `ALLOWED_OWNERS` blocks all external installs | Revisit when per-caller credential model is designed |
| S9 -- Long-lived Cloudflare API token | No OIDC alternative available for `wrangler-action` | Revisit when Cloudflare adds OIDC support |
| S12 -- No Cloudflare-side rate limiting | Dashboard config, not in-repo | Configure post-release in Cloudflare dashboard |
| CI-F12 -- No required human review | Accepted for current team size | Revisit if team grows or external contributors are added |
| CI-F11 -- No `vulnerabilityAlerts` in Renovate | `bun audit --audit-level high` in CI provides equivalent blocking coverage | Revisit if Renovate advisory PR cadence becomes important |
| C8 -- JWT rate-limit pool isolation | Not confirmed; requires research against live GitHub docs | Verify and cache tokens if pool is shared |
| C10 -- DO concurrency safety | Not load-tested; Cloudflare input-gate semantics assumed correct | Run load test before scaling to high install counts |

---

### Resolution Note (2026-08-23 -- Issue #142)

**Resolution:** Issue #142 resolved findings S1 and CI-F8 by replacing the dynamic `secrets[ai_key_secret]`
lookup with a fixed event-type-to-secret mapping (`secrets.OPENROUTER_API_KEY`). Removed `api-key-secret`
from `AiConfig` schema, deleted `AI_KEY_SECRET_PATTERN`, removed `ai_key_secret` from dispatch payloads,
and removed the AI quota exemption.
