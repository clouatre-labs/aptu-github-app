# Privacy Policy and Data Inventory

This document defines the data collection, processing, retention, minimization, and residency policies for **aptu-github-app**. It provides an inventory of all data categories handled across the system, explains the operational controls applied to protect customer data, and outlines data-subject rights and incident response procedures.

This document reflects the operational and technical configuration of the service. It is intended for administrators, security teams, and users evaluating the data governance posture of aptu-github-app.

---

## 1. Scope and Roles

* **Service**: aptu-github-app (webhook receiver, dispatcher, and automated analysis workflows).
* **Data Controller**: The repository owner or organization administrator installing the GitHub App.
* **Data Processor**: The operators of aptu-github-app (`clouatre-labs`), executing automated triage, review, and scanning workflows on behalf of the controller.
* **Subprocessors**: Cloudflare (edge runtime, Durable Objects), GitHub (Actions runners, API, code-scanning SARIF store), Sentry (error telemetry), and AI model providers routed via OpenRouter (e.g., Google, Inception, Anthropic).

---

## 2. Data Inventory

The system processes distinct categories of data depending on the triggered feature:

| Data Category | Specific Fields / Payload Content | Processing Location | Storage Store |
| :--- | :--- | :--- | :--- |
| **Source Code & Diffs** | Repository checkout at `head_sha` or PR git diffs (up to 200,000 prompt chars, 0 full files) | GitHub Actions runners, AI inference endpoint | Ephemeral runner disk; AI model provider transient context |
| **Issue & PR Text** | Issue title, issue body (truncated to 4,000 chars in mention dispatch payloads), PR title/description, comment bodies | Cloudflare Worker, Actions runner, AI inference endpoint | Cloudflare DO replay/quota log, runner logs, AI provider context |
| **Commit Metadata** | `head_sha`, commit authors, timestamps, ref branch names, PR numbers | Cloudflare Worker, Actions runner | Cloudflare Worker logs, Actions workflow logs |
| **Instruction Files** | Repository instruction files (e.g. `.github/instructions/pr-review.md` or `.github/aptu.yml`) | Actions runner, AI inference endpoint | Ephemeral runner workspace |
| **Webhook Delivery Payload** | Delivery ID (`X-GitHub-Delivery`), sender login, repository ID, installation ID, client IP (`CF-Connecting-IP`) | Cloudflare Worker edge | Cloudflare Worker runtime memory, `ReplayGuard` DO, `InstallationQuota` DO |
| **Security Scan Findings (SARIF)** | Static analysis rule alerts, severity levels, rule descriptions, file paths, line numbers, and potential code snippets | Actions runner, GitHub code-scanning API | Ephemeral runner disk, GitHub Security SARIF store |
| **Error Diagnostics** | Exception stack traces, HTTP status codes, installation IDs | Cloudflare Worker, Sentry | Sentry error tracking platform |

---

## 3. Processing Purposes

1. **Issue Triage (`aptu-triage`)**: Evaluates new issues or mention commands against configured guidelines, assigning labels and posting triage summaries.
2. **Pull Request Review (`aptu-review`)**: Analyzes pull request changes against codebase rules, emitting review feedback or suggestions.
3. **Security Analysis (`aptu-scan-security`)**: Executes security scanners against the repository source at `head_sha`, generating SARIF findings posted to GitHub Code Scanning.
4. **Rate Limiting and Abuse Prevention**: Tracks rolling request volumes per installation to ensure fair capacity sharing and prevent replay attacks.
5. **Operational Health & Error Tracking**: Captures runtime failures to identify configuration errors or upstream service degradation.

---

## 4. Recipients and Subprocessors

* **GitHub Inc.**: Hosts GitHub Actions execution environments, stores workflow logs and code scanning (SARIF) databases, and hosts repository data.
* **Cloudflare Inc.**: Runs edge compute (Cloudflare Workers) and stateful KV/Durable Objects for replay deduplication and quota counters.
* **Functional Software, Inc. (Sentry)**: Receives sanitized runtime error stack traces and metadata (installation IDs, HTTP error contexts).
* **OpenRouter / AI Model Providers**: Dispatches prompts containing diffs or issue text to selected models (defaulting to `google/gemma-4-26b-a4b-it` and `inception/mercury-2` fallback).

---

## 5. Retention Schedule by Data Store

Retention varies across data stores. Setting workflow retention controls GitHub Actions logs but does not govern third-party subprocessors or GitHub platform stores:

| Data Store | Retention Period | Deletion Guarantee & Mechanism | Scope & Limitations |
| :--- | :--- | :--- | :--- |
| **GitHub Actions Logs (`scan-security`)** | **7 days** (configured via `retention-days: 7`) | Automatically deleted by GitHub Actions retention policy | Covers step execution output and runner terminal logs only |
| **GitHub Actions Logs (`issue-triage`, `pr-review`, `ci`, `deploy`)** | **14 days** (configured via `retention-days: 14`) | Automatically deleted by GitHub Actions retention policy | Covers workflow run logs and metadata |
| **Runner Workspace Disk** | Ephemeral (duration of job, max 10 min) | Discarded on runner termination (GitHub-hosted ephemeral VM) | Files written to `/home/runner/work` deleted when VM shuts down |
| **GitHub Code Scanning (SARIF Store)** | Governed by caller repository retention policy | Managed by repository admin / GitHub organization settings | Retained in GitHub Security tab; not pruned by workflow log retention |
| **Durable Objects (`InstallationQuota`)** | 24-hour rolling sliding window | Timestamp pruning during `check`/`record` operations | Stores numeric event timestamps per installation ID |
| **Durable Objects (`ReplayGuard`)** | 24-hour rolling window | Pruned on subsequent requests or DO expiration | Stores `X-GitHub-Delivery` UUIDs |
| **Sentry Telemetry** | Up to 90 days (standard Sentry retention) | Sentry platform data retention rules | Error traces only; does not contain source trees |
| **AI Providers (via OpenRouter)** | Transient / 0-day retention where supported; up to 30 days depending on upstream terms | Governed by upstream provider terms and OpenRouter settings | Subject to individual provider Zero Data Retention (ZDR) status |

