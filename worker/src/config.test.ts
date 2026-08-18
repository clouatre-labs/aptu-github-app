// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { describe, expect, it } from 'vitest';
import {
  AI_KEY_SECRET_PATTERN,
  parseConfig,
  shouldDispatch,
  shouldSkipByPathFilters,
} from './config';

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

  it('accepts valid full ai block with provider, model, api-key-secret as non-empty strings', () => {
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

  it('rejects partial ai block with only provider set', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('rejects ai block with empty-string fields', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: ""\n  model: gpt-4o\n  api-key-secret: OPENAI_API_KEY'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('rejects ai block when api-key-secret is empty string', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o\n  api-key-secret: ""'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('rejects ai block when api-key-secret contains lowercase characters', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o\n  api-key-secret: gemini_api_key'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('rejects ai block when api-key-secret contains a hyphen', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o\n  api-key-secret: GEMINI-API-KEY'
    );
    expect(parseConfig(raw)).toBeNull();
  });
});

describe('AI_KEY_SECRET_PATTERN', () => {
  it('accepts uppercase letters, digits, and underscores', () => {
    expect(AI_KEY_SECRET_PATTERN.test('GEMINI_API_KEY')).toBe(true);
    expect(AI_KEY_SECRET_PATTERN.test('MY_KEY_123')).toBe(true);
  });

  it('rejects empty string, lowercase, hyphens, and spaces', () => {
    expect(AI_KEY_SECRET_PATTERN.test('')).toBe(false);
    expect(AI_KEY_SECRET_PATTERN.test('gemini_api_key')).toBe(false);
    expect(AI_KEY_SECRET_PATTERN.test('GEMINI-API-KEY')).toBe(false);
    expect(AI_KEY_SECRET_PATTERN.test('MY KEY')).toBe(false);
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

  it('returns false for scan when scan block is missing', () => {
    const config = { version: 1, triage: { enabled: true } };
    expect(shouldDispatch(config, 'scan')).toBe(false);
  });

  it('returns true for scan when scan.enabled is true', () => {
    const config = { version: 1, scan: { enabled: true } };
    expect(shouldDispatch(config, 'scan')).toBe(true);
  });
});

describe('parseConfig path_filters', () => {
  it('parses path_filters as array of strings from valid YAML, attaches to AptuConfig', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\npath_filters:\n  - "src/**"\n  - "!src/data/**"'
    );
    const config = parseConfig(raw);
    expect(config).not.toBeNull();
    expect(config?.path_filters).toEqual(['src/**', '!src/data/**']);
  });

  it('tolerates absence of path_filters (existing configs continue to parse)', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true'
    );
    const config = parseConfig(raw);
    expect(config).not.toBeNull();
    expect(config?.path_filters).toBeUndefined();
  });

  it('returns null when path_filters is present but is not an array', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\npath_filters: "src/**"'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('returns null when path_filters array contains non-string elements (numbers, objects)', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\npath_filters:\n  - 42\n  - src/**'
    );
    expect(parseConfig(raw)).toBeNull();
  });
});

describe('parseConfig scan', () => {
  it('parses scan block with only enabled', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nscan:\n  enabled: true'
    );
    const config = parseConfig(raw);
    expect(config).not.toBeNull();
    expect(config?.scan).toEqual({ enabled: true });
  });

  it('parses scan block with optional fail-on and path', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nscan:\n  enabled: true\n  fail-on: critical,high\n  path: src/'
    );
    const config = parseConfig(raw);
    expect(config).not.toBeNull();
    expect(config?.scan).toEqual({
      enabled: true,
      'fail-on': 'critical,high',
      path: 'src/',
    });
  });

  it('returns null when scan.enabled is a non-boolean string', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nscan:\n  enabled: "yes"'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('returns null when scan.enabled is missing from scan block', () => {
    const raw = btoa(
      'version: 1\ntriage:\n  enabled: true\nscan:\n  path: src/'
    );
    expect(parseConfig(raw)).toBeNull();
  });

  it('returns null when scan block is not an object', () => {
    const raw = btoa('version: 1\ntriage:\n  enabled: true\nscan: "yes"');
    expect(parseConfig(raw)).toBeNull();
  });
});

describe('shouldSkipByPathFilters', () => {
  it('returns false immediately when patterns array is empty', () => {
    expect(shouldSkipByPathFilters([], ['src/index.ts'])).toBe(false);
  });

  it('returns false (dispatch) when include patterns are present but at least one changed file does not match any include', () => {
    const patterns = ['src/**'];
    const filenames = ['src/index.ts', 'docs/readme.md'];
    expect(shouldSkipByPathFilters(patterns, filenames)).toBe(false);
  });

  it('returns true (skip) when all changed files match at least one include pattern and no exclude', () => {
    const patterns = ['src/**'];
    const filenames = ['src/index.ts', 'src/config.ts'];
    expect(shouldSkipByPathFilters(patterns, filenames)).toBe(true);
  });

  it('returns false (dispatch) when a file matches an include pattern but also matches an exclude pattern (exclude narrows include scope)', () => {
    const patterns = ['src/**', '!src/data/**'];
    const filenames = ['src/data/blog/post.md'];
    expect(shouldSkipByPathFilters(patterns, filenames)).toBe(false);
  });

  it('with only exclude patterns and no includes, returns true (skip) when every file matches an exclude', () => {
    const patterns = ['!docs/**'];
    const filenames = ['docs/readme.md', 'docs/guide.md'];
    expect(shouldSkipByPathFilters(patterns, filenames)).toBe(true);
  });

  it('with only exclude patterns and no includes, returns false (dispatch) when at least one file does not match any exclude', () => {
    const patterns = ['!docs/**'];
    const filenames = ['docs/readme.md', 'src/index.ts'];
    expect(shouldSkipByPathFilters(patterns, filenames)).toBe(false);
  });
});
