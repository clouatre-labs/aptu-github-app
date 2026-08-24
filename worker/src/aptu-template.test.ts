// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = resolve(__dirname, '..', '..');

function loadWorkflow(name: string) {
  return YAML.parse(
    readFileSync(resolve(root, '.github/workflows', name), 'utf-8')
  );
}

const review = loadWorkflow('aptu-review.yml');
const triage = loadWorkflow('aptu-triage.yml');
const scan = loadWorkflow('aptu-scan-security.yml');

describe('aptu dispatch handler templates', () => {
  it('has correct permissions and SHA-pinned refs', () => {
    expect(review).not.toHaveProperty('permissions');
    expect(triage).not.toHaveProperty('permissions');
    expect(scan).not.toHaveProperty('permissions');
    expect(review.jobs.review.permissions.contents).toBe('read');
    expect(review.jobs.review.permissions['pull-requests']).toBe('write');
    expect(triage.jobs.triage.permissions.contents).toBe('read');
    expect(triage.jobs.triage.permissions.issues).toBe('write');
    expect(scan.jobs.scan.permissions.contents).toBe('read');
    expect(scan.jobs.scan.permissions['security-events']).toBe('write');
    expect(scan.jobs.scan.permissions.statuses).toBe('write');
    expect(review.jobs.review.uses).toMatch(/@[0-9a-f]{40}/);
    expect(triage.jobs.triage.uses).toMatch(/@[0-9a-f]{40}/);
    expect(scan.jobs.scan.uses).toMatch(/@[0-9a-f]{40}/);
  });
});
