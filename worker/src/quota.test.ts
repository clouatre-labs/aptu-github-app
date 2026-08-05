// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('increments counter per installation id and event type', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    ctx.storage.get.mockResolvedValue(null);
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'triage', installationId: 1 }),
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

  it('returns exceeded=true once count reaches 50 within rolling 24h window', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const existingTimestamps = Array.from(
      { length: 50 },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({ timestamps: existingTimestamps });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'triage', installationId: 1 }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
      retryAfter: number | null;
    };
    expect(body.count).toBe(50);
    expect(body.exceeded).toBe(true);
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('skips storage.put when exceeded and no timestamps were pruned', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const existingTimestamps = Array.from(
      { length: 50 },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({ timestamps: existingTimestamps });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'triage', installationId: 1 }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
      retryAfter: number | null;
    };
    expect(body.count).toBe(50);
    expect(body.exceeded).toBe(true);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('requests older than 24h are not counted toward current window', async () => {
    const { InstallationQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    const recent = Array.from({ length: 49 }, (_, i) => now - i * 60000);
    ctx.storage.get.mockResolvedValue({
      timestamps: [...recent, now - windowMs - 3600000],
    });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'triage', installationId: 1 }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(body.count).toBe(50);
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
      timestamps: Array.from({ length: 50 }, (_, i) => now - i * 60000),
    });
    const quota = new InstallationQuota(ctx as unknown as DurableObjectState);

    const triageResp = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'triage', installationId: 1 }),
      })
    );
    const triageBody = (await triageResp.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(triageBody.count).toBe(50);
    expect(triageBody.exceeded).toBe(true);

    const reviewResp = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'review', installationId: 1 }),
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

describe('GlobalQuota Durable Object', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments global counter per dispatch, returns count and exceeded=false when under limit', async () => {
    const { GlobalQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    ctx.storage.get.mockResolvedValue(null);
    const quota = new GlobalQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
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

  it('returns exceeded=true when global count reaches configured limit', async () => {
    const { GlobalQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const existingTimestamps = Array.from(
      { length: 500 },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({ timestamps: existingTimestamps });
    const quota = new GlobalQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
      retryAfter: number | null;
    };
    expect(body.count).toBe(500);
    expect(body.exceeded).toBe(true);
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('prunes timestamps older than 24h from global counter', async () => {
    const { GlobalQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    const recent = Array.from({ length: 499 }, (_, i) => now - i * 60000);
    ctx.storage.get.mockResolvedValue({
      timestamps: [...recent, now - windowMs - 3600000],
    });
    const quota = new GlobalQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(body.count).toBe(500);
    expect(body.exceeded).toBe(false);
  });

  it('skips storage.put on exceeded path when no timestamps were pruned', async () => {
    const { GlobalQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const existingTimestamps = Array.from(
      { length: 500 },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({ timestamps: existingTimestamps });
    const quota = new GlobalQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(body.exceeded).toBe(true);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('calls storage.put on exceeded path when timestamps were pruned', async () => {
    const { GlobalQuota } = await import('./quota.js');
    const ctx = makeMockCtx();
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    const existingTimestamps = Array.from(
      { length: 500 },
      (_, i) => now - i * 60000
    );
    ctx.storage.get.mockResolvedValue({
      timestamps: [...existingTimestamps, now - windowMs - 3600000],
    });
    const quota = new GlobalQuota(ctx as unknown as DurableObjectState);

    const response = await quota.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 500 }),
      })
    );
    const body = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(body.exceeded).toBe(true);
    expect(ctx.storage.put).toHaveBeenCalledTimes(1);
  });
});
