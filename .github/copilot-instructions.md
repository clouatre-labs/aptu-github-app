# Copilot Instructions

## Assigning Issues and Triggering Rework

### Assign via REST API

```bash
gh issue edit <NUMBER> --add-assignee copilot-swe-agent
```

### Assign via GitHub UI

Use the Assignees field on the issue page.

### Trigger Rework

Mention `@copilot` in a PR comment (GitHub UI only, not via `gh`). Copilot will re-run and amend the PR.

## PR Iteration Limit

Copilot has a 2-iteration limit per PR:

1. Initial implementation
2. One round of review feedback

If feedback requires more than one iteration, close the PR and create a new issue with updated requirements.

## Code Review Checklist

When reviewing Copilot PRs, verify:

- **Scope creep**: Does the PR implement only what the issue specifies?
- **API correctness**: Are all library/framework calls valid? Verify against installed package versions or docs.
- **Error handling**: Are errors caught and handled appropriately for the context?
- **SHA pinning**: If the PR modifies `.github/workflows/*.yml`, all action `uses:` must be SHA-pinned with a comment showing the tag (e.g., `uses: owner/action@<SHA> # vX.Y.Z`).
- **Commits**: All commits must be GPG-signed and include DCO sign-off (`git commit -S --signoff`).

## Firewall Constraints

Copilot runs in a firewalled GitHub Actions environment. If your project requires external URLs (APIs, registries, artifact stores), document them here so Copilot can request network access:

<!-- Add any external URLs needed by the project -->

## Enabling Copilot code review

Copilot code review is enforceable via the `copilot_code_review` ruleset rule (added to the
branch ruleset). Once enabled, Copilot automatically reviews every PR on push.

To request a re-review: re-request review from `Copilot` in the PR sidebar.

## Design References

For detailed standards, see:

- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [docs/REPO-STANDARDS.md](../docs/REPO-STANDARDS.md)
- [AGENTS.md](../../.claude/AGENTS.md)
