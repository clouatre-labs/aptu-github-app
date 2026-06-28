// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { parse } from 'yaml';

export interface AptuConfig {
  version: number;
  triage?: { enabled: boolean };
  review?: {
    enabled: boolean;
    'skip-labeled'?: boolean;
    'instructions-file'?: string;
  };
}

export async function fetchRepoConfig(
  token: string,
  owner: string,
  repo: string
): Promise<AptuConfig | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/aptu.yml`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
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
      config.triage = {
        enabled: Boolean((parsed.triage as Record<string, unknown>).enabled),
      };
    }

    if (parsed.review !== undefined) {
      if (typeof parsed.review !== 'object' || parsed.review === null) {
        return null;
      }
      const reviewObj = parsed.review as Record<string, unknown>;
      config.review = {
        enabled: Boolean(reviewObj.enabled),
      };
      if (typeof reviewObj['skip-labeled'] === 'boolean') {
        config.review['skip-labeled'] = reviewObj['skip-labeled'];
      }
      if (typeof reviewObj['instructions-file'] === 'string') {
        config.review['instructions-file'] = reviewObj['instructions-file'];
      }
    }

    return config;
  } catch {
    return null;
  }
}

export function shouldDispatch(
  config: AptuConfig | null,
  feature: 'triage' | 'review'
): boolean {
  if (config === null) {
    return false;
  }
  return config[feature]?.enabled ?? false;
}
