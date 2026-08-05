// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

// InstallationQuota Durable Object
// Persists per-installation event counters using Durable Object SQLite-backed storage.
// Rolling 24-hour window: timestamps older than 24h are pruned on each request.
// After 50 events within the window, returns exceeded=true with a Retry-After header.

export const QUOTA_LIMIT = 50;
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

    try {
      const body = (await request.json()) as {
        eventType: string;
        installationId: number;
      };
      eventType = body.eventType;
      installationId = body.installationId;
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

    // Count within limit: record this event
    recent.push(now);
    await this.ctx.storage.put(key, { timestamps: recent });

    return Response.json({
      count: recent.length,
      exceeded: false,
      retryAfter: null,
    });
  }
}

// GlobalQuota Durable Object
// Persists org-wide event counters using Durable Object SQLite-backed storage.
// A single well-known instance (idFromName('global')) enforces a configurable ceiling.
// The limit travels in the Request body because the DO has no env access; it is
// Number()-coerced with a 500 fallback in checkGlobalQuota (index.ts).

export class GlobalQuota {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    let limit: number;

    try {
      const body = (await request.json()) as { limit: number };
      limit = body.limit;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (!limit || limit <= 0) {
      return new Response('Bad Request', { status: 400 });
    }

    const key = 'quota:global';
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

    if (recent.length >= limit) {
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

    // Count within limit: record this event
    recent.push(now);
    await this.ctx.storage.put(key, { timestamps: recent });

    return Response.json({
      count: recent.length,
      exceeded: false,
      retryAfter: null,
    });
  }
}
