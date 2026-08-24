# Operator Runbook

Procedures for operating the aptu-github-app Cloudflare Worker. See also
[ARCHITECTURE.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/docs/ARCHITECTURE.md)
for environment variable and binding documentation.

---

## 1. Post-Deploy Steps

After deploying a new version that adds or widens repository/organization permissions
(e.g., `Contents:Write`), GitHub requires each installation to explicitly approve the
new permissions before they take effect. The following procedure closes that gap.

### 1.1 Update the GitHub App manifest

1. Navigate to the GitHub App settings page for the `aptu-dev` App:
   `https://github.com/settings/apps/aptu-dev`
2. Under **Permissions > Repository permissions**, locate **Contents** and set it to
   **Write**.
3. Click **Save changes** at the bottom of the page.

### 1.2 Notify installation owners

After saving the updated permissions, GitHub sends an email notification to every
organization or user that has installed the App. The notification includes a link to
review and approve the new permissions.

- If you are an owner of the target installation, you will see a banner at
  `https://github.com/settings/installations/<INSTALLATION_ID>` prompting approval.
- If you are not an owner, coordinate with the organization owner to complete the
  approval.

### 1.3 Verify via test webhook

Once all installations have approved the new permissions, confirm that
`repository_dispatch` events are flowing correctly:

```bash
curl -X POST https://aptu.dev/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -H "X-Hub-Signature-256: sha256=$(echo -n '{"zen":"test"}' | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/.* //')" \
  -d '{"zen":"test"}'
```

Expected response: `202 Accepted`. If the response is `401 Unauthorized`, verify that
the `WEBHOOK_SECRET` value matches between the GitHub App settings and the Wrangler
secret (see Section 3.1).

---

## 2. Reusable Workflow Versioning

The reusable workflows (`pr-review.yml`, `issue-triage.yml`, and `scan-security.yml`)
are distributed to caller repositories via the floating `@v1` major version tag.

### 2.1 Floating major tag lifecycle

- **Automatic tag updates:** The `.github/workflows/release-workflows.yml` workflow runs on
  every push to `main` that touches any of the reusable workflow files. It automatically creates
  or fast-forwards the `v1` git tag to `HEAD`.
- **Caller experience:** Repositories using `@v1` in their `.github/workflows/aptu.yml`
  automatically receive backwards-compatible updates, fixes, and improvements on each run
  without manual workflow file edits.
- **Breaking changes:** If a breaking change to workflow interfaces or inputs is introduced in
  the future, a new major tag (e.g. `v2`) must be established. Existing installations continue
  pointing to `@v1` until repository operators update their dispatcher workflow manually.
- **Version marker enforcement:** Whenever reusable workflow files are modified in a PR, CI
  requires incrementing the `# aptu-dispatch-handler-version: <integer>` marker comment in
  `.github/workflows/aptu.yml` and the README.md template.

### 2.2 Reusable workflow rollback

If a bad workflow change reaches `main` and breaks caller repositories, immediately point the
`v1` tag back to the last known good commit:

```bash
git tag -f v1 <commit-sha>
git push origin v1 --force
```

This immediately reverts all caller repositories resolving `@v1` to the designated commit.

---

## 3. Secret Rotation

### 3.1 Rotate WEBHOOK_SECRET

The `WEBHOOK_SECRET` is shared between the GitHub App webhook configuration and the
Worker's environment. Both sides must be updated within the same maintenance window.

1. **Generate a new secret:**

   ```bash
   openssl rand -hex 32
   ```

   Copy the output; it becomes the new `WEBHOOK_SECRET`.

2. **Update the GitHub App webhook secret:**

   Navigate to `https://github.com/settings/apps/aptu-dev` and replace the **Webhook
   secret** field with the new value. Click **Save changes**.

3. **Update the Worker secret:**

   ```bash
   bunx wrangler secret put WEBHOOK_SECRET
   ```

   Paste the new secret when prompted. Wrangler updates the value in-place; the Worker
   picks it up on the next request.

