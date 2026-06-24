<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->

# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

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

This project has three primary attack surfaces:

### WEBHOOK_SECRET Exposure

The `WEBHOOK_SECRET` secret authenticates GitHub webhook requests to the Cloudflare Worker.
Exposure allows an attacker to forge webhook events and trigger arbitrary `repository_dispatch`
events, leading to unauthorized issue triage and PR review actions.

**Mitigations**: Secret stored as a Wrangler secret only; never committed; rotated on any
suspected exposure; HMAC signature verified on every webhook request before any processing.

### X-Hub-Signature-256 Bypass

If HMAC signature validation is skipped or incorrectly implemented, an attacker can send
forged webhook payloads to the Worker, triggering unauthorized `repository_dispatch` events.

**Mitigations**: HMAC validation is the first step in the Worker request handler; all paths
are validated; validation failures return 401 immediately with no further processing.

### CLOUDFLARE_API_TOKEN Scope

The Cloudflare API token used for Worker deployment carries access to manage Workers and
associated resources. A token with excess scope could modify or exfiltrate Worker configuration
or environment variables.

**Mitigations**: Token scoped to the minimum required permissions (Workers: Edit, Account
scope); stored as a GitHub Actions secret; 90-day rotation policy; scope documented and
audited on each rotation.

## Supply Chain Security

### REUSE/SPDX

All files carry SPDX license headers, verified by the REUSE standard.

### Signed Commits

GPG-signed commits are required on all branches.

### Dependency Scanning

Automated dependency updates via Renovate. GitHub Actions pinned to commit SHAs. TypeScript
dependencies audited in CI via Bun.

## Contact

For security concerns: hugues+aptu-github-app-security@linux.com
For general questions: open a GitHub issue