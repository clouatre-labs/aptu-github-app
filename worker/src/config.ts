// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { isMatch } from 'picomatch';
import { parse } from 'yaml';

export const REPO_CONFIG_FETCH_TIMEOUT_MS = 5000;

export interface AiConfig {
  provider: string;
  model: string;
  'api-key-secret': string;
}

export interface ScanConfig {
  enabled: boolean;
  'fail-on'?: string;
}

export interface AptuConfig {
  version: number;
  triage?: { enabled: boolean };
  review?: {
    enabled: boolean;
    'skip-labeled'?: boolean;
    'instructions-file'?: string;
  };
  scan?: ScanConfig;
  ai?: AiConfig;
  path_filters?: string[];
}

export const AI_KEY_SECRET_PATTERN = /^[A-Z0-9_]+$/;

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
        aiObj.model === '' ||
        typeof aiObj['api-key-secret'] !== 'string' ||
        !AI_KEY_SECRET_PATTERN.test(aiObj['api-key-secret'])
      ) {
        return null;
      }
      config.ai = {
        provider: aiObj.provider,
        model: aiObj.model,
        'api-key-secret': aiObj['api-key-secret'],
      };
    }

    if (parsed.path_filters !== undefined) {
      if (!Array.isArray(parsed.path_filters)) {
        return null;
      }
      const paths = parsed.path_filters as unknown[];
      if (!paths.every((p): p is string => typeof p === 'string')) {
        return null;
      }
      config.path_filters = paths as string[];
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

  // A file "passes" (is considered covered by the filter) when:
  //   With includes: file matches at least one include AND matches no exclude
  //   Without includes: file matches at least one exclude
  // Skip (return true) when ALL files pass the filter.
  // Dispatch (return false) when at least one file does NOT pass.
  for (const filename of filenames) {
    if (includes.length > 0) {
      // Include-only or mixed mode: file must match an include and no exclude
      if (!includes.some((p) => isMatch(filename, p))) {
        return false; // file not covered by any include -> dispatch
      }
      if (excludes.some((p) => isMatch(filename, p))) {
        return false; // file excluded -> dispatch
      }
    } else {
      // Exclude-only mode: file must match an exclude to be covered
      if (!excludes.some((p) => isMatch(filename, p))) {
        return false; // file not covered by any exclude -> dispatch
      }
    }
  }

  return true;
}
