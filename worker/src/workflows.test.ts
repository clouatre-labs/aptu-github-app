// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Workflow Retention Configuration', () => {
  const rootDir = resolve(__dirname, '../../');

  it('scan-security workflow sets retention-days to 7 on the scan job that processes caller source code', () => {
    const filePath = resolve(rootDir, '.github/workflows/scan-security.yml');
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parse(content);
    expect(parsed.jobs.scan['retention-days']).toBe(7);
  });

  it('issue-triage workflow sets retention-days to 14 on the triage job', () => {
    const filePath = resolve(rootDir, '.github/workflows/issue-triage.yml');
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parse(content);
    expect(parsed.jobs.triage['retention-days']).toBe(14);
  });

  it('pr-review workflow sets retention-days to 14 on the review job', () => {
    const filePath = resolve(rootDir, '.github/workflows/pr-review.yml');
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parse(content);
    expect(parsed.jobs.review['retention-days']).toBe(14);
  });
});
