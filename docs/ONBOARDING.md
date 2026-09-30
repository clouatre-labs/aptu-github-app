# aptu onboarding runbook: install to first review

This runbook walks through taking a repository from app installation to the first automated aptu review. It is the canonical verification path for the install-time onboarding flow.

## Prerequisites

- The aptu GitHub App is visible in the GitHub Apps marketplace for your org or account.
- You have admin access to the target repository (or owner access for org-wide installation approval).

## Step 1: Install the app

Install the aptu GitHub App and select the target repository. On `installation.created` (or `installation_repositories.added`), the Worker automatically:

1. Provisions the four dispatch handler workflow files under `.github/workflows/` (`aptu-review.yml`, `aptu-triage.yml`, `aptu-scan-security.yml`, `aptu-lint-issue.yml`).
2. Fetches `.github/aptu.yml` and, if the config is missing or lacks an `ai` block, opens a welcome issue in the repository with copy-paste guidance.

If the config is already valid and complete (present with an `ai` block), no welcome issue is opened.

### Re-authorization note

The welcome-issue flow uses the App's `issues: write` permission. If the App manifest changed to add this permission after your installation was created, GitHub triggers a per-installation re-authorization. Watch for a "pending" badge on the installed app; organization installs may require an owner to approve the new permission before the Worker can post comments. Individual installs can accept from the installation page.

## Step 2: Add `.github/aptu.yml`

Add this minimal example to the repository at `.github/aptu.yml`:

```yaml
version: 1
triage:
  enabled: true
ai:
  provider: openrouter
  model: google/gemma-4-26b-a4b-it
```

This file is parsed by the Worker's `parseConfig`; `version` must be `1`, each feature block needs an `enabled` boolean, and both `ai.provider` and `ai.model` are required if the `ai` block is present.

## Step 3: Add the AI secret

The `ai` block contains no secret. It selects the provider and model, which determines which repository secret the dispatch handler resolves; see the [canonical ai-block-vs-secret explanation](https://github.com/clouatre-labs/aptu-github-app/blob/main/README.md#installation) in README.md for the provider-to-secret-name mapping.

Create the matching secret in the repository (Settings > Secrets and variables > Actions) or rely on an org-visible secret of the same name. The Worker cannot verify that the secret exists; a missing secret surfaces only as a failed reusable-workflow run at review time. Security scanning works without the `ai` block.

## Step 4: Verify

1. Confirm the welcome issue (if one was opened) can be closed after the config lands.
2. Open a pull request. Within moments the aptu app should appear as a reviewer (`github-actions[bot]` inline comments come from the reusable workflow).
3. Open an issue and confirm triage runs.
4. With `lint.enabled: true` in `.github/aptu.yml`, opened or edited issues also trigger deterministic issue linting (`aptu-lint-issue`, advisory only); this requires an aptu release containing the `lint-issue` command.

Acceptance for the install-time flow itself (welcome issue posted for missing/incomplete config, dedupe when complete) is covered by unit tests in `worker/src/index.test.ts` under the "welcome issue" describe block. A live scratch-repo walkthrough of steps 1-4 is the manual acceptance step for this runbook.

## Troubleshooting

- No workflows provisioned: the App installation needs the Workflows permission; check the installation page and the Worker logs (`Provisioning ...` entries).
- No welcome issue on a fresh install: check that `issues: write` re-authorization completed (Step 1 note), then check Worker logs for `Welcome ...` entries.
- Review workflow fails immediately: usually a missing or misnamed AI secret (Step 3). The name must match the provider mapping exactly.
