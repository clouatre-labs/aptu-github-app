---
name: Feature
about: Propose a new feature or enhancement
title: "[FEATURE] "
labels: enhancement
assignees: ""
---

## Summary
<!-- 1-2 sentences: what to build and what user need it addresses. Be specific. -->

Example: "Add support for pull_request_review webhook events so the Worker can dispatch reviews on request."

## Context
<!-- Why does this matter? What depends on it? Link to related issues. -->

- Problem solved:
- Users or workflows that benefit:
- Blocking dependencies (if any):

## Prerequisites

- Depends on: #N (if applicable)

## Implementation Notes
<!-- Key decisions, patterns to follow, relevant file paths. -->

### Strategy

1.

### Component

- [ ] Cloudflare Worker (`worker/`)
- [ ] GitHub Actions workflow (`.github/workflows/`)
- [ ] Documentation only

## Acceptance Criteria

- [ ] Feature implemented per summary
- [ ] Follows project conventions
- [ ] All existing checks pass
- [ ] New tests cover happy path and at least one edge case (if testable)
- [ ] Documentation updated (README, docs/) if applicable
- [ ] Commit GPG signed and DCO signed-off

## Not In Scope
<!-- Explicit boundaries to prevent scope creep. -->