4. **Verify the rotation:**

   Send a test webhook request (see Section 1.3) and confirm `202 Accepted`.

### 3.2 Rotate APP_PRIVATE_KEY

The `APP_PRIVATE_KEY` authenticates the App's GitHub API requests. Unlike
`WEBHOOK_SECRET`, two keys must be valid concurrently during rotation so that the
Worker never loses authentication.

1. **Generate a new private key:**

   Navigate to `https://github.com/settings/apps/aptu-dev`, scroll to **Private keys**,
   and click **Generate a private key**. GitHub downloads a new PKCS#8 PEM file and adds
   it to the App's active key list. The old key remains valid.

2. **Upload the new key to the Worker:**

   ```bash
   bunx wrangler secret put APP_PRIVATE_KEY
   ```

   Paste the contents of the new PEM file (including the `-----BEGIN PRIVATE KEY-----`
   and `-----END PRIVATE KEY-----` delimiters) when prompted.

3. **Verify authentication:**

   Trigger a `repository_dispatch` event or check the Worker logs for successful
   GitHub API authentication (e.g., `202 Accepted` on a test webhook). Confirm the
   Worker can authenticate using the new key.

4. **Delete the old private key:**

   Return to the GitHub App settings page, locate the old key in the **Private keys**
   list, and click **Delete**. The Worker now uses the new key exclusively.

**Important:** Do not delete the old key before step 3. The two-key overlap window is
mandatory -- deleting the old key before verification would break production
authentication if the new key is not yet accepted by the Worker runtime.

---

## 4. Incident Response and Rollback

### 4.1 Symptom-to-Action Table

| Symptom | Likely Cause | Action |
| --- | --- | --- |
| `ERR_NAME_NOT_RESOLVED` when GitHub delivers webhooks to `aptu.dev/webhook` | Missing or unproxied DNS AAAA record for `aptu.dev` | Add `AAAA aptu.dev 100::` (proxied) in the Cloudflare DNS dashboard. See DNS prerequisite in [README.md](https://github.com/clouatre-labs/aptu-github-app/blob/main/README.md). |
| `401 Unauthorized` on all webhook requests | `WEBHOOK_SECRET` mismatch between GitHub App and Worker | Re-run `bunx wrangler secret put WEBHOOK_SECRET` with the correct value. Verify the GitHub App webhook secret field matches. See Section 3.1. |
| `429 Too Many Requests` on GitHub API calls from the Worker | Installation has exceeded its quota (rate-limit per installation, enforced by `InstallationQuota` Durable Object) | Inspect quota state (see Section 4.4). The quota resets hourly; no operator action is required unless abuse is suspected. |

### 4.2 Rollback to a Previous Deployment

1. **List recent deployments:**

   ```bash
   bunx wrangler deployments list
   ```

   Identify the deployment ID of the version you want to restore.

2. **Rollback:**

   ```bash
   bunx wrangler rollback --deployment-id <DEPLOYMENT_ID>
   ```

   Wrangler reverts the Worker code and bindings to the specified deployment.

### 4.3 Rollback Caveat: Durable Object Migration Tag

Wrangler rollback is **blocked** if the Durable Object migration tag has changed between
the current and target deployment. The `worker/wrangler.toml` currently defines:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["InstallationQuota"]
```

If a future deployment adds a new migration (tag `v2`), rollback to any deployment
with tag `v1` will fail with an error similar to:

```text
Migration tag v2 is not compatible with the target deployment's tag v1.
```

In this scenario, the only recovery path is to deploy a new version that directly
contains the rollback fix, rather than using `wrangler rollback`. Plan for this
limitation when adding new Durable Objects or SQLite classes.

### 4.4 Inspect Quota State

The `InstallationQuota` Durable Object stores per-installation rate-limit state. To
inspect current quota usage:

```bash
bunx wrangler tail --format=json
```

Look for log lines containing `quota` or `InstallationQuota`. Alternatively, if
debug logging is enabled, `console.log` output from the Durable Object appears in the
tail stream. There is no direct SQLite introspection command via Wrangler for Durable
Objects.
