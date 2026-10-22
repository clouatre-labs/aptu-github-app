// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InstallationUsage,
  USAGE_MAX_INSTALLATIONS,
  USAGE_RETENTION_MS,
} from './usage.js';

interface MockStorage {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

interface MockCtx {
  storage: MockStorage;
}

function makeMockCtx(entries: Map<string, unknown> = new Map()): MockCtx {
  return {
    storage: {
      get: vi.fn(async (key: string) => entries.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        entries.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        return entries.delete(key);
      }),
      list: vi.fn(async (opts?: { prefix?: string }) => {
        const result = new Map();
        for (const [k, v] of entries) {
          if (!opts?.prefix || k.startsWith(opts.prefix)) result.set(k, v);
        }
        return result;
      }),
    },
  };
}

function recordRequest(
  eventType: string,
  installationId: number,
  outcome: string
): Request {
  return new Request('https://usage/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType, installationId, outcome }),
  });
}

describe('InstallationUsage Durable Object', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('record with success outcome increments the success counter', async () => {
    // Arrange
    const ctx = makeMockCtx();
    const usage = new InstallationUsage(ctx as unknown as DurableObjectState);

    // Act
    const response = await usage.fetch(recordRequest('triage', 42, 'success'));

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      counters: Record<string, { success: number; failure: number }>;
    };
    expect(body.counters.triage?.success).toBe(1);
    expect(body.counters.triage?.failure).toBe(0);
  });

  it('record with failure outcome increments the failure counter', async () => {
    // Arrange
    const ctx = makeMockCtx();
    const usage = new InstallationUsage(ctx as unknown as DurableObjectState);
    await usage.fetch(recordRequest('review', 7, 'failure'));

    // Act
    const second = await usage.fetch(recordRequest('review', 7, 'failure'));

    // Assert
    const body = (await second.json()) as {
      counters: Record<string, { success: number; failure: number }>;
    };
    expect(body.counters.review?.failure).toBe(2);
    expect(body.counters.review?.success).toBe(0);
  });

  it('rejects invalid installation ids', async () => {
    // Arrange
    const ctx = makeMockCtx(new Map<string, unknown>());
    const usage = new InstallationUsage(ctx as unknown as DurableObjectState);
    const invalidIds: unknown[] = [0, -1, 1.5, '7', Number.NaN];

    for (const id of invalidIds) {
      // Act
      const response = await usage.fetch(
        recordRequest('triage', id as number, 'success')
      );

      // Assert
      expect(response.status).toBe(400);
      expect(ctx.storage.put).not.toHaveBeenCalled();
    }
  });

  it('prunes installations inactive beyond the retention window and respects the entry cap', async () => {
    // Arrange
    const entries = new Map<string, unknown>();
    const now = Date.now();
    entries.set('usage:1', {
      counters: {},
      lastSeen: now - USAGE_RETENTION_MS - 1,
    });
    for (let id = 2; id <= USAGE_MAX_INSTALLATIONS + 3; id++) {
      entries.set(`usage:${id}`, { counters: {}, lastSeen: now - id });
    }
    const ctx = makeMockCtx(entries);
    const usage = new InstallationUsage(ctx as unknown as DurableObjectState);

    // Act
    const response = await usage.fetch(recordRequest('mention', 9, 'success'));

    // Assert
    expect(response.status).toBe(200);
    expect(ctx.storage.delete).toHaveBeenCalledWith('usage:1');
    const remaining = [...entries.keys()];
    expect(remaining.length).toBe(USAGE_MAX_INSTALLATIONS);
    // The newly active installation survives; the least-recently-active were evicted.
    expect(entries.has('usage:9')).toBe(true);
    expect(entries.has(`usage:${USAGE_MAX_INSTALLATIONS + 3}`)).toBe(false);
  });
});

describe('maybeRecordUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function makeMockEnv(fetchImpl: () => Promise<Response>) {
    return {
      INSTALLATION_USAGE: {
        idFromName: vi.fn((name: string) => name),
        get: () => ({ fetch: fetchImpl }),
      },
    };
  }

  it('routes usage recording to the shared global DO instance', async () => {
    // Arrange
    const env = makeMockEnv(async () => new Response(null, { status: 200 }));
    const { maybeRecordUsage } = await import('./index.js');

    // Act
    await maybeRecordUsage(
      env as never,
      { telemetry: { enabled: true } } as never,
      42,
      'triage',
      'success'
    );

    // Assert
    expect(env.INSTALLATION_USAGE.idFromName).toHaveBeenCalledWith('global');
  });

  it('does not call the DO when config.telemetry.enabled is false', async () => {
    // Arrange
    const fetchMock = vi.fn();
    const env = makeMockEnv(fetchMock);
    const { maybeRecordUsage } = await import('./index.js');

    // Act
    await maybeRecordUsage(
      env as never,
      { telemetry: { enabled: false } } as never,
      1,
      'triage',
      'success'
    );

    // Assert
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs a DO fetch failure and never throws', async () => {
    // Arrange
    const env = makeMockEnv(async () => {
      throw new Error('boom');
    });
    const { maybeRecordUsage } = await import('./index.js');

    // Act
    const result = await maybeRecordUsage(
      env as never,
      { telemetry: { enabled: true } } as never,
      1,
      'triage',
      'success'
    );

    // Assert
    expect(result).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('logs a non-2xx DO response and never throws', async () => {
    // Arrange
    const env = makeMockEnv(async () => new Response('nope', { status: 500 }));
    const { maybeRecordUsage } = await import('./index.js');

    // Act
    const result = await maybeRecordUsage(
      env as never,
      { telemetry: { enabled: true } } as never,
      1,
      'review',
      'failure'
    );

    // Assert
    expect(result).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
