// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { isMatch } from 'picomatch';
import { parse } from 'yaml';

export const REPO_CONFIG_FETCH_TIMEOUT_MS = 5000;

export interface AiConfig {
  provider: string;
  model: string;
}

export interface ScanConfig {
  enabled: boolean;
  'fail-on'?: string;
  path?: string;
}

export interface AptuConfig {
  version: number;
  triage?: { enabled: boolean };
  review?: {
    enabled: boolean;
    'skip-labeled'?: boolean;
    'instructions-file'?: string;
    paths?: string[];
  };
  scan?: ScanConfig;
  ai?: AiConfig;
}

export async function fetchRepoConfig(
  token: string,
  owner: string,
  repo: string
): Promise<AptuConfig | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/aptu.yml`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REPO_CONFIG_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aptu-webhook/1.0',
    },
  });

  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as { content: string };
  return parseConfig(json.content);
}

export function parseConfig(raw: string): AptuConfig | null {
  try {
    const decoded = atob(raw);
    const parsed = parse(decoded) as Record<string, unknown>;

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.version !== 'number'
    ) {
      return null;
    }

    const config: AptuConfig = { version: parsed.version };

    if (config.version !== 1) {
      return null;
    }

    if (parsed.triage !== undefined) {
      if (typeof parsed.triage !== 'object' || parsed.triage === null) {
        return null;
      }
      const triageObj = parsed.triage as Record<string, unknown>;
      if (typeof triageObj.enabled !== 'boolean') {
        return null;
      }
      config.triage = {
        enabled: triageObj.enabled,
      };
    }

    if (parsed.review !== undefined) {
      if (typeof parsed.review !== 'object' || parsed.review === null) {
        return null;
      }
      const reviewObj = parsed.review as Record<string, unknown>;
      if (typeof reviewObj.enabled !== 'boolean') {
        return null;
      }
      config.review = {
        enabled: reviewObj.enabled,
      };
      if (typeof reviewObj['skip-labeled'] === 'boolean') {
        config.review['skip-labeled'] = reviewObj['skip-labeled'];
      }
      if (typeof reviewObj['instructions-file'] === 'string') {
        config.review['instructions-file'] = reviewObj['instructions-file'];
      }
      if (reviewObj.paths !== undefined) {
        if (!Array.isArray(reviewObj.paths)) {
          return null;
        }
        const paths = reviewObj.paths as unknown[];
        if (!paths.every((p): p is string => typeof p === 'string')) {
          return null;
        }
        config.review.paths = paths as string[];
      }
    }

    if (parsed.scan !== undefined) {
      if (typeof parsed.scan !== 'object' || parsed.scan === null) {
        return null;
      }
      const scanObj = parsed.scan as Record<string, unknown>;
      if (typeof scanObj.enabled !== 'boolean') {
        return null;
      }
      config.scan = { enabled: scanObj.enabled };
      if (typeof scanObj['fail-on'] === 'string') {
        config.scan['fail-on'] = scanObj['fail-on'];
      }
      if (typeof scanObj.path === 'string') {
        config.scan.path = scanObj.path;
      }
    }

    if (parsed.ai !== undefined) {
      if (typeof parsed.ai !== 'object' || parsed.ai === null) {
        return null;
      }
      const aiObj = parsed.ai as Record<string, unknown>;
      if (
        typeof aiObj.provider !== 'string' ||
        aiObj.provider === '' ||
        typeof aiObj.model !== 'string' ||
        aiObj.model === ''
      ) {
        return null;
      }
      config.ai = {
        provider: aiObj.provider,
        model: aiObj.model,
      };
    }

    return config;
  } catch {
    return null;
  }
}

export function shouldDispatch(
  config: AptuConfig | null,
  feature: 'triage' | 'review' | 'scan'
): boolean {
  if (config === null) {
    return false;
  }
  return config[feature]?.enabled ?? false;
}

export function shouldSkipByPathFilters(
  patterns: string[],
  filenames: string[]
): boolean {
  if (patterns.length === 0) return false;

  const includes: string[] = [];
  const excludes: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }

  // A file "qualifies" when it matches at least one include and matches no exclude.
  // Without includes, a file qualifies when it matches no exclude.
  // Skip (return true) when NO files qualify.
  // Dispatch (return false) when at least one file qualifies.
  for (const filename of filenames) {
    if (includes.length > 0) {
      // Include-only or mixed mode: file qualifies if it matches an include and no exclude
      if (
        includes.some((p) => isMatch(filename, p)) &&
        !excludes.some((p) => isMatch(filename, p))
      ) {
        return false; // at least one file qualifies -> dispatch
      }
    } else {
      // Exclude-only mode: file qualifies when it matches no exclude
      if (!excludes.some((p) => isMatch(filename, p))) {
        return false; // file matches no exclude -> qualifies -> dispatch
      }
    }
  }

  return true;
}
