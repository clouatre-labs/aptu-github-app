// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

// InstallationQuota Durable Object
// Persists per-installation event counters using Durable Object SQLite-backed storage.
// Rolling 24-hour window: timestamps older than 24h are pruned on each request.
// After QUOTA_LIMIT events within the window, returns exceeded=true with a Retry-After
// header. The operator's own org (see OPERATOR_ORG in index.ts) bypasses this entirely.
//
// The fetch handler accepts an `action` field in the POST body:
//   - 'check'  (default): read-only; returns exceeded/count/retryAfter without
//     appending a new timestamp. Pruning of stale timestamps still occurs.
//   - 'record': appends the current timestamp to the window and persists it.
//
// Known limitation (TOCTOU race): concurrent webhooks from the same installation
// can all pass the 'check' action before any 'record' write lands, allowing a
// burst over the QUOTA_LIMIT. This is acceptable for rate limiting; the rolling
// window eventually catches up on subsequent requests.

export const QUOTA_LIMIT = 500;
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

interface QuotaState {
  timestamps: number[];
}

export class InstallationQuota {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    let eventType: string;
    let installationId: number;
    let action: string;

    try {
      const body = (await request.json()) as {
        eventType: string;
        installationId: number;
        action?: string;
      };
      eventType = body.eventType;
      installationId = body.installationId;
      action = body.action ?? 'check';
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (!eventType || !installationId) {
      return new Response('Bad Request', { status: 400 });
    }

    const key = `quota:${installationId}:${eventType}`;
    const stored = await this.ctx.storage.get<QuotaState>(key);
    const timestamps = stored?.timestamps ?? [];

    const now = Date.now();
    const windowMs = QUOTA_WINDOW_MS;
    const cutoff = now - windowMs;

    // Prune timestamps older than the rolling 24h window
    const recent: number[] = [];
    for (const ts of timestamps) {
      if (ts > cutoff) {
        recent.push(ts);
      }
    }

    if (recent.length >= QUOTA_LIMIT) {
      // Exceeded: calculate retry-after from the oldest timestamp's window expiry
      const oldest = recent[0] as number;
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);

      // Only write if pruning removed stale timestamps (avoid no-op writes)
      if (
        recent.length !== (stored?.timestamps as number[] | undefined)?.length
      ) {
        await this.ctx.storage.put(key, { timestamps: recent });
      }

      return Response.json({
        count: recent.length,
        exceeded: true,
        retryAfter,
      });
    }

    if (action === 'record') {
      // Record action: append current timestamp and persist
      recent.push(now);
      await this.ctx.storage.put(key, { timestamps: recent });
    } else if (
      recent.length !== (stored?.timestamps as number[] | undefined)?.length
    ) {
      // Check action: persist pruned list only if stale timestamps were removed
      await this.ctx.storage.put(key, { timestamps: recent });
    }

    return Response.json({
      count: recent.length,
      exceeded: false,
      retryAfter: null,
    });
  }
}