*Important Limitation*: Prior to this change, `retention-days` was entirely absent from all workflow configurations (falling back to GitHub organization/repository defaults). The configured `retention-days` is only an operational workflow-log setting governing GitHub Actions run logs, not a complete deletion guarantee. It does not delete data stored in GitHub code scanning, Cloudflare Durable Objects, Sentry, or upstream AI provider logs.

---

## 6. Data-Subject Rights (GDPR / CCPA)

Because processing is automated on behalf of the customer, data subjects (e.g. commit authors or issue commenters) should exercise rights via the repository owner (Data Controller).

* **Right of Access & Portability**: Repository owners can inspect all data directly in GitHub (issue comments, review comments, code scanning alerts) and workflow logs.
* **Right to Erasure (Right to be Forgotten)**: Deleting an issue comment, pull request, or repository removes the underlying source. To request manual purge of Sentry logs or Cloudflare DO states, contact the project maintainers.
* **Right to Restrict Processing**: Uninstall the GitHub App or set `triage.enabled: false`, `review.enabled: false`, or `scan.enabled: false` in `.github/aptu.yml`.

---

## 7. Breach Notification Process

In the event of a confirmed security incident or data breach affecting customer data:

1. **Identification & Isolation**: Maintainers revoke compromised tokens, invalidate secrets (such as GitHub App private keys or Cloudflare tokens), and restrict worker endpoints.
2. **Impact Assessment**: Assess affected repository installations, exposed logs, or credentials within 24 hours.
3. **Notification**: Notify impacted repository administrators via registered GitHub security contact or email within 72 hours of verification.
4. **Post-Mortem**: Publish a technical analysis and corrective actions under `docs/audit/`.

---

## 8. Data Minimization and Redaction Policy

* **No Source Persistence in Worker**: The Cloudflare Worker receives webhooks, checks quotas, and immediately forwards execution metadata to GitHub Actions. The Worker does not clone or store source code.
* **Payload Truncation**: Comment bodies in mention payloads are bounded (truncated to 4,000 characters). PR review prompts limit context characters (e.g., `max-prompt-chars: '200000'`, `max-full-content-files: '0'`).
* **Installation Token Isolation**: GitHub App tokens are generated per-workflow or per-operation with minimal required scopes (e.g. `permission-contents: read`, `permission-security-events: write`).
* **Secret Masking**: API keys and tokens are passed via GitHub Secrets and action inputs, masked from standard runner output.

---

## 9. SARIF Content Policy

The security scan workflow (`scan-security.yml`) executes static analysis and transmits findings in SARIF format to `repos/{repo}/code-scanning/sarifs`.

* **Current Status**: *Pending Verification*.
* While the scanner targets vulnerability metadata (rule ID, message, location), SARIF schemas allow snippet embedding (`region.snippet`). The exact exclusion of surrounding code snippets in SARIF artifacts depends on the `aptu` action implementation and must be verified against scanner outputs.

---

## 10. AI Provider Terms and OpenRouter Settings

* **Default Provider**: OpenRouter (`https://openrouter.ai`).
* **Default Models**: Primary: `google/gemma-4-26b-a4b-it`; Fallback: `inception/mercury-2`.
* **Routing Controls**: Repositories can override AI configuration via `.github/aptu.yml` using their own API key (`ai_key_secret`), provider, and model.
* **Zero Data Retention (ZDR)**: OpenRouter supports ZDR for eligible endpoints. Actual retention by upstream model providers (Google, Anthropic, Inception) depends on provider terms, account settings, and data collection toggles.
* **Verification Date**: February 2026. Data routing parameters must be periodically re-verified against OpenRouter's current API specification.

---

## 11. Data Residency

* **Cloudflare Worker**: Executes across Cloudflare's global anycast network. The configuration (`worker/wrangler.toml` / `worker/wrangler.jsonc`) contains no Regional Services or Data Localization Suite configuration, and no geographic residency guarantee applies.
* **GitHub Actions Runners**: Run on GitHub-hosted `ubuntu-24.04-arm` runners located in GitHub/Azure regional data centers (typically US/EU). No strict geographic residency pinning is enforced.
* **AI Model Endpoints**: Model inference takes place in data centers operated by upstream model vendors (e.g., Google Cloud, AWS, or independent hosters).

---

## 12. Vendor and Subprocessor Change-Monitoring Process

The engineering team monitors subprocessors and dependencies through:

* Automated dependency scanning (`bun audit`, Dependabot).
* Quarterly reviews of upstream AI provider terms, privacy policies, and Zero Data Retention statuses.
* Updating this documentation whenever new external services or processing steps are added.

---

## 13. Contact Point

For security or privacy inquiries, or to report a vulnerability or data incident:

* Open a security advisory on GitHub: [https://github.com/clouatre-labs/aptu-github-app/security/advisories](https://github.com/clouatre-labs/aptu-github-app/security/advisories)
* Contact the maintainers: `security@clouatre.com`

---

## 14. Change History

* **2026-02-23**: Initial comprehensive privacy policy, data inventory, and workflow retention baseline (Issue #138).
