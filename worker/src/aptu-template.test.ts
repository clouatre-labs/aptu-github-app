// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = resolve(__dirname, '..', '..');
const yml = '.github/workflows/aptu.yml';
const aptuYml = readFileSync(resolve(root, yml), 'utf-8');
const parsed = YAML.parse(aptuYml);
const { jobs } = parsed;
const blockRe = /```yaml\n# \.github\/workflows\/aptu\.yml\n([\s\S]*?)```/;

describe('aptu dispatch handler template', () => {
  it('has correct permissions, SHA-pinned refs, and README parity', () => {
    expect(parsed).not.toHaveProperty('permissions');
    expect(jobs.review.permissions.contents).toBe('read');
    expect(jobs.review.permissions['pull-requests']).toBe('write');
    expect(jobs.triage.permissions.contents).toBe('read');
    expect(jobs.triage.permissions.issues).toBe('write');
    expect(jobs.scan.permissions.contents).toBe('read');
    expect(jobs.scan.permissions['security-events']).toBe('write');
    expect(jobs.scan.permissions.statuses).toBe('write');
    expect(jobs.review.uses).toMatch(/@[0-9a-f]{40}/);
    expect(jobs.triage.uses).toMatch(/@[0-9a-f]{40}/);
    expect(jobs.scan.uses).toMatch(/@[0-9a-f]{40}/);
    const readme = readFileSync(resolve(root, 'README.md'), 'utf-8');
    const block = readme.match(blockRe)?.[1] ?? '';
    expect(block.trimEnd()).toEqual(aptuYml.trimEnd());
  });
});
