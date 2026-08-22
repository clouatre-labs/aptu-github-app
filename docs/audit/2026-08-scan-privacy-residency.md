# Audit: Scan Security Status Check, Privacy, and Data Residency -- August 2026

Audit date: 2026-08-22

Status: Open. Three issues opened to address findings. See Summary Table for issue mapping.

## See Also

- [ARCHITECTURE.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/ARCHITECTURE.md) -- module map and data flow
- [RUNBOOK.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/RUNBOOK.md) -- operational procedures
- [SECURITY.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/SECURITY.md) -- vulnerability disclosure policy
- [Pre-Public-Release Audit (2026-08)](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/audit/2026-08-pre-public-release.md) -- prior security and cost audit

## Purpose

Point-in-time audit of `aptu-github-app` triggered by a broken status check link observed on
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

---

## Methodology

Two independent read-only research delegates analyzed the codebase in parallel:

- **Scout** (coder-scout, openai/gpt-5.6-luna): investigated the broken `target_url` mechanism,
  GitHub Actions context semantics, SARIF upload correctness, and workflow best practices
- **Guard** (coder-guard, openai/gpt-5.6-luna): assessed privacy implications, installation
  token exposure, AI provider data transmission, data residency, and documentation gaps

Each finding was verified against actual source files, workflow YAML, and the Worker source
code. Severity levels: Critical, High, Medium, Low, Info.

Evidence was validated against `origin/main` at commit `a7dca25` (2026-08-22).

---

## Summary Table

| # | Axis | Severity | Finding | Issue |
| --- | --- | --- | --- | --- |
| V1 | Correctness | **High** | `target_url` in scan-security.yml points to private repo Actions run; users get 404 | #136 |
| V2 | Privacy | **High** | Installation token passed as bearer credential in `repository_dispatch` client_payload | #137 |
| V3 | Privacy | **High** | No privacy policy, data-flow inventory, or residency documentation exists | #138 |
| V4 | Correctness | **Medium** | SARIF upload failures silently tolerated via `continue-on-error: true` | #136 |
| V5 | Correctness | **Medium** | Status classification is binary; does not distinguish scan findings from operational errors | #136 |
| V6 | Privacy | **Medium** | Caller source code checked out on GitHub-hosted runner; accessible in Actions logs to anyone with Actions read access | #138 |
| V7 | Privacy | **Medium** | No GitHub Actions log retention or access-control policy documented | #138 |
| V8 | Privacy | **Medium** | SARIF content policy undefined; may contain file paths and code snippets | #138 |
| V9 | Residency | **Medium** | No data residency documentation for GitHub runners, Cloudflare Worker, or AI providers | #138 |
| V10 | Correctness | **Low** | Legacy commit status used instead of check run; check runs provide richer caller-visible output | #136 |
| V11 | Privacy | **Low** | `::add-mask::` masks log text only; does not protect token in event payload, metadata, or action inputs | #137 |
| V12 | Privacy | **Info** | AI API key resolves from `aptu-github-app` secrets, not caller's repo; documentation corrected in prior audit (S1) but README still implies caller-side resolution in some passages | #137 |

---

## Detailed Findings

### V1 -- Broken `target_url` in scan-security.yml status check

**Severity:** High | **Issue:** #136

**Description:**

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

**Files:** `.github/workflows/scan-security.yml` (Report status to caller step)

**Fix options (choose one):**

1. Set `target_url` to the caller's PR URL:
   `https://github.com/${{ github.event.client_payload.originating_repo }}/pull/${{ github.event.client_payload.pull_number }}`
2. Omit `target_url` entirely; GitHub renders the status check without a link
3. Create a check run in the caller's repo via `POST /repos/{originating_repo}/check-runs`
   with caller-visible details (requires `checks: write` permission on the App)

---

### V2 -- Installation token in repository_dispatch client_payload

**Severity:** High | **Issue:** #137

**Description:**

The Worker passes the caller's `installation_token` as a field in the `repository_dispatch`
`client_payload` for all three event types (triage, review, scan). This is event data sent to
GitHub's dispatch API, not a GitHub Actions secret.

The workflows use `echo "::add-mask::${{ github.event.client_payload.installation_token }}"` as
the first step. GitHub Actions `::add-mask::` masks exact matching text in subsequent **log
output** only. It does not:

