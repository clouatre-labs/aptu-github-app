# PR Review Instructions

## Scope

Review only what the PR changes. Do not flag issues in files the PR does not touch.

## Workflow files

When reviewing `.github/workflows/` changes:

- Evaluate the full job context, not individual steps in isolation.
- Flag `${{ expression }}` interpolation directly inside `run:` scripts as an injection risk;
  inputs should be passed via `env:` blocks.
- Verify action pins use commit SHAs, not mutable tags.
- Check that `permissions:` blocks are present and minimal.

## TypeScript / Cloudflare Worker

- Do not flag style issues that `bun run biome check` would catch automatically; those are
  enforced by CI.
- Do not flag type errors that `tsc --noEmit` would catch automatically; those are enforced
  by CI.
- Flag missing HMAC signature validation on any webhook request handler path; this is the
  primary security boundary.
- Flag hardcoded secrets or credentials; all secrets must use Wrangler bindings.
- Flag missing error handling: the Worker must return appropriate HTTP status codes for
  validation failures (401 for bad signatures, 400 for malformed payloads, 500 for unexpected
  errors).
- The package manager is `bun`; flag any use of `npm` or `yarn`.
- Dependency changes in `package.json` must have a clear justification; flag additions
  without explanation.

## Testing

- Tests use `bun test` with TypeScript.
- One happy path and one edge case per behavior; do not flag missing tests for behaviors
  already covered by existing tests.

## SPDX Headers

REUSE compliance is managed via `REUSE.toml`. Inline SPDX headers are required only for
TypeScript (`.ts`) and YAML (`.yml`, `.yaml`) files. Do not flag missing SPDX headers on
Markdown (`.md`) files; they are covered by the `**.md` annotation in `REUSE.toml`.

## Markdown Links

Flag relative links in Markdown files (e.g., `[text](CONTRIBUTING.md)` or
`[text](../docs/foo.md)`). All links must be absolute URLs so they resolve correctly in
GitHub release notes, forks, and mirrored docs.

## General

- One comment per distinct issue; do not duplicate findings across multiple inline comments.
- Prefer suggesting a fix (suggestion block) over describing the problem when the fix is
  unambiguous.