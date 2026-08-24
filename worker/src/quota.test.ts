// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTA_LIMIT } from './quota.js';

interface MockStorage {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

interface MockCtx {
  storage: MockStorage;
}

function makeMockCtx(): MockCtx {
  return {
    storage: {
      get: vi.fn(),
      put: vi.fn(),
    },
  };
}

describe('InstallationQuota Durable Object', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments counter per installation id and event type with record action', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    ctx.storage.get.mockResolvedValue(null);
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'triage',
          installationId: 1,
          action: 'record',
        }),
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(body.count).toBe(1);
    expect(body.exceeded).toBe(false);
  });

  it('returns exceeded=true once count reaches QUOTA_LIMIT within rolling 24h window', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const existingTimestamps = Array.from(
      { length: QUOTA_LIMIT },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({ timestamps: existingTimestamps });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'triage',
          installationId: 1,
          action: 'check',
        }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
      retryAfter: number | null;
    };
    expect(body.count).toBe(QUOTA_LIMIT);
    expect(body.exceeded).toBe(true);
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('skips storage.put when exceeded and no timestamps were pruned', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const existingTimestamps = Array.from(
      { length: QUOTA_LIMIT },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({ timestamps: existingTimestamps });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'triage',
          installationId: 1,
          action: 'check',
        }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
      retryAfter: number | null;
    };
    expect(body.count).toBe(QUOTA_LIMIT);
    expect(body.exceeded).toBe(true);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('requests older than 24h are not counted toward current window', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    const recent = Array.from(
      { length: QUOTA_LIMIT - 1 },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({
      timestamps: [...recent, now - windowMs - 3600000],
    });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'triage',
          installationId: 1,
          action: 'record',
        }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(body.count).toBe(QUOTA_LIMIT);
    expect(body.exceeded).toBe(false);
  });

  it('triage and review counters tracked independently', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const storageMap = new Map<string, { timestamps: number[] }>();
    ctx.storage.get.mockImplementation((key: string) =>
      Promise.resolve(storageMap.get(key) ?? null)
    );
    ctx.storage.put.mockImplementation(
      (key: string, value: { timestamps: number[] }) => {
        storageMap.set(key, value);
        return Promise.resolve();
      }
    );
    const now = Date.now();
    storageMap.set('quota:1:triage', {
      timestamps: Array.from({ length: QUOTA_LIMIT }, (_, i) => now - i * 60000),
    });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const triageResp = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'triage',
          installationId: 1,
          action: 'check',
        }),
      })
    );
    const triageBody = (await triageResp.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(triageBody.count).toBe(QUOTA_LIMIT);
    expect(triageBody.exceeded).toBe(true);

    const reviewResp = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'review',
          installationId: 1,
          action: 'record',
        }),
      })
    );
    const reviewBody = (await reviewResp.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(reviewBody.count).toBe(1);
    expect(reviewBody.exceeded).toBe(false);
  });
});
