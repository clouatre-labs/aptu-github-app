// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { createAppAuth } from '@octokit/auth-app';

// Re-exported for Cloudflare Worker binding: wrangler requires Durable Object
// classes to be exported from the entry point (this file) to register them.
export { InstallationQuota } from './quota';
export { TelemetryRateLimit, TelemetryRollup } from './telemetry';

import { captureException, withSentry } from '@sentry/cloudflare';
import {
  type AptuConfig,
  fetchRepoConfig,
  REPO_CONFIG_FETCH_TIMEOUT_MS,
  shouldDispatch,
  shouldSkipByPathFilters,
} from './config';
import { handleTelemetryRollup } from './telemetry';

export interface Env {
  WEBHOOK_SECRET: string;
  APP_PRIVATE_KEY: string;
  APP_ID: string;
  APTU_BOT_ID: string;
  SENTRY_DSN: string;
  OPERATOR_ORG: string;
  QUOTA: DurableObjectNamespace;
  REPLAY_GUARD: DurableObjectNamespace;
  TELEMETRY: DurableObjectNamespace;
  TELEMETRY_RATE_LIMIT: DurableObjectNamespace;
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

// ---------------------------------------------------------------------------
// Scoped installation token helpers
// ---------------------------------------------------------------------------

/**
 * Base helper: obtains an installation token scoped to specific repositories
 * and permissions. Each call creates a fresh createAppAuth instance; the
 * underlying @octokit/auth-app caches JWTs internally.
 */
export async function getInstallationToken(
  env: Env,
  installationId: number,
  options: {
    repositoryNames: string[];
    permissions: Record<string, string>;
  }
): Promise<string> {
  const auth = createAppAuth({
    appId: env.APP_ID,
    privateKey: env.APP_PRIVATE_KEY,
  });
  const result = await auth({
    type: 'installation',
    installationId,
    repositoryNames: options.repositoryNames,
    permissions: options.permissions,
  });
  return result.token;
}

export const PERMS = {
  config: { contents: 'read', pull_requests: 'read' },
  triage: { contents: 'read', issues: 'write' },
  review: { contents: 'read', pull_requests: 'write' },
  scan: { contents: 'read', security_events: 'write', statuses: 'write' },
  dispatch: { contents: 'write' },
  provision: { contents: 'write', workflows: 'write' },
} as const;

const APTU_WORKFLOW_FILES = [
  'aptu-review.yml',
  'aptu-triage.yml',
  'aptu-scan-security.yml',
] as const;
const APTU_WORKFLOW_SOURCE_BASE_URL =
  'https://raw.githubusercontent.com/clouatre-labs/aptu-github-app/main/.github/workflows';

/**
 * Returns a scoped installation token for the given operation and permissions.
 *
 * NOTE: scan permissions require the GitHub App installation to have the
 * "Security events" permission enabled. If the installation lacks this
 * permission the token request will be rejected by GitHub. Verify the App
 * manifest and re-authorize installations before deploying.
 */
export async function getScopedToken(
  env: Env,
  installationId: number,
  repoFullName: string,
  permissions: Record<string, string>
): Promise<string> {
  // GitHub's installation token API expects short repository names (e.g.
  // "aptu-coder"), not full owner/repo strings.  Normalize here so every
  // caller can safely pass the webhook's repository.full_name.
  const shortRepoName = repoFullName.split('/')[1] ?? repoFullName;
  return getInstallationToken(env, installationId, {
    repositoryNames: [shortRepoName],
    permissions,
  });
}

export async function provisionWorkflowFiles(
  env: Env,
  repoFullName: string,
  installationId: number
): Promise<void> {
  let token: string;
  try {
    token = await getScopedToken(env, installationId, repoFullName, PERMS.provision);
  } catch (error) {
    captureException(error, { tags: { eventType: 'provision', repo: repoFullName } });
    console.error(`Failed to get provisioning token for ${repoFullName}:`, error);
    return;
  }
  for (const file of APTU_WORKFLOW_FILES) {
    try {
      const sourceResponse = await fetch(`${APTU_WORKFLOW_SOURCE_BASE_URL}/${file}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!sourceResponse.ok) throw new Error(`source fetch failed: ${sourceResponse.status}`);
      const content = await sourceResponse.text();
      const url = `https://api.github.com/repos/${repoFullName}/contents/.github/workflows/${file}`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aptu-webhook/1.0',
      };
      const existing = await fetch(url, { headers });
      if (existing.status === 200) {
        console.log(`Provisioning skipped-existing ${repoFullName}/${file}`);
        continue;
      }
      if (existing.status !== 404) throw new Error(`Contents GET failed: ${existing.status}`);
      const put = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'ci: add aptu dispatch handler workflows',
          content: btoa(content),
        }),
      });
      if (!put.ok) throw new Error(`Contents PUT failed: ${put.status}`);
      console.log(`Provisioning provisioned ${repoFullName}/${file}`);
    } catch (error) {
      captureException(error, { tags: { eventType: 'provision', repo: repoFullName, file } });
      console.error(`Provisioning failed for ${repoFullName}/${file}:`, error);
    }
  }
}

