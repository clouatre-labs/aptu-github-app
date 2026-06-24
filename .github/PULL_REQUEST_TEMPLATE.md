<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 aptu-github-app Contributors -->

## Summary

<!-- Brief description of changes: what changed and why. -->

## Related Issues

<!-- Link issues: "Closes #123" or "Related to #456" -->

## Changes

<!-- Bullet list of what was modified. Be specific about files and scope. -->

## Test Plan

<!-- How was this tested? Include edge cases covered. -->

## Checklist

- [ ] Commits are signed and follow conventional commit format
- [ ] DCO signed-off: `git commit --signoff`
- [ ] No secrets, API keys, or credentials in diff
- [ ] No scope creep (changes match assigned issue)

**Cloudflare Worker** (if `worker/` changed):
- [ ] Build passes (`bunx wrangler build`)
- [ ] No hardcoded secrets (use Wrangler bindings)
- [ ] HMAC signature validation present for all webhook paths
- [ ] TypeScript type check passes (`bun run tsc --noEmit`)

**GitHub Actions** (if `.github/workflows/` changed):
- [ ] Action pins use commit SHAs, not mutable tags
- [ ] `permissions:` blocks are present and minimal
- [ ] No sensitive data in `run:` scripts (use `env:` blocks)

**Tests** (if `tests/` changed):
- [ ] Tests pass (`bun test`)
- [ ] One happy path and one edge case per behavior