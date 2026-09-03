// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

// TelemetryRollup Durable Object
// Accepts opt-in, anonymized review-context counters from the aptu action's
// telemetry-rollup step and accumulates them into a single global aggregate.
// No repo, PR, or actor identifiers are ever accepted -- the payload is
// validated against a strict key allowlist matching the schema shipped by
// aptu#1585 and any unrecognized key causes the whole payload to be rejected.
//
// The endpoint is fire-and-forget: it always returns 202, whether the
// payload is valid, malformed, or the Durable Object write fails, so a
// telemetry POST never fails the caller's PR review job.

import { captureException } from '@sentry/cloudflare';
import type { Env } from './index';

const HISTOGRAM_BOUNDS = [25, 50, 75, 90];
const HISTOGRAM_BUCKET_COUNT = HISTOGRAM_BOUNDS.length + 1;

// Per-IP rate limit for the unauthenticated /telemetry/rollup endpoint -- see
// SECURITY.md for why this endpoint intentionally bypasses HMAC validation.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

interface RateLimitState {
  windowStart: number;
  count: number;
}

/**
 * TelemetryRateLimit Durable Object: one instance per CF-Connecting-IP
 * (idFromName), tracking a rolling 60s request count. Bounds how much an
 * unauthenticated caller can write into the shared TelemetryRollup aggregate.
 */
export class TelemetryRateLimit {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(): Promise<Response> {
    const now = Date.now();
    const stored = await this.ctx.storage.get<RateLimitState>('state');
    const state =
      stored && now - stored.windowStart < RATE_LIMIT_WINDOW_MS
        ? stored
        : { windowStart: now, count: 0 };

    if (state.count >= RATE_LIMIT_MAX_REQUESTS) {
      return Response.json({ exceeded: true });
    }

    state.count += 1;
    await this.ctx.storage.put('state', state);
    return Response.json({ exceeded: false });
  }
}

// Cap on distinct keys per count map (budget_drop_reason_counts,
// finish_reasons_counts, model_tier_counts). These keys are legitimately
// dynamic -- e.g. aptu's budget_drops includes `patch:<filename>` /
// `file_content:<filename>` entries and model_tier_counts keys are
// user-configured model strings -- so a fixed allowlist isn't viable here.
// Existing keys keep accumulating past the cap; new keys are dropped once
// it's reached, bounding the Durable Object's stored state.
const MAX_COUNT_MAP_KEYS = 256;

const ALLOWED_KEYS = new Set([
  'reviews_total',
  'truncation_events_total',
  'files_truncated_total',
  'budget_drop_reason_counts',
  'finish_reasons_counts',
  'model_tier_counts',
  'prompt_budget_pct_histogram',
  'run_id',
  'timestamp',
]);

export interface TelemetryHistogram {
  explicit_bounds: number[];
  bucket_counts: number[];
}

export interface TelemetryCounters {
  reviews_total: number;
  truncation_events_total: number;
  files_truncated_total: number;
  budget_drop_reason_counts: Record<string, number>;
  finish_reasons_counts: Record<string, number>;
  model_tier_counts: Record<string, number>;
  prompt_budget_pct_histogram: TelemetryHistogram;
  run_id: string;
  timestamp: string;
}

interface TelemetryAggregate {
  reviews_total: number;
  truncation_events_total: number;
  files_truncated_total: number;
  budget_drop_reason_counts: Record<string, number>;
  finish_reasons_counts: Record<string, number>;
  model_tier_counts: Record<string, number>;
  prompt_budget_pct_histogram: TelemetryHistogram;
}

function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCountMap(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isValidCount);
}

function isFixedNumberArray(value: unknown, expected: number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((v, i) => v === expected[i])
  );
}

function isHistogram(value: unknown): value is TelemetryHistogram {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!isFixedNumberArray(obj.explicit_bounds, HISTOGRAM_BOUNDS)) {
    return false;
  }
  if (!Array.isArray(obj.bucket_counts)) {
    return false;
  }
  if (obj.bucket_counts.length !== HISTOGRAM_BUCKET_COUNT) {
    return false;
  }
  return obj.bucket_counts.every(isValidCount);
}