async function getTokenOr500(
  env: Env,
  installationId: number,
  repo: string,
  permissions: Record<string, string>,
  eventType: string
): Promise<string | Response> {
  try {
    return await getScopedToken(env, installationId, repo, permissions);
  } catch (error) {
    captureException(error, { tags: { eventType, repo } });
    console.error(`Failed to get token for ${repo}:`, error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PR path filter
// ---------------------------------------------------------------------------

export async function shouldSkipPrDispatch(
  repoFullName: string,
  prNumber: number,
  token: string,
  aptuConfig: AptuConfig | null = null
): Promise<boolean> {
  const pathFilters = aptuConfig?.review?.paths;
  if (!pathFilters || pathFilters.length === 0) return false;

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

    return shouldSkipByPathFilters(
      pathFilters,
      files.map((f) => f.filename)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/**
 * The operator's own org is exempt from quota enforcement -- see OPERATOR_ORG
 * in wrangler.toml. Quota's remaining purpose (after BYOK removed the shared
 * AI-key-cost rationale) is abuse protection for untrusted external
 * installations, not the operator's own repos.
 */
function isOperatorOrg(env: Env, owner: string): boolean {
  return owner === env.OPERATOR_ORG;
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
      body: JSON.stringify({ eventType, installationId, action: 'check' }),
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

/**
 * Records a quota event after a successful repository_dispatch.
 *
 * Calls InstallationQuota with action 'record' to append a timestamp.
 * Returns void; logs errors but does not block webhook processing.
 */
async function recordQuota(
  env: Env,
  installationId: number,
  eventType: string
): Promise<void> {
  const quotaId = env.QUOTA.idFromName(String(installationId));
  const stub = env.QUOTA.get(quotaId);
  try {
    const quotaResponse = await stub.fetch('https://quota/quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, installationId, action: 'record' }),
    });
    if (!quotaResponse.ok) {
      const text = await quotaResponse.text();
      console.error(
        `Quota record non-2xx for installation ${installationId}: ${text}`
      );
    }
  } catch (error) {
    console.error(
      `Quota record failed for installation ${installationId}:`,
      error
    );
  }
}

/** Skips quota enforcement for the operator's own org; see isOperatorOrg. */
async function maybeCheckQuota(
  env: Env,
  owner: string,
  installationId: number,
  eventType: string
): Promise<Response | null> {
  return isOperatorOrg(env, owner)
    ? null
    : await checkQuota(env, installationId, eventType);
}

/** Skips quota recording for the operator's own org; see isOperatorOrg. */
async function maybeRecordQuota(
  env: Env,
  owner: string,
  installationId: number,
  eventType: string
): Promise<void> {
  if (!isOperatorOrg(env, owner)) {
    await recordQuota(env, installationId, eventType);
  }
}

// ---------------------------------------------------------------------------
// Mention detection & access control
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mention command handler
// ---------------------------------------------------------------------------

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

  const isPrComment =
    event === 'pull_request_review_comment' ||
    (event === 'issue_comment' && Boolean(payload.issue?.pull_request));
  const eventType = isPrComment ? 'review' : 'triage';
  const dispatchType = isPrComment ? 'aptu-review' : 'aptu-triage';
  const number =
    event === 'pull_request_review_comment'
      ? payload.pull_request?.number
      : payload.issue?.number;

  const repo = (payload.repository as { full_name: string }).full_name;
  const [owner, name] = repo.split('/');

  let token: string;
  try {
    token = await getScopedToken(env, installationId, repo, PERMS.config);
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }

  // If config fetch fails, proceed to quota enforcement regardless.
  let config: AptuConfig | null = null;
  try {
    config = await fetchRepoConfig(token, owner ?? '', name ?? '');
  } catch (error) {
    captureException(error, { tags: { eventType: event, repo } });
    console.error(`Failed to fetch config for ${repo}:`, error);
    config = null;
  }

  const quotaResponse = await maybeCheckQuota(
    env,
    owner ?? '',
    installationId,
    eventType
  );
  if (quotaResponse) return quotaResponse;

  const hasAccess = await checkCollaboratorPermission(
    token,
    owner ?? '',
    name ?? '',
    comment.user?.login ?? ''
  );
  if (!hasAccess) return new Response('Forbidden', { status: 403 });

  try {
    await dispatchEvent(
      token,
      repo,
      dispatchType,
      isPrComment
        ? {
            originating_repo: repo,
            pull_number: number,
            instructions_file: config?.review?.['instructions-file'] ?? null,
            skip_labeled: config?.review?.['skip-labeled'] ?? false,
            telemetry_enabled: config?.telemetry?.enabled ?? false,
            ...(config?.ai
              ? {
                  ai_provider: config.ai.provider,
                  ai_model: config.ai.model,
                }
              : {}),
          }
        : {
            originating_repo: repo,
            issue_number: number,
            ...(config?.ai
              ? {
                  ai_provider: config.ai.provider,
                  ai_model: config.ai.model,
                }
              : {}),
          }
    );
  } catch {
    return new Response('Internal Server Error', { status: 500 });
  }

  await maybeRecordQuota(env, owner ?? '', installationId, eventType);

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// IP validation (fail-open)
// ---------------------------------------------------------------------------

/**
 * Matches an IPv4 address against a CIDR range.
 * Only IPv4 is supported; GitHub webhooks originate from IPv4 addresses.
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  const range = parts[0] ?? '';
  const bitsStr = parts[1];
  const bits = parseInt(bitsStr ?? '32', 10);
  if (bits === 0) return true;

  const ipOctets = ip.split('.').map(Number);
  const rangeOctets = range.split('.').map(Number);

  // Compare full octets
  const fullOctets = Math.floor(bits / 8);
  for (let i = 0; i < fullOctets; i++) {
    if (ipOctets[i] !== rangeOctets[i]) return false;
  }

  // Compare partial octet
  const remainingBits = bits % 8;
  if (remainingBits > 0) {
    const mask = 256 - (1 << (8 - remainingBits));
    const ipPartial = ipOctets[fullOctets] ?? 0;
    const rangePartial = rangeOctets[fullOctets] ?? 0;
    if ((ipPartial & mask) !== (rangePartial & mask)) return false;
  }

  return true;
}

let cachedHooks: { cidrs: string[]; fetchedAt: number } | null = null;

/** Resets the IP validation cache. Exported for testing only. */
export function __resetIpCache(): void {
  cachedHooks = null;
}

async function validateIp(request: Request): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) {
    console.warn(
      'CF-Connecting-IP header missing, skipping IP validation (fail-open)'
    );
    return null;
  }

  // Refresh cache every 3600s
  if (!cachedHooks || Date.now() - cachedHooks.fetchedAt > 3_600_000) {
    try {
      const metaResponse = await fetch('https://api.github.com/meta', {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'aptu-webhook/1.0',
        },
      });
      if (!metaResponse.ok) {
        console.warn(
          `GitHub /meta returned ${metaResponse.status}, skipping IP validation (fail-open)`
        );
        return null;
      }
      const meta = (await metaResponse.json()) as { hooks?: string[] };
      cachedHooks = {
        cidrs: meta.hooks ?? [],
        fetchedAt: Date.now(),
      };
    } catch (err) {
      console.warn(
        'Failed to fetch GitHub /meta, skipping IP validation (fail-open):',
        err
      );
      return null;
    }
  }

  const matched = cachedHooks.cidrs.some((cidr) => ipMatchesCidr(ip, cidr));
  if (!matched) {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
}

// ---------------------------------------------------------------------------
// ReplayGuard Durable Object
// ---------------------------------------------------------------------------

/**
 * Atomic replay deduplication for X-GitHub-Delivery IDs.
 *
 * On each check the DO atomically tests-and-sets the delivery ID. If the ID
 * was already seen a 409 Conflict is returned; otherwise the ID is recorded
 * and a 200 OK is returned. Stored IDs are cleaned up by an alarm that fires
 * 300 s after the last write.
 */
export class ReplayGuard {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { deliveryId } = (await request.json()) as { deliveryId: string };
    const exists = await this.state.storage.get(deliveryId);
    if (exists) {
      return new Response(null, { status: 409 });
    }
    await this.state.storage.put(deliveryId, true);
    await this.state.storage.setAlarm(Date.now() + 300_000);
    return new Response(null, { status: 200 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default withSentry((env: Env) => ({ dsn: env.SENTRY_DSN }), {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/telemetry/rollup') {
      return handleTelemetryRollup(request, env);
    }

    if (request.method !== 'POST')
      return new Response('Method Not Allowed', { status: 405 });

    const body = await request.text();
    const sigHeader = request.headers.get('X-Hub-Signature-256') ?? '';
    if (!sigHeader) return new Response('Unauthorized', { status: 401 });

    const valid = await validateSignature(env.WEBHOOK_SECRET, body, sigHeader);
    if (!valid) return new Response('Unauthorized', { status: 401 });

    // --- Replay dedup (after HMAC, before JSON parse) ---
    const deliveryId = request.headers.get('X-GitHub-Delivery');
    if (deliveryId && deliveryId.trim().length > 0) {
      const trimmedId = deliveryId.trim();
      // Validate delivery ID format (alphanumeric + hyphens only, matching UUID shape)
      if (!/^[0-9a-zA-Z-]+$/.test(trimmedId)) {
        console.warn(
          'X-GitHub-Delivery header contains malformed delivery ID, proceeding without replay dedup'
        );
      } else {
        const replayId = env.REPLAY_GUARD.idFromName('global');
        const replayStub = env.REPLAY_GUARD.get(replayId);
        const replayResponse = await replayStub.fetch('https://replay/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deliveryId: trimmedId }),
        });
        if (replayResponse.status === 409) {
          return new Response(null, { status: 202 });
        }
      }
    } else {
      console.warn(
        'X-GitHub-Delivery header missing or empty, proceeding without replay dedup'
      );
    }

    // --- IP validation (fail-open) ---
    const ipResponse = await validateIp(request);
    if (ipResponse) return ipResponse;

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

      const configToken = await getTokenOr500(
        env,
        installationId,
        repo,
        PERMS.config,
        'issues.opened'
      );
      if (configToken instanceof Response) return configToken;

      const issue = payload.issue as { number: number; title: string };
      const owner = repo.split('/')[0] ?? '';
      const repoName = repo.split('/')[1] ?? '';

      let config: AptuConfig | null = null;
      try {
        config = await fetchRepoConfig(configToken, owner, repoName);
      } catch (error) {
        captureException(error, { tags: { eventType: 'issues.opened', repo } });
        console.error(`Failed to fetch config for ${repo}:`, error);
        config = null;
      }

      const quotaResponse = await maybeCheckQuota(
        env,
        owner,
        installationId,
        'triage'
      );
      if (quotaResponse) return quotaResponse;

      if (!shouldDispatch(config, 'triage'))
        return new Response('OK', { status: 200 });

      const dispatchToken = await getTokenOr500(
        env,
        installationId,
        repo,
        PERMS.dispatch,
        'issues.opened'
      );
      if (dispatchToken instanceof Response) return dispatchToken;

      const triageToken = await getTokenOr500(
        env,
        installationId,
        repo,
        PERMS.triage,
        'issues.opened'
      );
      if (triageToken instanceof Response) return triageToken;

      try {
        await dispatchEvent(dispatchToken, repo, 'aptu-triage', {
          originating_repo: repo,
          issue_number: issue.number,
          installation_token: triageToken,
          ...(config?.ai
            ? {
                ai_provider: config.ai.provider,
                ai_model: config.ai.model,
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

      await maybeRecordQuota(env, owner, installationId, 'triage');

      return new Response(null, { status: 204 });
    }

    if (
      event === 'pull_request' &&
      (action === 'opened' ||
        action === 'synchronize' ||
        action === 'reopened' ||
        action === 'ready_for_review')
    ) {
      if (!installationId) return new Response('Bad Request', { status: 400 });
      const repo = (payload.repository as { full_name: string }).full_name;
      if (!repo.includes('/'))
        return new Response('Bad Request', { status: 400 });

      const configToken = await getTokenOr500(
        env,
        installationId,
        repo,
        PERMS.config,
        'pull_request'
      );
      if (configToken instanceof Response) return configToken;

      const pr = payload.pull_request as {
        number: number;
        title: string;
        head: { sha: string };
        draft?: boolean;
      };

      if (action === 'opened' && pr.draft) {
        return new Response(null, { status: 204 });
      }

      const owner = repo.split('/')[0] ?? '';
      const repoName = repo.split('/')[1] ?? '';

      let config: AptuConfig | null = null;
      try {
        config = await fetchRepoConfig(configToken, owner, repoName);
      } catch (error) {
        captureException(error, { tags: { eventType: 'pull_request', repo } });
        console.error(`Failed to fetch config for ${repo}:`, error);
        config = null;
      }

      const reviewWouldSkip = await shouldSkipPrDispatch(
        repo,
        pr.number,
        configToken,
        config
      );
      const shouldReview = shouldDispatch(config, 'review') && !reviewWouldSkip;
      const shouldScan = shouldDispatch(config, 'scan');

      if (!shouldReview && !shouldScan)
        return new Response(reviewWouldSkip ? null : 'OK', {
          status: reviewWouldSkip ? 204 : 200,
        });

      const dispatchToken = await getTokenOr500(
        env,
        installationId,
        repo,
        PERMS.dispatch,
        'pull_request'
      );
      if (dispatchToken instanceof Response) return dispatchToken;

      let reviewDispatched = false;
      let scanDispatched = false;
      let quotaBlocked = false;
      let maxRetryAfter = 0;

      if (shouldReview) {
        const reviewQuota = await maybeCheckQuota(
          env,
          owner,
          installationId,
          'review'
        );
        if (reviewQuota && reviewQuota.status !== 429) {
          return reviewQuota;
        }
        if (reviewQuota) {
          quotaBlocked = true;
          maxRetryAfter = Math.max(
            maxRetryAfter,
            Number(reviewQuota.headers.get('Retry-After') ?? 3600)
          );
        } else {
          const reviewToken = await getTokenOr500(
            env,
            installationId,
            repo,
            PERMS.review,
            'pull_request'
          );
          if (reviewToken instanceof Response) return reviewToken;

          try {
            await dispatchEvent(dispatchToken, repo, 'aptu-review', {
              originating_repo: repo,
              pull_number: pr.number,
              instructions_file: config?.review?.['instructions-file'] ?? null,
              skip_labeled: config?.review?.['skip-labeled'] ?? false,
              installation_token: reviewToken,
              telemetry_enabled: config?.telemetry?.enabled ?? false,
              ...(config?.ai
                ? {
                    ai_provider: config.ai.provider,
                    ai_model: config.ai.model,
                  }
                : {}),
            });
          } catch (error) {
            captureException(error, {
              tags: { eventType: 'pull_request', repo },
            });
            console.error(
              `Failed to dispatch aptu-review event for ${repo}:`,
              error
            );
            return new Response('Internal Server Error', { status: 500 });
          }

          await maybeRecordQuota(env, owner, installationId, 'review');
          reviewDispatched = true;
        }
      }

      if (shouldScan) {
        const scanQuota = await maybeCheckQuota(
          env,
          owner,
          installationId,
          'scan'
        );
        if (scanQuota && scanQuota.status !== 429) {
          return scanQuota;
        }
        if (scanQuota) {
          quotaBlocked = true;
          maxRetryAfter = Math.max(
            maxRetryAfter,
            Number(scanQuota.headers.get('Retry-After') ?? 3600)
          );
        } else {
          const scanToken = await getTokenOr500(
            env,
            installationId,
            repo,
            PERMS.scan,
            'pull_request'
          );
          if (scanToken instanceof Response) return scanToken;

          try {
            await dispatchEvent(dispatchToken, repo, 'aptu-scan-security', {
              originating_repo: repo,
              head_sha: pr.head.sha,
              pull_number: pr.number,
              scan_path: config?.scan?.path ?? '.',
              fail_on: config?.scan?.['fail-on'] ?? null,
              installation_token: scanToken,
            });
            await maybeRecordQuota(env, owner, installationId, 'scan');
            scanDispatched = true;
          } catch (error) {
            captureException(error, {
              tags: { eventType: 'pull_request', repo },
            });
            console.error(
              `Failed to dispatch aptu-scan-security event for ${repo}:`,
              error
            );
          }
        }
      }

      if (reviewDispatched || scanDispatched) {
        return new Response(null, { status: 204 });
      }

      if (quotaBlocked) {
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': String(maxRetryAfter) },
        });
      }

      return new Response(null, { status: 204 });
    }

    if (event === 'installation' || event === 'installation_repositories') {
      const repositories =
        event === 'installation'
          ? action === 'created'
            ? payload.repositories
            : null
          : action === 'added'
            ? payload.repositories_added
            : null;
      if (repositories === null) return new Response('OK', { status: 200 });
      if (!installationId || !Array.isArray(repositories))
        return new Response('Bad Request', { status: 400 });
      for (const repository of repositories) {
        if (!repository || typeof repository.full_name !== 'string' || !repository.full_name.includes('/'))
          return new Response('Bad Request', { status: 400 });
      }
      for (const repository of repositories) {
        await provisionWorkflowFiles(env, repository.full_name, installationId);
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('Bad Request', { status: 400 });
  },
});