- Remove the value from the dispatch event payload or event metadata
- Prevent access via `github.event.client_payload.installation_token` in any step, action,
  or script
- Protect the value in process environment, action inputs, or GitHub API request history
- Prevent a compromised or malicious action from exfiltrating the token

Any code or action executing in the workflow can access the token via the event payload. The
token is short-lived (~1 hour, GitHub default) and scoped to the caller's repository with
minimum permissions, but it remains a bearer credential delivered in dispatch data.

**Files:** `worker/src/index.ts` (dispatchEvent calls for all three event types),
`.github/workflows/scan-security.yml`, `.github/workflows/pr-review.yml`,
`.github/workflows/issue-triage.yml`

**Fix:** Redesign to avoid placing bearer tokens in event payloads. Options:

1. Mint the installation token inside the workflow using `actions/create-github-app-token` with
   App credentials stored as workflow secrets (`APP_ID`, `APP_PRIVATE_KEY`)
2. Use a short-lived token exchange mechanism where the dispatch carries a nonce, not a token
3. If the current design is retained, add defense-in-depth: restrict who can modify the workflow
   files, pin all actions to trusted SHAs, and never print event payloads or debug context

---

### V3 -- No privacy policy, data inventory, or residency documentation

**Severity:** High | **Issue:** #138

**Description:**

The repository has `SECURITY.md` (covers attack surface and vulnerability disclosure),
`AI_POLICY.md` (covers contributor AI usage), and `ARCHITECTURE.md` (covers system design).
None of these constitute a privacy policy or data processing documentation.

The following are absent from the repository:

- Privacy policy or privacy notice
- Data processing agreement (DPA) or reference
- Data inventory or data-flow diagram identifying what data is collected, processed,
  transmitted, and retained
- Provider-specific terms, account tier, model, endpoint, training-use, abuse-monitoring,
  prompt-logging, deletion, or subprocessor records
- GitHub Actions log/artifact retention setting or access-control policy
- Token lifecycle, event-payload exposure, incident revocation, or secret-name allowlist policy
- SARIF content policy (whether snippets or sensitive paths may be uploaded)
- Data-subject rights process
- Breach notification process
- Data residency statement covering GitHub, Cloudflare, each AI provider, OpenRouter upstreams,
  logs, and SARIF

The architecture processes personal data when GitHub event content includes commit author
names, usernames, email addresses, issue authors, commenters, reviewer identities, IP/technical
metadata, or personal data embedded in source, diffs, issue text, or instructions.

**Files:** No privacy-related files exist. `SECURITY.md`, `AI_POLICY.md`, `README.md`,
`docs/ARCHITECTURE.md` reviewed; none contain privacy or data processing documentation.

**Fix:** Create a `docs/PRIVACY.md` covering: data collected (source code, diffs, issue text,
commit metadata, instructions), processing purposes (triage, review, security scan), recipients
(GitHub, Cloudflare, AI providers), retention schedules, data-subject rights, breach process,
and contact point. Create a `docs/DATA_FLOW.md` with a data-flow diagram showing all processing
locations and data transfers.

---

### V4 -- SARIF upload failures silently tolerated

**Severity:** Medium | **Issue:** #136

**Description:**

The "Upload SARIF to caller" step in `scan-security.yml` uses `continue-on-error: true`. A
missing or invalid SARIF file, permission failure, unsupported ref, API rejection, or malformed
response can leave no code-scanning result in the caller's repository while the workflow
continues and reports a passing status.

The step condition `if: always() && hashFiles('findings.sarif') != ''` is appropriate for
preserving results after a failing scan, but does not make upload success observable. The
caller sees `aptu-scan-security: pass` regardless of whether SARIF was successfully uploaded.

**Files:** `.github/workflows/scan-security.yml` (Upload SARIF to caller step)

**Fix:** Remove `continue-on-error: true` or add a separate failure signal. Check the API
response status code and fail the step (or post a distinct status) when SARIF ingestion fails.

---

### V5 -- Status classification is binary

**Severity:** Medium | **Issue:** #136

**Description:**

The "Report status to caller" step maps `steps.scan.conclusion == success` to `success` and
every other conclusion to `failure`. This does not distinguish:

