// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryCounters } from './telemetry.js';

function makeValidPayload(
  overrides: Partial<TelemetryCounters> = {}
): TelemetryCounters {
  return {
    reviews_total: 1,
    truncation_events_total: 0,
    files_truncated_total: 0,
    budget_drop_reason_counts: { size_limit: 1 },
    finish_reasons_counts: { stop: 1 },
    model_tier_counts: { standard: 1 },
    prompt_budget_pct_histogram: {
      explicit_bounds: [25, 50, 75, 90],
      bucket_counts: [0, 0, 1, 0, 0],
    },
    run_id: 'run-123',
    timestamp: '2026-09-03T00:00:00Z',
    ...overrides,
  };
}

describe('validateTelemetryPayload', () => {
  it('returns the typed object for a valid full counters payload', async () => {
    const { validateTelemetryPayload } = await import('./telemetry.js');
    const payload = makeValidPayload();
    expect(validateTelemetryPayload(payload)).toEqual(payload);
  });

  it('returns null for a payload with an unknown key', async () => {
    const { validateTelemetryPayload } = await import('./telemetry.js');
    const payload = { ...makeValidPayload(), pr: 42, github_actor: 'user1' };
    expect(validateTelemetryPayload(payload)).toBeNull();
  });

  it('returns null when bucket_counts has the wrong length', async () => {
    const { validateTelemetryPayload } = await import('./telemetry.js');
    const payload = makeValidPayload({
      prompt_budget_pct_histogram: {
        explicit_bounds: [25, 50, 75, 90],
        bucket_counts: [0, 0, 1],
      },
    });
    expect(validateTelemetryPayload(payload)).toBeNull();
  });

  it('returns null when explicit_bounds is not the fixed vector', async () => {
    const { validateTelemetryPayload } = await import('./telemetry.js');
    const payload = makeValidPayload({
      prompt_budget_pct_histogram: {
        explicit_bounds: [10, 20, 30, 40],
        bucket_counts: [0, 0, 1, 0, 0],
      },
    });
    expect(validateTelemetryPayload(payload)).toBeNull();
  });

  it('returns null when a required field is missing', async () => {
    const { validateTelemetryPayload } = await import('./telemetry.js');
    const payload = makeValidPayload() as unknown as Record<string, unknown>;
    delete payload.run_id;
    expect(validateTelemetryPayload(payload)).toBeNull();
  });
});

describe('handleTelemetryRollup', () => {
  function makeMockEnv(): {
    env: { TELEMETRY: DurableObjectNamespace };
    stubFetch: ReturnType<typeof vi.fn>;
  } {
    const stubFetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 202 }))
    );
    const stub = { fetch: stubFetch };
    const env = {
      TELEMETRY: {
        idFromName: vi.fn(() => 'mock-id' as unknown as DurableObjectId),
        get: vi.fn(() => stub as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
    };
    return { env, stubFetch };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 202 without calling the DO on malformed JSON body', async () => {
    const { handleTelemetryRollup } = await import('./telemetry.js');
    const { env, stubFetch } = makeMockEnv();
    const request = new Request('https://aptu.dev/telemetry/rollup', {
      method: 'POST',
      body: 'not json',
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal Env stub for this test
    const response = await handleTelemetryRollup(request, env as any);
    expect(response.status).toBe(202);
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it('forwards a valid payload to the TELEMETRY DO and returns 202', async () => {
    const { handleTelemetryRollup } = await import('./telemetry.js');
    const { env, stubFetch } = makeMockEnv();
    const request = new Request('https://aptu.dev/telemetry/rollup', {
      method: 'POST',
      body: JSON.stringify(makeValidPayload()),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal Env stub for this test
    const response = await handleTelemetryRollup(request, env as any);
    expect(response.status).toBe(202);
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it('returns 202 without calling the DO when payload has an unknown key', async () => {
    const { handleTelemetryRollup } = await import('./telemetry.js');
    const { env, stubFetch } = makeMockEnv();
    const request = new Request('https://aptu.dev/telemetry/rollup', {
      method: 'POST',
      body: JSON.stringify({ ...makeValidPayload(), pr: 42 }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal Env stub for this test
    const response = await handleTelemetryRollup(request, env as any);
    expect(response.status).toBe(202);
    expect(stubFetch).not.toHaveBeenCalled();
  });
});

describe('TelemetryRollup Durable Object', () => {
  interface MockStorage {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  }

  function makeMockCtx(): { storage: MockStorage } {
    const data = new Map<string, unknown>();
    return {
      storage: {
        get: vi.fn((key: string) => Promise.resolve(data.get(key))),
        put: vi.fn((key: string, value: unknown) => {
          data.set(key, value);
          return Promise.resolve();
        }),
      },
    };
  }

  it('accumulates counters across two sequential valid POSTs', async () => {
    const { TelemetryRollup } = await import('./telemetry.js');
    const ctx = makeMockCtx();
    const rollup = new TelemetryRollup(
      ctx as unknown as DurableObjectState
    );

    const first = makeValidPayload({
      reviews_total: 2,
      budget_drop_reason_counts: { size_limit: 1 },
      prompt_budget_pct_histogram: {
        explicit_bounds: [25, 50, 75, 90],
        bucket_counts: [1, 0, 0, 0, 0],
      },
    });
    const second = makeValidPayload({
      reviews_total: 3,
      budget_drop_reason_counts: { size_limit: 2, token_limit: 1 },
      prompt_budget_pct_histogram: {
        explicit_bounds: [25, 50, 75, 90],
        bucket_counts: [0, 1, 0, 0, 0],
      },
    });

    await rollup.fetch(
      new Request('https://telemetry/rollup', {
        method: 'POST',
        body: JSON.stringify(first),
      })
    );
    await rollup.fetch(
      new Request('https://telemetry/rollup', {
        method: 'POST',
        body: JSON.stringify(second),
      })
    );

    const stored = ctx.storage.put.mock.calls.at(-1)?.[1] as {
      reviews_total: number;
      budget_drop_reason_counts: Record<string, number>;
      prompt_budget_pct_histogram: { bucket_counts: number[] };
    };
    expect(stored.reviews_total).toBe(5);
    expect(stored.budget_drop_reason_counts).toEqual({
      size_limit: 3,
      token_limit: 1,
    });
    expect(stored.prompt_budget_pct_histogram.bucket_counts).toEqual([
      1, 1, 0, 0, 0,
    ]);
  });
});
