# aptu-github-app

A Cloudflare Worker and GitHub Actions that automate issue triage and PR review for repositories
in the clouatre-labs org, powered by [aptu](https://aptu.dev). The Worker validates GitHub
webhook signatures and dispatches `repository_dispatch` events to trigger aptu-powered triage
and review workflows without per-repo configuration.

## Architecture

```
GitHub event (issues.opened / pull_request_review_requested)
  -> Cloudflare Worker (verify X-Hub-Signature-256, dispatch repository_dispatch)
  -> GitHub Actions workflow (actions/create-github-app-token, run aptu CLI)
  -> GitHub Reviews API (inline comments as aptu[bot])
```

The Worker is stateless: validate HMAC signature, call `POST /repos/{owner}/{repo}/dispatches`,
return 200. The workflow handles all App authentication and aptu invocation. No persistent
server required.

## Deployment

### Worker deployment

Merging to `main` triggers `deploy.yml`, which deploys the Worker to Cloudflare via
`cloudflare/wrangler-action`. Required GitHub secrets and variables:

- `CLOUDFLARE_API_TOKEN` -- Cloudflare API token with Workers edit permission
- `CLOUDFLARE_ACCOUNT_ID` -- Cloudflare account ID (repository variable)
- `WEBHOOK_SECRET` -- Wrangler secret; must match the value configured in the GitHub App

### DNS prerequisite

The `wrangler.jsonc` configuration binds the Worker to the route `aptu.dev/webhook` using
the `routes` pattern. Cloudflare route bindings require a proxied DNS record for the zone
root to exist; without one the domain does not resolve and GitHub cannot deliver webhooks
(`ERR_NAME_NOT_RESOLVED`).

Add the following record in the Cloudflare dashboard under the `aptu.dev` zone before or
after the first deploy:

| Type | Name | Content | Proxied |
|------|------|---------|---------|
| AAAA | aptu.dev | `100::` | Yes |

`100::` is the [Cloudflare-documented placeholder](https://developers.cloudflare.com/workers/configuration/routing/routes/)
for route-based Workers with no real origin. The address is never contacted; Cloudflare
intercepts all proxied requests and the Worker route handles `/webhook` before any origin
is reached.

Note: `custom_domain = true` in `wrangler.jsonc` would have Cloudflare manage DNS
automatically, but it binds the Worker to the entire domain. Because only `/webhook` is
intercepted, the `routes` + `AAAA 100::` pattern is correct.

### App credentials

See [clouatre-labs/aptu#94](https://github.com/clouatre-labs/aptu/issues/94) for GitHub
App registration and credential setup.

## Releases

Merging to `main` triggers [Release Please](https://github.com/googleapis/release-please-action)
to create GitHub Releases automatically from [Conventional Commits](https://www.conventionalcommits.org/).
No manual version bump is required. Each release generates a changelog entry and a tagged
GitHub Release. See the [Releases & Versioning](https://github.com/clouatre-labs/aptu-github-app/blob/main/CONTRIBUTING.md#releases--versioning)
section of CONTRIBUTING.md for details.

## Development

**Prerequisites:** [Bun](https://bun.sh/), [Wrangler](https://developers.cloudflare.com/workers/wrangler/)

```bash
bun install
bun test
bun run biome check
bunx wrangler dev
```

## License

Apache-2.0. See [LICENSE](LICENSE).