- Scan findings (the aptu action failed due to `fail-on` severity match)
- Operational errors (action failure, timeout, cancelled, SARIF upload failure)
- Skipped steps

The status description is either "aptu security scan passed" or "aptu security scan found
issues" regardless of the actual cause.

**Files:** `.github/workflows/scan-security.yml` (Report status to caller step)

**Fix:** Use explicit outcomes for scan, SARIF upload, and status publication. Reserve
"aptu security scan found issues" for findings, and use "aptu security scan encountered an
error" for operational failures. Ensure the status is always posted even when earlier steps
fail.

---

### V6 -- Caller source code on GitHub-hosted runner

**Severity:** Medium | **Issue:** #138

**Description:**

The `scan-security.yml` workflow checks out the caller's private repository code on a
GitHub-hosted runner (`ubuntu-24.04-arm`) in the `aptu-github-app` repository. GitHub
documents that hosted runners run in fresh, isolated VMs that are discarded after the job.

However, anyone with Actions read access to `aptu-github-app` can view workflow logs via the
Actions UI or REST API. Source code can appear in logs if the aptu action, scripts, error
diagnostics, or commands print it. The workflow does not establish a source-code logging
prohibition.

GitHub Actions log retention applies to these runs (default 90 days, configurable via
`retention-days`).

**Files:** `.github/workflows/scan-security.yml` (Checkout caller repository step)

**Fix:** Disable verbose/source-bearing diagnostics, review aptu action logging behavior,
restrict Actions read access to `aptu-github-app`, and set explicit `retention-days` on all
workflows.

---

### V7 -- No GitHub Actions log retention policy

**Severity:** Medium | **Issue:** #138

**Description:**

No workflow in the repository sets `retention-days`. GitHub's default retention applies (90 days
for public repos, 90 days for private repos with configurable org/enterprise settings). No
documentation specifies the intended retention period, access controls, or deletion procedures
for workflow logs that may contain caller source code or commit metadata.

**Files:** All `.github/workflows/*.yml` files

**Fix:** Set `retention-days` on all workflows (e.g., 7-14 days for scan workflows that
process caller source code). Document the retention policy and access controls.

---

### V8 -- SARIF content policy undefined

**Severity:** Medium | **Issue:** #138

**Description:**

The scan workflow uploads `findings.sarif` to the caller's code scanning API. SARIF files
normally contain tool metadata, rules, results, messages, severity levels, and artifact
locations (file paths and line/region coordinates). A result message may include a code
snippet as region context, depending on the SARIF generator's configuration.

The aptu action's SARIF generation behavior (whether snippets are included) is not documented
in this repository. The SARIF data is stored in the caller's GitHub repository under GitHub
code scanning retention and access controls.

**Files:** `.github/workflows/scan-security.yml` (Upload SARIF to caller step)

**Fix:** Inspect aptu's SARIF generator output, document whether code snippets are included,
and define a policy on permitted SARIF content.

---

### V9 -- No data residency documentation

**Severity:** Medium | **Issue:** #138

**Description:**

No repository documentation defines data residency, processing locations, cross-border
transfers, regional controls, or provider subprocessors.

| Component | Processing Location | Region Control | Documented |
| --- | --- | --- | --- |
| GitHub-hosted runners | GitHub/Microsoft Azure; region not selectable by runner label | No geographic guarantee from `ubuntu-24.04-arm` | No |
| Cloudflare Worker | Cloudflare global edge network | No region selected; Regional Services / Data Localization Suite not configured | No |
| AI providers (Gemini, Anthropic) | Provider-specific; depends on account tier and endpoint | No regional endpoint configured | No |
| OpenRouter | Multi-provider routing; EU/US in-region available for enterprise | No routing control configured; fallback to OpenRouter on provider failure | No |
| SARIF storage | Caller's GitHub repo (code scanning) | Follows caller's GitHub data residency | Correct target |

For a Canadian organization, PIPEDA does not prohibit cross-border processing but requires
accountability, notice, safeguards, contractual oversight, and transfer transparency.

**Files:** No residency-related files exist in the repository.

**Fix:** Publish a data residency statement documenting processing locations, cross-border
transfers, regional controls (or lack thereof), and provider subprocessors.

---

### V10 -- Legacy commit status instead of check run

**Severity:** Low | **Issue:** #136

