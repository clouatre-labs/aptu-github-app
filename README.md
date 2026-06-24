<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->

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

See [clouatre-labs/aptu#94](https://github.com/clouatre-labs/aptu/issues/94) for deployment
instructions and prerequisites.

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