export function validateTelemetryPayload(
  body: unknown
): TelemetryCounters | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }

  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      return null;
    }
  }

  if (
    !isValidCount(obj.reviews_total) ||
    !isValidCount(obj.truncation_events_total) ||
    !isValidCount(obj.files_truncated_total) ||
    typeof obj.run_id !== 'string' ||
    typeof obj.timestamp !== 'string'
  ) {
    return null;
  }

  if (
    !isCountMap(obj.budget_drop_reason_counts) ||
    !isCountMap(obj.finish_reasons_counts) ||
    !isCountMap(obj.model_tier_counts)
  ) {
    return null;
  }

  if (!isHistogram(obj.prompt_budget_pct_histogram)) {
    return null;
  }

  return {
    reviews_total: obj.reviews_total,
    truncation_events_total: obj.truncation_events_total,
    files_truncated_total: obj.files_truncated_total,
    budget_drop_reason_counts: obj.budget_drop_reason_counts as Record<
      string,
      number
    >,
    finish_reasons_counts: obj.finish_reasons_counts as Record<
      string,
      number
    >,
    model_tier_counts: obj.model_tier_counts as Record<string, number>,
    prompt_budget_pct_histogram: obj.prompt_budget_pct_histogram as TelemetryHistogram,
    run_id: obj.run_id,
    timestamp: obj.timestamp,
  };
}

function mergeCountMap(
  a: Record<string, number>,
  b: Record<string, number>
): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key in merged) {
      merged[key] = (merged[key] as number) + value;
    } else if (Object.keys(merged).length < MAX_COUNT_MAP_KEYS) {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeAggregate(
  stored: TelemetryAggregate | undefined,
  incoming: TelemetryCounters
): TelemetryAggregate {
  const base: TelemetryAggregate = stored ?? {
    reviews_total: 0,
    truncation_events_total: 0,
    files_truncated_total: 0,
    budget_drop_reason_counts: {},
    finish_reasons_counts: {},
    model_tier_counts: {},
    prompt_budget_pct_histogram: {
      explicit_bounds: HISTOGRAM_BOUNDS,
      bucket_counts: new Array(HISTOGRAM_BUCKET_COUNT).fill(0),
    },
  };

  return {
    reviews_total: base.reviews_total + incoming.reviews_total,
    truncation_events_total:
      base.truncation_events_total + incoming.truncation_events_total,
    files_truncated_total:
      base.files_truncated_total + incoming.files_truncated_total,
    budget_drop_reason_counts: mergeCountMap(
      base.budget_drop_reason_counts,
      incoming.budget_drop_reason_counts
    ),
    finish_reasons_counts: mergeCountMap(
      base.finish_reasons_counts,
      incoming.finish_reasons_counts
    ),
    model_tier_counts: mergeCountMap(
      base.model_tier_counts,
      incoming.model_tier_counts
    ),
    prompt_budget_pct_histogram: {
      explicit_bounds: HISTOGRAM_BOUNDS,
      bucket_counts: base.prompt_budget_pct_histogram.bucket_counts.map(
        (v, i) =>
          v + (incoming.prompt_budget_pct_histogram.bucket_counts[i] ?? 0)
      ),
    },
  };
}

export class TelemetryRollup {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const counters = (await request.json()) as TelemetryCounters;
      const key = 'aggregate';
      const stored = await this.ctx.storage.get<TelemetryAggregate>(key);
      const merged = mergeAggregate(stored, counters);
      await this.ctx.storage.put(key, merged);
    } catch {
      // Fire-and-forget: never surface a failure to the caller.
    }
    return new Response(null, { status: 202 });
  }
}

export async function handleTelemetryRollup(
  request: Request,
  env: Env
): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) {
    try {
      const rateLimitId = env.TELEMETRY_RATE_LIMIT.idFromName(ip);
      const rateLimitStub = env.TELEMETRY_RATE_LIMIT.get(rateLimitId);
      const rateLimitResponse = await rateLimitStub.fetch(
        'https://telemetry/rate-limit',
        { method: 'POST' }
      );
      const { exceeded } = (await rateLimitResponse.json()) as {
        exceeded: boolean;
      };
      if (exceeded) {
        return new Response(null, { status: 202 });
      }
    } catch (error) {
      // Fail open: a broken rate limiter must never block telemetry ingestion.
      captureException(error, { tags: { component: 'telemetry-rate-limit' } });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 202 });
  }

  const counters = validateTelemetryPayload(body);
  if (counters === null) {
    return new Response(null, { status: 202 });
  }

  try {
    const id = env.TELEMETRY.idFromName('global');
    const stub = env.TELEMETRY.get(id);
    await stub.fetch('https://telemetry/rollup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(counters),
    });
  } catch {
    // Fire-and-forget: DO errors never surface to the caller.
  }

  return new Response(null, { status: 202 });
}
