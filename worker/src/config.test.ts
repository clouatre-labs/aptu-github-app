// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { describe, expect, it } from 'vitest';
import { parseConfig, shouldDispatch } from './config';

describe('parseConfig', () => {
  it('returns null for version != 1', () => {
    const raw = btoa('version: 2\ntriage:\n  enabled: true');
    expect(parseConfig(raw)).toBeNull();
  });

  it('returns null when triage.enabled is a non-boolean string', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: "yes"\nreview:\n  enabled: true'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('ignores unknown fields without error and returns valid config', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nunknown_field: will_be_ignored\nnested:\n  also: ignored'
    );
    const config = parseConfig(raw);
    expect(config).not.toBeNull();
    expect(config?.version).toBe(1);
    expect(config?.triage?.enabled).toBe(true);
    expect(config?.review?.enabled).toBe(true);
    expect(config as Record<string, unknown>).not.toHaveProperty(
      'unknown_field'
    );
  });

  it('returns null when review block exists but enabled field is missing', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  skip-labeled: true'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('returns null on base64 decode failure (corrupt content)', () => {
    const raw = '!!!not-valid-base64!!!';
    expect(parseConfig(raw)).toBeNull();
  });
});

describe('shouldDispatch', () => {
  it('returns false when config is null', () => {
    expect(shouldDispatch(null, 'triage')).toBe(false);
  });

  it('returns false when feature key is missing from config', () => {
    const config = { version: 1 };
    expect(shouldDispatch(config, 'triage')).toBe(false);
  });

  it('returns false when feature.enabled is explicitly false', () => {
    const config = { version: 1, triage: { enabled: false } };
    expect(shouldDispatch(config, 'triage')).toBe(false);
  });

  it('returns true when feature.enabled is explicitly true', () => {
    const config = { version: 1, triage: { enabled: true } };
    expect(shouldDispatch(config, 'triage')).toBe(true);
  });
});
