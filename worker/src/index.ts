// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { createAppAuth } from '@octokit/auth-app';
import {
  addBreadcrumb,
  captureException,
  withSentry,
} from '@sentry/cloudflare';
import { isMatch } from 'picomatch';
import reposConfig from '../../config/repos.json';
import {
  type AptuConfig,
  fetchRepoConfig,
  REPO_CONFIG_FETCH_TIMEOUT_MS,
  shouldDispatch,
} from './config';

export interface Env {
  WEBHOOK_SECRET: string;
  APP_PRIVATE_KEY: string;
  APP_ID: string;
  TARGET_REPO: string;
  ALLOWED_OWNERS: string;
  APTU_BOT_ID: string;
  SENTRY_DSN: string;
  QUOTA: DurableObjectNamespace;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
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

export function isOwnerAllowed(repoOwner: string, allowedOwners = ''): boolean {
  return allowedOwners
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((allowed) => allowed.toLowerCase() === repoOwner.toLowerCase());
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

export async function getDispatchToken(
  env: Env,
  installationId: number,
  targetRepoName: string
): Promise<string> {
  const auth = createAppAuth({
    appId: env.APP_ID,
    privateKey: env.APP_PRIVATE_KEY,
  });
  const result = await auth({
    type: 'installation',
    installationId,
    repositoryNames: [targetRepoName],
  });
  return result.token;
}

export async function shouldSkipPrDispatch(
  repoFullName: string,
  prNumber: number,
  token: string,
  aptuConfig: AptuConfig | null = null
): Promise<boolean> {
  const repoConfig = reposConfig[repoFullName as keyof typeof reposConfig];

  // Precedence: aptu.yml exclude_paths wins, fall back to repos.json
  let excludePatterns: string[] | undefined;

  if (aptuConfig?.exclude_paths) {
    excludePatterns = aptuConfig.exclude_paths;
  } else if (repoConfig) {
    excludePatterns = repoConfig.exclude_paths;
  }

  if (!excludePatterns || excludePatterns.length === 0) return false;

  try {
    const prFilesResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files`,
      {
        signal: AbortSignal.timeout(REPO_CONFIG_FETCH_TIMEOUT_MS),
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

async function checkQuota(
  env: Env,
  installationId: number,
  eventType: string
): Promise<Response | null> {
  const quotaId = env.QUOTA.idFromName(String(installationId));
  const stub = env.QUOTA.get(quotaId);
  let quotaResponse: Response;
  try {
    quotaResponse = await stub.fetch('https://quota/quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, installationId }),
    });
  } catch (error) {
    captureException(error, {
      tags: { eventType, installationId: String(installationId) },
    });
    console.error(
      `Quota check failed for installation ${installationId}:`,
      error
    );
    return new Response('Internal Server Error', { status: 500 });
  }
  if (!quotaResponse.ok) {
    const text = await quotaResponse.text();
    captureException(new Error(`Quota check non-2xx: ${text}`), {
      tags: { eventType, installationId: String(installationId) },
    });
    console.error(
      `Quota check error for installation ${installationId}: ${text}`
    );
    return new Response('Internal Server Error', { status: 500 });
  }
  const quota = (await quotaResponse.json()) as {
    count: number;
    exceeded: boolean;
    retryAfter: number | null;
  };
  if (quota.exceeded) {
    return new Response(null, {
      status: 429,
      headers: { 'Retry-After': String(quota.retryAfter ?? 3600) },
    });
  }
  return null;
}

async function enforceQuota(
  env: Env,
  installationId: number,
  eventType: string
): Promise<Response | null> {
  const quotaResponse = await checkQuota(env, installationId, eventType);
  if (quotaResponse) return quotaResponse;
  return null;
}

export function hasMentionCommand(body: string): boolean {
  return /@aptu(?![a-zA-Z0-9_-])/.test(
    body.replace(/```[\s\S]*?```|`[^`]*`/g, '')
  );
}

export async function checkCollaboratorPermission(
  token: string,
  owner: string,
  repo: string,
  username: string
): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/collaborators/${username}/permission`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aptu-webhook/1.0',
      },
    }
  );
  if (res.status === 404 || !res.ok) return false;
  const data = (await res.json()) as {
    user?: { permissions?: Record<string, boolean> };
    role_name?: string;
  };
  const perms = data.user?.permissions;
  return !!(
    perms?.admin ||
    perms?.pull ||
    ['admin', 'write'].includes(data.role_name ?? '')
  );
}

export async function handleMentionCommand(
  env: Env,
  event: string,
  // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped
  payload: Record<string, any>,
  installationId: number | undefined
): Promise<Response | null> {
  const comment = payload.comment as
    | { user?: { id: number; login: string }; id: number; body?: string }
    | undefined;
  if (!comment?.body || !hasMentionCommand(comment.body)) return null;
  if (!installationId) return new Response('Bad Request', { status: 400 });
  if (comment.user?.id === Number(env.APTU_BOT_ID)) return null;

  let token: string;
  try {
    token = await getInstallationToken(env, installationId);
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }

  const repo = (payload.repository as { full_name: string }).full_name;
  const [owner, name] = repo.split('/');
  const hasAccess = await checkCollaboratorPermission(
    token,
    owner ?? '',
    name ?? '',
    comment.user?.login ?? ''
  );
  if (!hasAccess) return new Response('Forbidden', { status: 403 });

  const eventType = event === 'issue_comment' ? 'triage' : 'review';
  const quotaResponse = await enforceQuota(env, installationId, eventType);
  if (quotaResponse) return quotaResponse;

  const dispatchType =
    event === 'issue_comment' ? 'aptu-triage' : 'aptu-review';
  let body = comment.body ?? '';
  const truncated = body.length > 4000;
  if (truncated) body = body.slice(0, 4000);

  try {
    await dispatchEvent(token, env.TARGET_REPO, dispatchType, {
      installation_token: token,
      originating_repo: repo,
      trigger_type: 'mention',
      comment_id: comment.id,
      commenter_login: comment.user?.login ?? '',
      comment_body: body,
      comment_body_truncated: truncated,
    });
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }

  return new Response(null, { status: 204 });
}

export default withSentry((env: Env) => ({ dsn: env.SENTRY_DSN }), {
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

    if (event === 'issue_comment' && action === 'created') {
      const r = await handleMentionCommand(env, event, payload, installationId);
      return r ?? new Response('OK', { status: 200 });
    }
    if (event === 'pull_request_review_comment' && action === 'created') {
      const r = await handleMentionCommand(env, event, payload, installationId);
      return r ?? new Response('OK', { status: 200 });
    }

    if (event === 'issues' && action === 'opened') {
      if (!installationId) return new Response('Bad Request', { status: 400 });
      const repo = (payload.repository as { full_name: string }).full_name;
      if (!repo.includes('/'))
        return new Response('Bad Request', { status: 400 });

      const repoOwner = (
        payload.repository as { owner?: { login: string } } | undefined
      )?.owner?.login;
      if (!repoOwner) return new Response('Forbidden', { status: 403 });

      const quotaResponse = await enforceQuota(env, installationId, 'triage');
      if (quotaResponse) return quotaResponse;

      let token: string;
      try {
        token = await getInstallationToken(env, installationId);
      } catch (error) {
        captureException(error, { tags: { eventType: 'issues.opened', repo } });
        console.error(`Failed to get installation token for ${repo}:`, error);
        return new Response('Internal Server Error', { status: 500 });
      }

      const issue = payload.issue as { number: number; title: string };
      const owner = repo.split('/')[0] ?? '';
      const repoName = repo.split('/')[1] ?? '';

      let config: AptuConfig | null = null;
      try {
        config = await fetchRepoConfig(token, owner, repoName);
      } catch (error) {
        captureException(error, { tags: { eventType: 'issues.opened', repo } });
        console.error(`Failed to fetch config for ${repo}:`, error);
        config = null;
      }

      if (!isOwnerAllowed(repoOwner, env.ALLOWED_OWNERS) && !config?.ai) {
        addBreadcrumb({
          message: `External installation rejected (missing ai block): ${repo}`,
          category: 'auth',
          level: 'warning',
          data: { eventType: 'issues.opened', repo },
        });
        console.error(
          `External installation rejected (missing ai block): ${repo}`
        );
        return new Response(
          'External installations require an ai block in .github/aptu.yml',
          { status: 403 }
        );
      }

      if (!shouldDispatch(config, 'triage'))
        return new Response('OK', { status: 200 });

      const targetRepoName = env.TARGET_REPO.split('/')[1] ?? '';
      let dispatchToken: string;
      try {
        dispatchToken = await getDispatchToken(
          env,
          installationId,
          targetRepoName
        );
      } catch (error) {
        captureException(error, { tags: { eventType: 'issues.opened', repo } });
        console.error(`Failed to get dispatch token for ${repo}:`, error);
        return new Response('Internal Server Error', { status: 500 });
      }

      try {
        await dispatchEvent(dispatchToken, env.TARGET_REPO, 'aptu-triage', {
          installation_token: token,
          originating_repo: repo,
          issue_number: issue.number,
          issue_title: issue.title,
          ...(config?.ai
            ? {
                ai_provider: config.ai.provider,
                ai_model: config.ai.model,
                ai_key_secret: config.ai['api-key-secret'],
              }
            : {}),
        });
      } catch (error) {
        captureException(error, { tags: { eventType: 'issues.opened', repo } });
        console.error(
          `Failed to dispatch aptu-triage event for ${repo}:`,
          error
        );
        return new Response('Internal Server Error', { status: 500 });
      }

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

      const repoOwner = (
        payload.repository as { owner?: { login: string } } | undefined
      )?.owner?.login;
      if (!repoOwner) return new Response('Forbidden', { status: 403 });

      const quotaResponse = await enforceQuota(env, installationId, 'review');
      if (quotaResponse) return quotaResponse;

      let token: string;
      try {
        token = await getInstallationToken(env, installationId);
      } catch (error) {
        captureException(error, { tags: { eventType: 'pull_request', repo } });
        console.error(`Failed to get installation token for ${repo}:`, error);
        return new Response('Internal Server Error', { status: 500 });
      }

      const pr = payload.pull_request as { number: number; title: string };

      const owner = repo.split('/')[0] ?? '';
      const repoName = repo.split('/')[1] ?? '';

      let config: AptuConfig | null = null;
      try {
        config = await fetchRepoConfig(token, owner, repoName);
      } catch (error) {
        captureException(error, { tags: { eventType: 'pull_request', repo } });
        console.error(`Failed to fetch config for ${repo}:`, error);
        config = null;
      }

      const shouldSkip = await shouldSkipPrDispatch(
        repo,
        pr.number,
        token,
        config
      );
      if (shouldSkip) return new Response(null, { status: 204 });

      if (!isOwnerAllowed(repoOwner, env.ALLOWED_OWNERS) && !config?.ai) {
        addBreadcrumb({
          message: `External installation rejected (missing ai block): ${repo}`,
          category: 'auth',
          level: 'warning',
          data: { eventType: 'pull_request', repo },
        });
        console.error(
          `External installation rejected (missing ai block): ${repo}`
        );
        return new Response(
          'External installations require an ai block in .github/aptu.yml',
          { status: 403 }
        );
      }

      if (!shouldDispatch(config, 'review'))
        return new Response('OK', { status: 200 });

      const targetRepoName = env.TARGET_REPO.split('/')[1] ?? '';
      let dispatchToken: string;
      try {
        dispatchToken = await getDispatchToken(
          env,
          installationId,
          targetRepoName
        );
      } catch (error) {
        captureException(error, { tags: { eventType: 'pull_request', repo } });
        console.error(`Failed to get dispatch token for ${repo}:`, error);
        return new Response('Internal Server Error', { status: 500 });
      }

      try {
        await dispatchEvent(dispatchToken, env.TARGET_REPO, 'aptu-review', {
          installation_token: token,
          originating_repo: repo,
          pull_number: pr.number,
          pull_title: pr.title,
          instructions_file: config?.review?.['instructions-file'] ?? null,
          skip_labeled: config?.review?.['skip-labeled'] ?? false,
          ...(config?.ai
            ? {
                ai_provider: config.ai.provider,
                ai_model: config.ai.model,
                ai_key_secret: config.ai['api-key-secret'],
              }
            : {}),
        });
      } catch (error) {
        captureException(error, { tags: { eventType: 'pull_request', repo } });
        console.error(
          `Failed to dispatch aptu-review event for ${repo}:`,
          error
        );
        return new Response('Internal Server Error', { status: 500 });
      }

      return new Response(null, { status: 204 });
    }

    return new Response('Bad Request', { status: 400 });
  },
});
