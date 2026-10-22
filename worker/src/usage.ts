// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

// InstallationUsage Durable Object
// Persists per-installation usage counters (adoption metrics) using Durable
// Object SQLite-backed storage. Counters are keyed only by installation id,
// event type (triage/review), and outcome (success/failure); no repo
// names, issue/PR numbers, user ids, or secrets are ever stored. The
// installation id is pseudonymous: it identifies an installation, not a person.
//
// Unlike InstallationQuota (abuse protection), operator-org installations are
// counted here too -- this DO measures adoption, not abuse.
//
// State is bounded two ways, enforced on every record:
//   1. Installations inactive beyond USAGE_RETENTION_MS are pruned.
//   2. When USAGE_MAX_INSTALLATIONS entries remain, the least-recently-active
//      installations are evicted first.

export const USAGE_MAX_INSTALLATIONS = 1000;
export const USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const VALID_EVENT_TYPES = new Set(['triage', 'review']);
const VALID_OUTCOMES = new Set(['success', 'failure']);

export interface UsageCounters {
  success: number;
  failure: number;
}

export interface UsageEntry {
  counters: Record<string, UsageCounters>;
  lastSeen: number;
}

export class InstallationUsage {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    let eventType: string;
    let installationId: number;
    let outcome: string;

    try {
      const body = (await request.json()) as {
        eventType: string;
        installationId: number;
        outcome: string;
      };
      eventType = body.eventType;
      installationId = body.installationId;
      outcome = body.outcome;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (
      typeof installationId !== 'number' ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0 ||
      !VALID_EVENT_TYPES.has(eventType) ||
      !VALID_OUTCOMES.has(outcome)
    ) {
      return new Response('Bad Request', { status: 400 });
    }

    const key = `usage:${installationId}`;
    const now = Date.now();
    const stored = await this.ctx.storage.get<UsageEntry>(key);
    const entry: UsageEntry = stored ?? { counters: {}, lastSeen: now };
    const counters = entry.counters[eventType] ?? { success: 0, failure: 0 };
    counters[outcome as keyof UsageCounters] += 1;
    entry.counters[eventType] = counters;
    entry.lastSeen = now;
    await this.ctx.storage.put(key, entry);

    // Enforce retention and the entry cap after writing so the cap holds
    // even when this record introduces a new installation; the freshly
    // written entry has the newest lastSeen and will not be evicted.
    await this.prune();

    return Response.json({ ok: true, counters: entry.counters });
  }

  /**
   * Bounds stored state: deletes installations inactive beyond the retention
   * window, then evicts the least-recently-active installations while the
   * entry count exceeds the cap.
   */
  async prune(): Promise<void> {
    const entries = await this.ctx.storage.list<UsageEntry>({
      prefix: 'usage:',
    });
    const now = Date.now();
    const cutoff = now - USAGE_RETENTION_MS;

    const survivors: Array<[string, number]> = [];
    for (const [key, entry] of entries) {
      if ((entry?.lastSeen ?? 0) < cutoff) {
        await this.ctx.storage.delete(key);
      } else {
        survivors.push([key, entry?.lastSeen ?? 0]);
      }
    }

    if (survivors.length <= USAGE_MAX_INSTALLATIONS) return;

    survivors.sort((a, b) => a[1] - b[1]);
    const toEvict = survivors.length - USAGE_MAX_INSTALLATIONS;
    for (let i = 0; i < toEvict; i++) {
      const key = survivors[i]?.[0];
      if (key) await this.ctx.storage.delete(key);
    }
  }
}
