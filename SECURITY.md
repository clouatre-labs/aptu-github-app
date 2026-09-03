# Security Policy

## Supported Versions

This project is a continuously-deployed Cloudflare Worker. The production endpoint always runs the latest commit on `main`; there are no legacy versions in service. Only the current release is supported.

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| older   | No        |

## Verifying Release Signatures

### GPG-signed tags

Every release tag is GPG-signed by the maintainer. To verify a tag:

```bash
git fetch --tags
git tag --verify v<version>
```

The signing key is visible on the maintainer's GitHub profile and in signed commits in this repository.

## Reporting a Vulnerability

If you discover a security vulnerability, please follow these steps.

### 1. Do Not Open a Public Issue

Do not report security vulnerabilities through public GitHub issues.

### 2. Email Us Directly

Send details to: **hugues+aptu-github-app-security@linux.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### 3. Response Timeline

- **Initial Response**: within 48 hours
- **Status Update**: within 5 business days
- **Fix Timeline**: depends on severity
  - Critical: within 7 days
  - High: within 14 days
  - Medium: within 30 days
  - Low: next regular release

### 4. Disclosure Policy

- We will acknowledge receipt of your report
- We will provide regular updates on progress
- We will notify you when the vulnerability is fixed
- We will publicly disclose after a fix is released
- We will credit you for the discovery unless you prefer anonymity

## Attack Surface

This project has four primary attack surfaces:

### WEBHOOK_SECRET Exposure

The `WEBHOOK_SECRET` secret authenticates GitHub webhook requests to the Cloudflare Worker. Exposure allows an attacker to forge webhook events and trigger arbitrary `repository_dispatch` events, leading to unauthorized issue triage and PR review actions.

**Mitigations**: Secret stored as a Wrangler secret only; never committed; rotated on any suspected exposure; HMAC signature verified on every webhook request before any processing.

### X-Hub-Signature-256 Bypass

If HMAC signature validation is skipped or incorrectly implemented, an attacker can send forged webhook payloads to the Worker, triggering unauthorized `repository_dispatch` events.

**Mitigations**: HMAC validation is the first step in the Worker request handler for all GitHub webhook paths; validation failures return 401 immediately with no further processing.

**Explicit exception**: `POST /telemetry/rollup` is routed before HMAC validation and does not require a signature. This is intentional, not an oversight: it receives POSTs from the `aptu` GitHub Action running in consuming repositories' CI, not from GitHub's webhook infrastructure, so a shared webhook secret does not apply to it. The endpoint is opt-in, accepts only an aggregate-only, anonymized counters payload (no repo, PR, or actor identifiers -- see `worker/src/telemetry.ts`), and bounds its own risk instead of relying on HMAC: a strict key allowlist rejects any unrecognized field, numeric fields are bounds-checked (finite, non-negative), count-map cardinality is capped, `run_id` is deduplicated, and a per-IP rolling-window rate limit (`TelemetryRateLimit` Durable Object) bounds how much an unauthenticated caller can write. It always returns 202 regardless of payload validity so a telemetry POST never fails the caller's CI job.

### CLOUDFLARE_API_TOKEN Scope

The Cloudflare API token used for Worker deployment carries access to manage Workers and associated resources. A token with excess scope could modify or exfiltrate Worker configuration or environment variables.

**Mitigations**: Token scoped to the minimum required permissions (Workers: Edit, Account scope); stored as a GitHub Actions secret; 90-day rotation policy; scope documented and audited on each rotation.

**Rotation procedures**: See [RUNBOOK.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/RUNBOOK.md#2-secret-rotation).

## Supply Chain Security

### REUSE/SPDX

License metadata is managed via `REUSE.toml`. TypeScript and YAML files carry inline SPDX headers; all other file types (Markdown, JSON, TOML, etc.) are covered by glob annotations in `REUSE.toml`. Compliance verified by the REUSE standard.

### Signed Commits

GPG-signed commits are required on all branches.

### Dependency Scanning

Automated dependency updates via Renovate. GitHub Actions pinned to commit SHAs. TypeScript dependencies audited in CI via Bun.

## Contact

For security concerns: hugues+aptu-github-app-security@linux.com For general questions: open a GitHub issue
