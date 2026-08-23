// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { describe, expect, it } from 'vitest';
import { parseConfig, shouldDispatch, shouldSkipByPathFilters } from './config';

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
    expect(config as unknown as Record<string, unknown>).not.toHaveProperty(
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

  it('accepts valid full ai block with provider, model, and api-key-secret as non-empty strings', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o\n  api-key-secret: OPENAI_API_KEY'
    );
    const config = parseConfig(raw);
    expect(config).not.toBeNull();
    expect(config?.ai).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      'api-key-secret': 'OPENAI_API_KEY',
    });
  });

  it('rejects ai block missing api-key-secret', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('rejects partial ai block with only provider set', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('rejects ai block with empty-string api-key-secret', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o\n  api-key-secret: ""'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('rejects ai block with empty-string fields', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: ""\n  model: gpt-4o'
    );
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
    expect(shouldDispatch(config, 'review')).toBe(false);
    expect(shouldDispatch(config, 'scan')).toBe(false);
  });

  it('returns true when feature enabled is true', () => {
    const config = {
      version: 1,
      triage: { enabled: true },
      review: { enabled: true },
      scan: { enabled: true },
    };
    expect(shouldDispatch(config, 'triage')).toBe(true);
    expect(shouldDispatch(config, 'review')).toBe(true);
    expect(shouldDispatch(config, 'scan')).toBe(true);
  });

  it('returns false when feature enabled is false', () => {
    const config = {
      version: 1,
      triage: { enabled: false },
      review: { enabled: false },
      scan: { enabled: false },
    };
    expect(shouldDispatch(config, 'triage')).toBe(false);
    expect(shouldDispatch(config, 'review')).toBe(false);
    expect(shouldDispatch(config, 'scan')).toBe(false);
  });
});

describe('shouldSkipByPathFilters', () => {
  it('returns false (do not skip) when pattern list is empty', () => {
    expect(shouldSkipByPathFilters([], ['src/index.ts'])).toBe(false);
  });

  it('returns false (dispatch) when all changed files match an include pattern', () => {
    expect(
      shouldSkipByPathFilters(['src/**', 'lib/**'], ['src/a.ts', 'lib/b.ts'])
    ).toBe(false);
  });

  it('returns false (dispatch) when at least one file matches an include pattern', () => {
    expect(
      shouldSkipByPathFilters(['src/**'], ['README.md', 'src/worker.ts'])
    ).toBe(false);
  });

  it('returns true (skip) when no changed files match any include pattern', () => {
    expect(
      shouldSkipByPathFilters(
        ['src/**', 'lib/**'],
        ['README.md', 'docs/ARCHITECTURE.md']
      )
    ).toBe(true);
  });

  it('returns true (skip) when file matches an exclude pattern (single exclude)', () => {
    expect(shouldSkipByPathFilters(['!docs/**'], ['docs/guide.md'])).toBe(true);
  });

  it('returns false (dispatch) when some files match exclude and some do not (exclude-only mode)', () => {
    expect(
      shouldSkipByPathFilters(
        ['!docs/**'],
        ['docs/guide.md', 'worker/index.ts']
      )
    ).toBe(false);
  });

  it('handles combined include and exclude: matches include but also matches exclude -> not qualified -> skips if only file', () => {
    expect(
      shouldSkipByPathFilters(['src/**', '!src/data/**'], ['src/data/raw.json'])
    ).toBe(true);
  });

  it('handles combined include and exclude: matches include and not exclude -> qualifies -> dispatches', () => {
    expect(
      shouldSkipByPathFilters(['src/**', '!src/data/**'], ['src/utils.ts'])
    ).toBe(false);
  });

  it('handles mixed PR: some files excluded, some files included and not excluded -> at least one qualifies -> dispatches', () => {
    expect(
      shouldSkipByPathFilters(
        ['src/**', '!src/data/**', '!docs/**'],
        ['src/data/raw.json', 'docs/readme.md', 'src/handler.ts']
      )
    ).toBe(false);
  });

  it('returns true (skip) when file list is empty and patterns are present', () => {
    expect(shouldSkipByPathFilters(['src/**'], [])).toBe(true);
  });

  it('returns false (dispatch) when file list is empty and patterns are empty', () => {
    expect(shouldSkipByPathFilters([], [])).toBe(false);
  });
});
