# Audit: Server-Side Execution Under BYOK Constraints -- No-Go Evaluation

Audit date: 2026-09-01

Status: Closed. Decision recorded: **no-go**. Verified against `origin/main` at commit `79488f1` (fix(deps): update dependency @sentry/cloudflare to v11).

## See Also

- [2026-08-byok-rollout-simplification.md](./2026-08-byok-rollout-simplification.md) -- prior
  audit establishing the BYOK model and confirming the two-file install is the platform minimum
  without reintroducing AI-key custody (its P1 finding).
- [2026-08-scan-privacy-residency.md](./2026-08-scan-privacy-residency.md) -- scan/privacy
  audit covering data residency across GitHub runners, the Cloudflare Worker, and AI providers.
- [ARCHITECTURE.md](../ARCHITECTURE.md) -- module map and data flow, including the
  Caller-Supplied AI Keys (BYOK) section.
- Issue [#284](https://github.com/clouatre-labs/aptu-github-app/issues/284) -- the evaluation
  request this document answers.

## Purpose

Evaluate whether triage, review, and scan operations could be executed server-side (inside the
Cloudflare Worker) instead of caller-side on GitHub Actions runners, with go/no-go criteria. The
premise of the evaluation was left open in #284; this document records the decision.

## Methodology

Direct verification against the repository at commit `79488f1`: `worker/wrangler.toml` bindings,
`worker/src/index.ts` (webhook handling, token minting, dispatch), `worker/src/config.ts`
(`ai.provider`/`ai.model` resolution), `docs/ARCHITECTURE.md` lines 192-209 (BYOK custody
guarantees), and the three reusable workflows' secret handling. No code was modified during
this audit.

---

## Findings

| # | Finding | Severity | Confirmed | Status |
| --- | --- | --- | --- | --- |
| N1 | Server-side execution inverts BYOK: the Worker would have to hold per-installation AI keys | **Critical** | Yes | Blocking |
| N2 | Storage gap: no KV or D1 bindings exist; adding key custody requires a new storage binding plus a key-submission, rotation, and deletion lifecycle | High | Yes | Blocking |
| N3 | Execution gap: the Worker has no AI provider integration; the AI call today lives entirely in the `aptu` action on caller runners, and a wasm provider layer does not exist | High | Yes | Blocking |
| N4 | Custody burden: server-side key storage expands breach scope, creates an abuse magnet, and adds key-exposure-via-logs risk | High | Yes | Blocking |

### N1 -- BYOK inversion: the key would pass through the Worker

**Severity:** Critical | **Confirmed:** Yes

`docs/ARCHITECTURE.md` (Caller-Supplied AI Keys section) states the invariant directly: the AI
API key secret value never passes through the Worker or the webhook dispatch payload; it is
resolved caller-side from the caller's own repository secrets. Server-side execution breaks
this by construction -- the Worker cannot call an AI provider without possessing the key. Every
installation's AI key would transit or rest in Worker-controlled state, converting BYOK
("caller's key, caller's custody") into a hosted key vault operated by this repository's
maintainers. That is a different product with a different trust model and threat surface.

### N2 -- Storage gap: no binding for key material

**Severity:** High | **Confirmed:** Yes

`worker/wrangler.toml` binds only Durable Objects (`QUOTA`, `REPLAY_GUARD`, `TELEMETRY`,
`TELEMETRY_RATE_LIMIT`), all serving rate-limit/telemetry state with no secret-shaped data.
Holding AI keys server-side requires a new KV or D1 binding encrypted-at-rest, plus an entire
lifecycle that does not exist today: secure key submission from installers, rotation, deletion
on uninstall, and audit trails. Each lifecycle step is a new credential-handling surface with
its own failure modes.

### N3 -- Execution gap: no AI capability in the Worker

**Severity:** High | **Confirmed:** Yes

`worker/src/index.ts` performs signature validation, token minting, quota checks, and
`repository_dispatch` -- it never talks to an AI provider. All triage/review/scan intelligence
lives in the `aptu` action invoked by the caller's dispatch handler. Executing server-side
means porting that provider layer into the Worker (or a wasm module), including streaming HTTP
clients, prompt assembly, and response handling, plus the compute/time budget to run them
inside Workers' CPU limits. None of this scaffolding exists.

### N4 -- Custody burden

**Severity:** High | **Confirmed:** Yes

Centralizing third-party AI keys creates: a single high-value breach target; an abuse-magnet
for billing theft against every installation's key; and new log-redaction obligations (the
Worker already logs errors broadly; any key-bearing path multiplies leak-via-logging risk).
Under the current model, a Worker compromise exposes `WEBHOOK_SECRET` and `APP_PRIVATE_KEY`
-- already serious -- but not a fleet of provider API keys.

---

## Decision

**No-go.** Server-side execution of triage/review/scan is rejected. The hybrid caller-side
model (Worker dispatches, caller runners execute with caller keys) is retained. The critical
reason is N1: server-side execution is incompatible with BYOK custody by definition, and N2-N4
compound the cost with storage, execution, and custody burdens that the current architecture
has no answer for. No implementation work is warranted.

## Recommendations (partial wins that preserve BYOK)

Nothing in this decision forecloses server-side work that does not touch AI-key custody:

1. **Server-side pre-checks without secrets:** the Worker can cheaply validate
   `.github/aptu.yml`, path filters, and label state before dispatching, cutting no-op dispatches.
2. **Telemetry aggregation:** extend the existing `TELEMETRY` Durable Object to report
   dispatch-to-completion outcomes, improving observability without key exposure.
3. **Revisit only if BYOK is abandoned:** if a future product decision moves to
   operator-provided AI keys (operator's own org secrets), the execution-location question can
   be reopened; the analysis above applies to per-installation custody, which is today's model.

## Post-Audit Notes

This audit made no code, workflow, config, or policy changes. The decision is recorded here
and closes the evaluation in #284; no follow-up issue is required for the no-go itself.
