# Audit: Scan Security Status Check, Privacy, and Data Residency

Date: 2026-08-22
Commit: a7dca25
Trigger: Broken `aptu-scan-security` status check link on `clouatre-labs/clouatre.ca` PR #1374

> **Amendment (2026-08-23):** Findings V08 and V09 originally recommended setting
> `retention-days` as a per-job key in workflow YAML. This is incorrect.
> `retention-days` is not a valid job-level key in GitHub Actions workflow syntax;
> it is a valid input parameter for `actions/upload-artifact` only. Workflow log
> retention is configured at the GitHub organization, repository, or enterprise
> settings level. The fix recommendations in V08 and V09 have been corrected.
> See [PR #148](https://github.com/clouatre-labs/aptu-github-app/pull/148).

## See Also

- [ARCHITECTURE.md](../ARCHITECTURE.md) -- module map and data flow
- [RUNBOOK.md](../RUNBOOK.md) -- operational procedures
- [SECURITY.md](../../SECURITY.md) -- vulnerability disclosure policy
- [2026-08-pre-public-release.md](./2026-08-pre-public-release.md) -- prior security and cost audit

## Purpose

Point-in-time audit triggered by a broken status check link observed on
`clouatre-labs/clouatre.ca` PR #1374. The `aptu-scan-security` check linked to
`https://github.com/clouatre-labs/aptu-github-app/actions/runs/32604514331`, which returns 404
for users without access to the private `aptu-github-app` repository. This audit expands beyond
the link issue to assess privacy and data residency across the full architecture.

Three axes:

1. **Scan workflow correctness** -- broken `target_url`, SARIF upload handling, status
   classification
2. **Privacy** -- caller source code on runners, installation token exposure, AI provider data
   transmission, documentation gaps
3. **Data residency** -- processing locations for GitHub runners, Cloudflare Worker, and AI
   providers

## Methodology

Two read-only research delegates analyzed the codebase in parallel:

- **Scout** (coder-scout, openai/gpt-5.6-luna): investigated the broken `target_url` mechanism,
  GitHub Actions context semantics, SARIF upload correctness, and workflow best practices
- **Guard** (coder-guard, openai/gpt-5.6-luna): assessed privacy implications, installation
  token exposure, AI provider data transmission, data residency, and documentation gaps

Each finding was verified against actual source files, workflow YAML, and the Worker source
code. Each delegate wrote a structured JSON handoff. This document synthesizes both, with
cross-checks noted where findings overlap.

No code was modified during this audit.

---

## Part 1: Scan Workflow Correctness

### V01 -- `target_url` points to private repo Actions run; users get 404

**Severity:** High | **Issue:** [#136](https://github.com/clouatre-labs/aptu-github-app/issues/136)

The "Report status to caller" step in `scan-security.yml` constructs the status check
`target_url` as:

```yaml
-f target_url="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

In a `repository_dispatch` workflow, `github.repository` resolves to the repository that
**receives** the dispatch event -- `clouatre-labs/aptu-github-app` -- not the originating
caller's repository. The `actions/checkout` step's `repository` parameter controls only which
source code is checked out; it does not change the workflow execution context.

Since `aptu-github-app` is private, the Actions run URL returns 404 for any user who does not
have access to that repository. This includes all external collaborators on the caller's PR
and any automated tooling that follows the link.

**Observed on** `clouatre-labs/clouatre.ca#1374`:

```text
aptu-scan-security  pass  0  https://github.com/clouatre-labs/aptu-github-app/actions/runs/32604613543  aptu security scan passed
```

**Fix:** Set `target_url` to the caller's PR URL:
`https://github.com/${{ github.event.client_payload.originating_repo }}/pull/${{ github.event.client_payload.pull_number }}`,
or omit `target_url` entirely. Alternatively, create a check run in the caller's repo via
`POST /repos/{originating_repo}/check-runs` with caller-visible details (requires
`checks: write` permission on the App).

---

### V02 -- SARIF upload failures silently tolerated

**Severity:** Medium | **Issue:** [#136](https://github.com/clouatre-labs/aptu-github-app/issues/136)

The "Upload SARIF to caller" step in `scan-security.yml` uses `continue-on-error: true`. A
missing or invalid SARIF file, permission failure, unsupported ref, API rejection, or malformed
response can leave no code-scanning result in the caller's repository while the workflow
continues and reports a passing status.

The step condition `if: always() && hashFiles('findings.sarif') != ''` is appropriate for
preserving results after a failing scan, but does not make upload success observable. The
caller sees `aptu-scan-security: pass` regardless of whether SARIF was successfully uploaded.

**Fix:** Remove `continue-on-error: true` or add a separate failure signal. Check the API
response status code and fail the step (or post a distinct status) when SARIF ingestion fails.

---

### V03 -- Status classification is binary

**Severity:** Medium | **Issue:** [#136](https://github.com/clouatre-labs/aptu-github-app/issues/136)

The "Report status to caller" step maps `steps.scan.conclusion == success` to `success` and
every other conclusion to `failure`. This does not distinguish scan findings (the aptu action
failed due to `fail-on` severity match) from operational errors (action failure, timeout,
cancelled, SARIF upload failure). The status description is either "aptu security scan passed"
or "aptu security scan found issues" regardless of the actual cause.

**Fix:** Use explicit outcomes for scan, SARIF upload, and status publication. Reserve
"aptu security scan found issues" for findings; use "aptu security scan encountered an error"
for operational failures. Ensure the status is always posted even when earlier steps fail.

---

### V04 -- Legacy commit status instead of check run

**Severity:** Low | **Issue:** [#136](https://github.com/clouatre-labs/aptu-github-app/issues/136)

The workflow uses `POST /repos/{repo}/statuses/{sha}` to create a legacy commit status. GitHub
check runs provide richer output, annotations, caller-visible details URLs, and summary
markdown. Check run creation requires `checks: write` permission on the GitHub App.

**Fix:** Consider migrating to check runs via `POST /repos/{originating_repo}/check-runs` if
richer caller-visible reporting is needed. Optional if the current status check is sufficient
for branch protection requirements.

---

## Part 2: Privacy

### V05 -- Installation token in repository_dispatch client_payload

**Severity:** High | **Issue:** [#137](https://github.com/clouatre-labs/aptu-github-app/issues/137)

The Worker passes the caller's `installation_token` as a field in the `repository_dispatch`
`client_payload` for all three event types (triage, review, scan). This is event data sent to
GitHub's dispatch API, not a GitHub Actions secret.

The workflows use `echo "::add-mask::${{ github.event.client_payload.installation_token }}"` as
the first step. GitHub Actions `::add-mask::` masks exact matching text in subsequent **log
output** only. It does not remove the value from the dispatch event payload, event metadata,
process environment, action inputs, or GitHub API request history. Any code or action executing
in the workflow can access the token via `github.event.client_payload.installation_token`.

The token is short-lived (~1 hour, GitHub default) and scoped to the caller's repository with
minimum permissions, but it remains a bearer credential delivered in dispatch data.

**Files:** `worker/src/index.ts` (dispatchEvent calls), all three workflow YAML files.

**Fix:** Redesign to avoid placing bearer tokens in event payloads. Mint the installation token
inside the workflow using `actions/create-github-app-token` with App credentials stored as
workflow secrets, or use a short-lived token exchange mechanism.

---

### V06 -- `::add-mask::` limitations

**Severity:** Low | **Issue:** [#137](https://github.com/clouatre-labs/aptu-github-app/issues/137)

The `::add-mask::` command masks exact matching text in workflow log output only. It does not
encrypt or remove the token from the repository_dispatch payload, event metadata, process
environment, action inputs, or derived values. It is not sufficient as the sole token-protection
control. Contributing factor to V05, not an independent issue. The fix for V05 (removing the
token from client_payload) eliminates this concern entirely.

---

### V07 -- AI API key resolution documentation

**Severity:** Info | **Issue:** [#137](https://github.com/clouatre-labs/aptu-github-app/issues/137)

The prior pre-public-release audit (S1) identified that `secrets[github.event.client_payload.ai_key_secret]`
resolves against `aptu-github-app`'s secrets, not the caller's repository. PR #87 corrected most
documentation. The README "External installation example" section and ARCHITECTURE.md
"Caller-Supplied AI Keys" section still contain language implying caller-side resolution.

**Fix:** Ensure all passages consistently state that `api-key-secret` names a secret in the
`aptu-github-app` repository.

---

### V08 -- Caller source code on GitHub-hosted runner

**Severity:** Medium | **Issue:** [#138](https://github.com/clouatre-labs/aptu-github-app/issues/138)

The `scan-security.yml` workflow checks out the caller's private repository code on a
GitHub-hosted runner (`ubuntu-24.04-arm`) in the `aptu-github-app` repository. GitHub documents
that hosted runners run in fresh, isolated VMs that are discarded after the job.

However, anyone with Actions read access to `aptu-github-app` can view workflow logs via the
Actions UI or REST API. Source code can appear in logs if the aptu action, scripts, error
diagnostics, or commands print it. The workflow does not establish a source-code logging
prohibition.

**Fix:** Disable verbose/source-bearing diagnostics, review aptu action logging behavior,
and restrict Actions read access. Workflow log retention is configured at the GitHub
organization, repository, or enterprise settings level, not per-job in workflow YAML.
`retention-days` is a valid input parameter for `actions/upload-artifact` only, not a
job-level key. Document the intended retention period as an operational policy and enforce
it via GitHub org/repo settings.

---

### V09 -- No GitHub Actions log retention policy

**Severity:** Medium | **Issue:** [#138](https://github.com/clouatre-labs/aptu-github-app/issues/138)

No workflow in the repository configures log retention. GitHub's default retention applies (90 days
for private repos with configurable org/enterprise settings). No documentation specifies the
intended retention period, access controls, or deletion procedures for workflow logs that may
contain caller source code or commit metadata.

`retention-days` is not a valid job-level key in GitHub Actions workflow syntax. It is a valid
input parameter for the `actions/upload-artifact` action only. Workflow log retention is
configured at the GitHub organization, repository, or enterprise settings level.

**Fix:** Document the intended retention period as an operational policy. Enforce it via GitHub
org/repo settings, not workflow YAML. Document access controls and deletion procedures for
workflow logs that may contain caller source code or commit metadata.

---

### V10 -- SARIF content policy undefined

**Severity:** Medium | **Issue:** [#138](https://github.com/clouatre-labs/aptu-github-app/issues/138)

The scan workflow uploads `findings.sarif` to the caller's code scanning API. SARIF files
normally contain tool metadata, rules, results, messages, severity levels, and artifact
locations (file paths and line/region coordinates). A result message may include a code snippet
as region context, depending on the SARIF generator's configuration.

The aptu action's SARIF generation behavior (whether snippets are included) is not documented
in this repository.

**Fix:** Inspect aptu's SARIF generator output, document whether code snippets are included,
and define a policy on permitted SARIF content.

---

### V11 -- No privacy policy, data inventory, or residency documentation

**Severity:** High | **Issue:** [#138](https://github.com/clouatre-labs/aptu-github-app/issues/138)

The repository has `SECURITY.md` (attack surface), `AI_POLICY.md` (contributor AI usage), and
`ARCHITECTURE.md` (system design). None constitute a privacy policy. The following are absent:

- Privacy policy or privacy notice
- Data processing agreement (DPA) or reference
- Data inventory or data-flow diagram
- Provider-specific terms, account tier, retention, and subprocessor records
- Data-subject rights process
- Breach notification process

The architecture processes personal data when GitHub event content includes commit author
names, usernames, email addresses, issue authors, commenters, reviewer identities, IP/technical
metadata, or personal data embedded in source, diffs, issue text, or instructions.

**Fix:** Create `docs/PRIVACY.md` covering data collected, processing purposes, recipients,
retention schedules, data-subject rights, breach process, and contact point. Create
`docs/DATA_FLOW.md` with a data-flow diagram showing all processing locations and transfers.

---

## Part 3: Data Residency

### V12 -- No data residency documentation

**Severity:** Medium | **Issue:** [#138](https://github.com/clouatre-labs/aptu-github-app/issues/138)

No repository documentation defines data residency, processing locations, cross-border
transfers, regional controls, or provider subprocessors.

| Component | Processing Location | Region Control | Documented |
| --- | --- | --- | --- |
| GitHub-hosted runners | GitHub/Microsoft Azure; region not selectable by runner label | No geographic guarantee from `ubuntu-24.04-arm` | No |
| Cloudflare Worker | Cloudflare global edge network | No Regional Services or Data Localization Suite configured | No |
| AI providers (Gemini, Anthropic) | Provider-specific; depends on account tier and endpoint | No regional endpoint configured | No |
| OpenRouter | Multi-provider routing; EU/US in-region available for enterprise | No routing control; fallback to OpenRouter on provider failure | No |
| SARIF storage | Caller's GitHub repo (code scanning) | Follows caller's GitHub data residency | Correct target |

For a Canadian organization, PIPEDA does not prohibit cross-border processing but requires
accountability, notice, safeguards, contractual oversight, and transfer transparency.

**Fix:** Publish a data residency statement documenting processing locations, cross-border
transfers, regional controls (or lack thereof), and provider subprocessors.

---

## Summary

*Table: Finding counts by category.*

| Category | Count | Severity breakdown |
| --- | --- | --- |
| Scan workflow correctness | 4 findings | 1 High, 2 Medium, 1 Low |
| Privacy | 7 findings | 2 High, 3 Medium, 1 Low, 1 Info |
| Data residency | 1 finding | 1 Medium |

**Three issues opened.** The scan workflow's `target_url` is broken for all external viewers.
The installation token in `client_payload` is a bearer credential with masking that protects log
text only. No privacy policy, data-flow inventory, or residency documentation exists despite the
architecture processing caller source code, commit metadata, and issue text across GitHub-hosted
runners, Cloudflare's global edge, and third-party AI providers.

---

## Not-Findings

*Table: Items checked and confirmed clean.*

| Item | Result |
| --- | --- |
| SARIF upload target and ref pairing | Correct: `originating_repo` with `commit_sha=head_sha` and `ref=refs/pull/{pull_number}/head` |
| Only scan-security.yml posts status checks | Confirmed: `pr-review.yml` and `issue-triage.yml` contain no status or `target_url` step |
| Worker token scoping | Correct: per-operation scoped tokens via `PERMS` lookup, minimum permissions, not cached |
| HMAC signature validation | Correct: `crypto.subtle.verify` (constant-time), first gate before JSON parse, no bypass found |
| Error response leakage | Clean: all error responses use fixed literals, no interpolation of error messages or secrets |
| `TARGET_REPO` not attacker-influenceable | Confirmed: hardcoded Wrangler var, never derived from webhook payload |
| Replay deduplication | Correct: `ReplayGuard` Durable Object with atomic check-and-record, 300s alarm cleanup |
| IP validation | Correct: fail-open with 3600s cache against GitHub `/meta` hooks CIDRs |
| `ALLOWED_OWNERS` gate | Confirmed active: hard 403 on non-allowed owners before any dispatch |
| Quota enforcement (per-installation) | Correct: 50 events per event type per 24h rolling window, bypassed when `ai` block present |

---

## Open Issues Cross-Reference

| Issue | Title | Findings |
| --- | --- | --- |
| [#136](https://github.com/clouatre-labs/aptu-github-app/issues/136) | fix(scan): broken target_url, silent SARIF failures, binary status | V01, V02, V03, V04 |
| [#137](https://github.com/clouatre-labs/aptu-github-app/issues/137) | fix(security): installation token in dispatch payload and masking limitations | V05, V06, V07 |
| [#138](https://github.com/clouatre-labs/aptu-github-app/issues/138) | docs: privacy policy, data inventory, and residency documentation | V08, V09, V10, V11, V12 |
| [#147](https://github.com/clouatre-labs/aptu-github-app/issues/147) | docs: rescoped privacy policy, data-flow inventory, and audit amendment | V08, V09 (amended), V10, V11, V12 |
| [aptu#1494](https://github.com/clouatre-labs/aptu/issues/1494) | feat(scan): SARIF content policy, data minimization, and provider data controls | V08, V10 |
