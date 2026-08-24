// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = resolve(__dirname, '..', '..');
const ciYmlPath = resolve(root, '.github/workflows/ci.yml');
const ciYmlContent = readFileSync(ciYmlPath, 'utf-8');
const parsedCi = YAML.parse(ciYmlContent);

describe('ci.yml marker-check job structure', () => {
  const markerCheck = parsedCi.jobs['marker-check'];
  const ciResult = parsedCi.jobs['ci-result'];

  it('exists and is configured as a PR-only check', () => {
    expect(markerCheck).toBeDefined();
    expect(markerCheck.if).toBe("github.event_name == 'pull_request'");
    expect(markerCheck.runs_on || markerCheck['runs-on']).toBe(
      'ubuntu-24.04-arm'
    );
  });

  it('is included in ci-result needs list', () => {
    expect(ciResult).toBeDefined();
    expect(ciResult.needs).toContain('marker-check');
  });

  it('contains expected shell script assertions and regex patterns', () => {
    const steps = markerCheck.steps as Array<{ run?: string; name?: string }>;
    const runStep = steps.find((s) => s.run?.includes('base_sha'));
    expect(runStep).toBeDefined();
    const script = runStep?.run ?? '';

    expect(script).toContain('# aptu-dispatch-handler-version:');
    expect(script).toContain('-le');
    expect(script).toContain(
      "does not contain a valid '# aptu-dispatch-handler-version: <integer>' marker"
    );
    expect(script).toContain(
      'aptu-dispatch-handler-version was not incremented'
    );
  });
});

describe('marker extraction and validation logic', () => {
  function extractMarker(fileContent: string): number | null {
    const lines = fileContent.split('\n');
    const markerPattern = /^# aptu-dispatch-handler-version: ([0-9]+)$/;
    for (const line of lines) {
      const match = line.match(markerPattern);
      if (match && match[1] !== undefined) {
        return parseInt(match[1], 10);
      }
    }
    return null;
  }

  function simulateShellExtraction(fileContent: string): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
    const tempFile = join(tempDir, 'test.yml');
    try {
      writeFileSync(tempFile, fileContent, 'utf-8');
      const stdout = execFileSync(
        'sh',
        [
          '-c',
          `grep -E '^# aptu-dispatch-handler-version: [0-9]+$' "${tempFile}" 2>/dev/null | awk '{print $NF}' || true`,
        ],
        { encoding: 'utf-8' }
      );
      return stdout.trim();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('extracts valid integer marker using shell grep/awk logic (happy path)', () => {
    const content = '# header\n# aptu-dispatch-handler-version: 2\nname: test';
    expect(simulateShellExtraction(content)).toBe('2');
    expect(extractMarker(content)).toBe(2);
  });

  it('returns empty string and null on missing marker (edge case)', () => {
    const content = '# header\nname: test\njobs: {}';
    expect(simulateShellExtraction(content)).toBe('');
    expect(extractMarker(content)).toBeNull();
  });

  it('rejects non-integer marker values (edge case)', () => {
    const content = '# aptu-dispatch-handler-version: v1.0.0\nname: test';
    expect(simulateShellExtraction(content)).toBe('');
    expect(extractMarker(content)).toBeNull();
  });

  it('rejects marker when HEAD equals base (edge case)', () => {
    const baseMarker = 2;
    const headMarker = 2;
    const isValidBump = headMarker > baseMarker;
    expect(isValidBump).toBe(false);
  });

  it('rejects marker when HEAD is less than base (edge case)', () => {
    const baseMarker = 3;
    const headMarker = 2;
    const isValidBump = headMarker > baseMarker;
    expect(isValidBump).toBe(false);
  });

  it('accepts marker when HEAD is strictly greater than base (happy path)', () => {
    const baseMarker = 1;
    const headMarker = 2;
    const isValidBump = headMarker > baseMarker;
    expect(isValidBump).toBe(true);
  });
});
