---
name: Bug
about: Report a defect or unexpected behavior
title: "[BUG] "
labels: bug
assignees: ""
---

## Summary
<!-- 1-2 sentences: what is broken? Be specific about the symptom, not the suspected cause. -->

Example: "The Cloudflare Worker returns 500 when processing a webhook with a missing X-Hub-Signature-256 header."

## Steps to Reproduce
<!-- Numbered list of exact steps to trigger the bug. Include component name and inputs. -->

1.
2.
3.

## Expected Behavior
<!-- What should happen? -->

## Actual Behavior
<!-- What actually happens? Include error messages or stack traces. -->

```
<paste full error output or stack trace here>
```

## Environment

- OS: macOS / Linux (specify version)
- Wrangler version: `bunx wrangler --version`
- Component: Cloudflare Worker / GitHub Actions workflow
- Bun version: `bun --version`

## Logs / Error Output

```
<paste full error output here>
```

## Root Cause Analysis
<!-- Optional: hypothesis with file path and line range. -->

## Fix Direction
<!-- Optional: suggested approach or pattern to follow. -->

## Acceptance Criteria

- [ ] Bug is reproducible with provided steps
- [ ] Root cause identified and documented
- [ ] Fix implemented and verified
- [ ] Regression test added (if testable without live environment)
- [ ] All existing checks pass
- [ ] Commit GPG signed and DCO signed-off