**Description:**

The workflow uses `POST /repos/{repo}/statuses/{sha}` to create a legacy commit status. GitHub
check runs provide richer output, annotations, caller-visible details URLs, and summary
markdown. Check run creation requires `checks: write` permission on the GitHub App.

**Files:** `.github/workflows/scan-security.yml` (Report status to caller step)

**Fix:** Consider migrating to check runs via `POST /repos/{originating_repo}/check-runs` if
richer caller-visible reporting is needed. This is optional if the current status check is
sufficient for branch protection requirements.

---

### V11 -- `::add-mask::` limitations

**Severity:** Low | **Issue:** #137

**Description:**

The `::add-mask::` command masks exact matching text in workflow log output only. It does not
encrypt or remove the token from the repository_dispatch payload, event metadata, process
environment, action inputs, GitHub API request history, or derived values. It is not sufficient
as the sole token-protection control.

This is a contributing factor to V2, not an independent issue. The fix for V2 (removing the
token from client_payload) eliminates this concern entirely.

**Files:** All three workflow files (Mask installation token step)

---

### V12 -- AI API key resolution documentation

**Severity:** Info | **Issue:** #137

**Description:**

The prior pre-public-release audit (S1) identified that `secrets[github.event.client_payload.ai_key_secret]`
resolves against the `aptu-github-app` repository's secrets, not the caller's repository. PR #87
corrected documentation and reinstated the `ALLOWED_OWNERS` allowlist.

The current README (as of `a7dca25`) contains corrected language in most passages but the
"External installation example" section still implies caller-side secret resolution. The
ARCHITECTURE.md "Caller-Supplied AI Keys" section states "the key is never exposed to the
Worker or logged" which is technically true but does not clarify that the key value comes from
`aptu-github-app`'s secrets, not the caller's.

**Files:** `README.md`, `docs/ARCHITECTURE.md`

**Fix:** Ensure all documentation consistently states that `api-key-secret` names a secret in
the `aptu-github-app` repository. If caller-controlled keys are desired, document the
architectural change required.

---

## Validated Sound (Non-Findings)

### SARIF upload target and ref pairing

The SARIF upload targets the caller's repository (`originating_repo`) with `commit_sha` set to
the PR head SHA and `ref` set to `refs/pull/{pull_number}/head`. This is the correct repository
and PR-head ref pairing for a pull request scan, provided the API token has
`security_events: write` permission. The Worker requests `security_events: write` in
`PERMS.scan`.

### Only scan-security.yml posts status checks

`scan-security.yml` is the only workflow that posts a status check with `target_url`.
`pr-review.yml` and `issue-triage.yml` invoke the aptu action but contain no status or
`target_url` step. The Worker source (`worker/src/index.ts`) dispatches events and passes
payload fields but does not construct status URLs or post statuses.

### Worker token scoping

Per-operation scoped tokens are correctly minimal and not cached. The `PERMS` lookup table
defines five permission sets, each scoped to the minimum required permissions. All tokens are
created fresh per request via `createAppAuth` with `repositoryNames` and `permissions`.

### HMAC validation

Every request passes through `validateSignature` before `JSON.parse` or any event-type
branching. The implementation uses `crypto.subtle.verify` (Web Crypto), which performs
constant-time HMAC comparison. No bypass path was found.

### Error response leakage

All error responses use fixed literals. No response body interpolates `error.message`, stack
traces, secret values, or internal state.

---

## Issue Mapping

Three GitHub issues were created to address the findings:

| Issue | Title | Findings Addressed |
| --- | --- | --- |
| #136 | fix(scan): broken target_url, silent SARIF failures, binary status | V1, V4, V5, V10 |
| #137 | fix(security): installation token in dispatch payload and masking limitations | V2, V11, V12 |
| #138 | docs: privacy policy, data inventory, and residency documentation | V3, V6, V7, V8, V9 |

---

## Recommended Resolution Order

| Priority | Issue | Action |
| --- | --- | --- |
| 1 | #136 | Fix `target_url`, remove `continue-on-error` on SARIF upload, refine status classification |
| 2 | #137 | Redesign token delivery to avoid bearer credential in event payload |
| 3 | #138 | Create privacy policy, data-flow inventory, residency documentation, log retention policy |
