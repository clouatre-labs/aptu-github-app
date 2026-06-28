// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { createAppAuth } from '@octokit/auth-app';
import { isMatch } from 'picomatch';
import reposConfig from '../../config/repos.json';
import { fetchRepoConfig, shouldDispatch } from './config';

export interface Env {
  WEBHOOK_SECRET: string;
  APP_PRIVATE_KEY: string;
  APP_ID: string;
  TARGET_REPO: string;
  EXCLUDED_REPOS: string;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function isExcluded(repo: string, excludedRepos: string): boolean {
  if (!excludedRepos) return false;
  return excludedRepos
    .split(',')
    .map((r) => r.trim())
    .includes(repo);
}

export async function validateSignature(
  secret: string,
  payload: string,
  sigHeader: string
): Promise<boolean> {
  if (!sigHeader.startsWith('sha256=')) return false;
  const encoder = new TextEncoder();
  const encodedSecret = encoder.encode(secret);
  const encodedPayload = encoder.encode(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    encodedSecret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigHex = sigHeader.slice('sha256='.length);
  const sigBytes = hexToBytes(sigHex);
  return crypto.subtle.verify('HMAC', key, sigBytes, encodedPayload);
}

export async function getInstallationToken(
  env: Env,
  installationId: number
): Promise<string> {
  const auth = createAppAuth({
    appId: env.APP_ID,
    privateKey: env.APP_PRIVATE_KEY,
  });
  const result = await auth({ type: 'installation', installationId });
  return result.token;
}

export async function dispatchEvent(
  token: string,
  targetRepo: string,
  eventType: string,
  clientPayload: Record<string, unknown>
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${targetRepo}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'aptu-webhook/1.0',
      },
      body: JSON.stringify({
        event_type: eventType,
        client_payload: clientPayload,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(
      `repository_dispatch failed: ${response.status} ${response.statusText}`
    );
  }
}

export async function shouldSkipPrDispatch(
  repoFullName: string,
  prNumber: number,
  token: string
): Promise<boolean> {
  const repoConfig = reposConfig[repoFullName as keyof typeof reposConfig];
  if (!repoConfig) return false;

  const excludePatterns = repoConfig.exclude_paths;
  if (!excludePatterns || excludePatterns.length === 0) return false;

  try {
    const prFilesResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files`,
      {
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'aptu-webhook/1.0',
        },
      }
    );

    if (!prFilesResponse.ok) {
      return false;
    }

    interface GitHubFile {
      filename: string;
    }
    const files = (await prFilesResponse.json()) as GitHubFile[];
    if (!files || files.length === 0) return false;

    return files.every((file) =>
      excludePatterns.some((pattern) => isMatch(file.filename, pattern))
    );
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST')
      return new Response('Method Not Allowed', { status: 405 });

    const body = await request.text();
    const sigHeader = request.headers.get('X-Hub-Signature-256') ?? '';
    if (!sigHeader) return new Response('Unauthorized', { status: 401 });

    const valid = await validateSignature(env.WEBHOOK_SECRET, body, sigHeader);
    if (!valid) return new Response('Unauthorized', { status: 401 });

    const event = request.headers.get('X-GitHub-Event') ?? '';
    // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
    const payload = JSON.parse(body) as Record<string, any>;
    const action = (payload.action as string) ?? '';
    const installationId = (payload.installation as { id: number } | undefined)
      ?.id;

    if (event === 'issue_comment' && action === 'created')
      return new Response('OK', { status: 200 });
    if (event === 'pull_request_review_comment' && action === 'created')
      return new Response('OK', { status: 200 });

    if (event === 'issues' && action === 'opened') {
      if (!installationId) return new Response('Bad Request', { status: 400 });
      const repo = (payload.repository as { full_name: string }).full_name;
      if (isExcluded(repo, env.EXCLUDED_REPOS))
        return new Response('OK', { status: 200 });
      if (!repo.includes('/'))
        return new Response('Bad Request', { status: 400 });
      const token = await getInstallationToken(env, installationId);
      const issue = payload.issue as { number: number; title: string };
      const owner = repo.split('/')[0] ?? '';
      const repoName = repo.split('/')[1] ?? '';
      const config = await fetchRepoConfig(token, owner, repoName);
      if (!shouldDispatch(config, 'triage'))
        return new Response('OK', { status: 200 });
      await dispatchEvent(token, env.TARGET_REPO, 'aptu-triage', {
        installation_token: token,
        originating_repo: repo,
        issue_number: issue.number,
        issue_title: issue.title,
        instructions_file: null,
        skip_labeled: false,
      });
      return new Response(null, { status: 204 });
    }

    if (
      event === 'pull_request' &&
      (action === 'opened' || action === 'synchronize' || action === 'reopened')
    ) {
      if (!installationId) return new Response('Bad Request', { status: 400 });
      const repo = (payload.repository as { full_name: string }).full_name;
      if (!repo.includes('/'))
        return new Response('Bad Request', { status: 400 });
      if (isExcluded(repo, env.EXCLUDED_REPOS))
        return new Response('OK', { status: 200 });
      const token = await getInstallationToken(env, installationId);
      const pr = payload.pull_request as { number: number; title: string };

      const shouldSkip = await shouldSkipPrDispatch(repo, pr.number, token);
      if (shouldSkip) return new Response(null, { status: 204 });

      const owner = repo.split('/')[0] ?? '';
      const repoName = repo.split('/')[1] ?? '';
      const config = await fetchRepoConfig(token, owner, repoName);
      if (!shouldDispatch(config, 'review'))
        return new Response('OK', { status: 200 });

      await dispatchEvent(token, env.TARGET_REPO, 'aptu-review', {
        installation_token: token,
        originating_repo: repo,
        pull_number: pr.number,
        pull_title: pr.title,
        instructions_file: config?.review?.['instructions-file'] ?? null,
        skip_labeled: config?.review?.['skip-labeled'] ?? false,
      });
      return new Response(null, { status: 204 });
    }

    return new Response('Bad Request', { status: 400 });
  },
};
