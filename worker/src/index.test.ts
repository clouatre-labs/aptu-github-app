// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(() =>
    vi.fn().mockResolvedValue({ token: 'mock-installation-token' })
  ),
}));

vi.mock('@sentry/cloudflare', () => ({
  withSentry: vi.fn((_optionsCallback, handler) => handler),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

const quotaControl = {
  body: JSON.stringify({ count: 0, exceeded: false, retryAfter: null }),
  status: 200,
};

const globalQuotaControl = {
  body: JSON.stringify({ count: 1, exceeded: false, retryAfter: null }),
  status: 200,
};

function makeMockQuotaNamespace(): DurableObjectNamespace {
  const stub = {
    fetch: vi.fn(() =>
      Promise.resolve(
        new Response(quotaControl.body, { status: quotaControl.status })
      )
    ),
  };
  return {
    idFromName: vi.fn(() => 'mock-id' as unknown as DurableObjectId),
    get: vi.fn(() => stub as unknown as DurableObjectStub),
  } as unknown as DurableObjectNamespace;
}

function makeGlobalQuotaMockNamespace(): DurableObjectNamespace {
  const stub = {
    fetch: vi.fn(() =>
      Promise.resolve(
        new Response(globalQuotaControl.body, {
          status: globalQuotaControl.status,
        })
      )
    ),
  };
  return {
    idFromName: vi.fn(() => 'mock-id' as unknown as DurableObjectId),
    get: vi.fn(() => stub as unknown as DurableObjectStub),
  } as unknown as DurableObjectNamespace;
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function b64(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64');
}

function makeConfigResponse(yaml: string, status = 200): Response {
  const encoded = b64(yaml);
  return new Response(
    JSON.stringify({ content: encoded, encoding: 'base64' }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

function mockEnabledFetch(): (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response> {
  return (url: string | URL | Request) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('/contents/.github/aptu.yml')) {
      return Promise.resolve(
        makeConfigResponse(
          'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\n  skip-labeled: true\n  instructions-file: .github/instructions/review.md'
        )
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };
}

function mockDisabledFetch(): (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response> {
  return (url: string | URL | Request) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('/contents/.github/aptu.yml')) {
      return Promise.resolve(
        makeConfigResponse(
          'version: 1\ntriage:\n  enabled: false\nreview:\n  enabled: false'
        )
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };
}

function mockAbsentConfigFetch(): (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response> {
  return (url: string | URL | Request) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('/contents/.github/aptu.yml')) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };
}

function mockEnabledWithAiFetch(): (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response> {
  return (url: string | URL | Request) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('/contents/.github/aptu.yml')) {
      return Promise.resolve(
        makeConfigResponse(
          'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o\n  api-key-secret: OPENAI_API_KEY'
        )
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };
}

const mockEnv = {
  WEBHOOK_SECRET: 'test-secret',
  APP_PRIVATE_KEY: 'fake-key',
  APP_ID: '4134521',
  TARGET_REPO: 'clouatre-labs/aptu-github-app',
  APTU_BOT_ID: '0',
  ALLOWED_OWNERS: 'clouatre-labs,clouatre,owner,myorg,unconfigured',
  SENTRY_DSN: '',
  QUOTA: makeMockQuotaNamespace(),
  GLOBAL_QUOTA: makeGlobalQuotaMockNamespace(),
  GLOBAL_QUOTA_LIMIT: '500',
};

async function callHandler(
  body: string,
  headers: Record<string, string>,
  env: typeof mockEnv = mockEnv
) {
  const { default: handler } = await import('./index.js');
  const request = new Request('https://aptu.dev/webhook', {
    method: 'POST',
    headers,
    body,
  });
  return handler.fetch(request, env);
}

describe('HMAC validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('returns 401 when X-Hub-Signature-256 header is missing', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(401);
  });

  it('returns 401 when signature does not match payload', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256':
        'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(401);
  });

  it('accepts request with valid HMAC-SHA256 signature', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).not.toBe(401);
  });
});

describe('isOwnerAllowed', () => {
  it('returns false when ALLOWED_OWNERS is empty string', async () => {
    const { isOwnerAllowed } = await import('./index.js');
    expect(isOwnerAllowed('clouatre-labs', '')).toBe(false);
  });

  it('matches owner case-insensitively (Clouatre-Labs == clouatre-labs)', async () => {
    const { isOwnerAllowed } = await import('./index.js');
    expect(isOwnerAllowed('Clouatre-Labs', 'clouatre-labs,clouatre')).toBe(
      true
    );
    expect(isOwnerAllowed('CLOUATRE', 'clouatre-labs,clouatre')).toBe(true);
  });

  it('handles trailing comma and whitespace in comma-separated list', async () => {
    const { isOwnerAllowed } = await import('./index.js');
    expect(isOwnerAllowed('clouatre', 'clouatre-labs, clouatre, ')).toBe(true);
  });
});

describe('ALLOWED_OWNERS gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('returns 403 for issues.opened when owner not in allowlist with no dispatch or token fetch', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'evil-org/repo', owner: { login: 'evil-org' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 403 for pull_request when owner not in allowlist', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 7, title: 'Test PR' },
      repository: { full_name: 'evil-org/repo', owner: { login: 'evil-org' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });

  it('returns 403 for mention-triggered issue_comment when owner not in allowlist', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: { body: '@aptu triage', user: { id: 2, login: 'someone' } },
      issue: {},
      repository: { full_name: 'evil-org/repo', owner: { login: 'evil-org' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issue_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });

  it('returns 403 when repository.owner.login and organization.login both absent', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });
});

describe('event routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('returns 204 and calls repository_dispatch for issues.opened', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it.each([
    ['opened', 'opened PR'],
    ['synchronize', 'sync PR'],
    ['reopened', 'reopened PR'],
  ])('returns 204 and calls repository_dispatch for pull_request.%s', async (action) => {
    const body = JSON.stringify({
      action,
      installation: { id: 99 },
      pull_request: { number: 7, title: 'Test PR' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it.each([
    [
      'issue_comment',
      JSON.stringify({
        action: 'created',
        comment: {},
        issue: {},
        repository: { owner: { login: 'clouatre-labs' } },
      }),
    ],
    [
      'pull_request_review_comment',
      JSON.stringify({
        action: 'created',
        comment: {},
        pull_request: {},
        repository: { owner: { login: 'clouatre-labs' } },
      }),
    ],
  ])('returns 200 without calling dispatch for %s.created', async (event, body) => {
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for unrecognized X-GitHub-Event value', async () => {
    const body = JSON.stringify({
      action: 'created',
      repository: { owner: { login: 'clouatre-labs' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'push',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(400);
  });
});

describe('token generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('createAppAuth receives APP_ID and APP_PRIVATE_KEY from env and requests installation token', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 55 },
      issue: { number: 3, title: 'Token test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(createAppAuth).toHaveBeenCalledWith({
      appId: mockEnv.APP_ID,
      privateKey: mockEnv.APP_PRIVATE_KEY,
    });
    const mockedCreateAppAuth = createAppAuth as ReturnType<typeof vi.fn>;
    const authFn = mockedCreateAppAuth.mock.results[0]?.value as ReturnType<
      typeof vi.fn
    >;
    expect(authFn).toHaveBeenCalledWith({
      type: 'installation',
      installationId: 55,
    });
  });
});

describe('repository_dispatch client_payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('dispatched payload includes installation_token, originating_repo, and issue_number for issues event', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 10 },
      issue: { number: 42, title: 'Payload test' },
      repository: { full_name: 'myorg/myrepo', owner: { login: 'myorg' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    const dispatchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/dispatches')
    ) as [string, RequestInit];
    const parsed = JSON.parse(dispatchCall[1].body as string);
    expect(parsed.client_payload).toEqual({
      installation_token: 'mock-installation-token',
      originating_repo: 'myorg/myrepo',
      issue_number: 42,
      issue_title: 'Payload test',
    });
  });

  it('dispatched payload includes installation_token, originating_repo, and pull_number for pull_request event', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 20 },
      pull_request: { number: 99, title: 'PR payload test' },
      repository: { full_name: 'myorg/myrepo', owner: { login: 'myorg' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    const dispatchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/dispatches')
    ) as [string, RequestInit];
    const parsed = JSON.parse(dispatchCall[1].body as string);
    expect(parsed.client_payload).toMatchObject({
      installation_token: 'mock-installation-token',
      originating_repo: 'myorg/myrepo',
      pull_number: 99,
    });
  });
});

describe('path filter config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('returns 204 without dispatch when all PR files match path_filters patterns (skip)', async () => {
    // Mock config fetch - aptu.yml with path_filters
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\npath_filters:\n  - "src/data/**"'
      )
    );
    // Mock PR files fetch - all files match path_filters
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'src/data/blog/post.md' },
          { filename: 'src/data/other/file.md' },
        ]),
        { status: 200 }
      )
    );

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 42, title: 'Update content' },
      repository: {
        full_name: 'clouatre-labs/clouatre.ca',
        owner: { login: 'clouatre-labs' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    expect(response.status).toBe(204);
    const prFilesCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/pulls/')
    );
    expect(prFilesCalls.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    expect(prFilesCalls[0]![0]).toContain('/pulls/42/files');
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 204 and dispatches when one file does not match path_filters patterns (partial match)', async () => {
    // Mock config fetch - includes path_filters in aptu.yml
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\npath_filters:\n  - "src/data/**"'
      )
    );
    // Mock PR files fetch - one file doesn't match
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'src/data/blog/post.md' },
          { filename: 'worker/src/index.ts' },
        ]),
        { status: 200 }
      )
    );
    // Mock dispatch event
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 43, title: 'Mixed changes' },
      repository: {
        full_name: 'clouatre-labs/clouatre.ca',
        owner: { login: 'clouatre-labs' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it('returns 204 and dispatches when aptuConfig has no path_filters field', async () => {
    // Mock config fetch - no path_filters
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true'
      )
    );
    // Mock dispatch event (no PR files fetch should be made)
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 44, title: 'Unconfigured repo' },
      repository: {
        full_name: 'unconfigured/repo',
        owner: { login: 'unconfigured' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    expect(response.status).toBe(204);
    const prFilesCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/pulls/')
    );
    expect(prFilesCalls.length).toBe(0);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it('returns 204 and dispatches on GitHub PR-files API failure when path_filters are configured (error-resilient contract)', async () => {
    // Mock config fetch - has path_filters
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\npath_filters:\n  - "docs/**"'
      )
    );
    // Mock PR files fetch failure
    fetchSpy.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );
    // Mock dispatch event
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 45, title: 'API failure test' },
      repository: {
        full_name: 'clouatre-labs/clouatre.ca',
        owner: { login: 'clouatre-labs' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });
});

describe('config-driven dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('returns 200 without dispatching when config file is absent (404)', async () => {
    fetchSpy.mockImplementation(mockAbsentConfigFetch());

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'T' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 200 without dispatching when config YAML is malformed', async () => {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse('not: valid: yaml: \n  - broken', 200)
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'T' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 200 without dispatching when triage.enabled is false on issues.opened', async () => {
    fetchSpy.mockImplementation(mockDisabledFetch());

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'T' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 200 without dispatching when review.enabled is false on pull_request.opened', async () => {
    fetchSpy.mockImplementation(mockDisabledFetch());

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 1, title: 'T' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('dispatches when triage.enabled is true on issues.opened', async () => {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: false'
          )
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 5, title: 'Triage enabled' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it('dispatches when review.enabled is true on pull_request.opened', async () => {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: false\nreview:\n  enabled: true'
          )
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 6, title: 'Review enabled' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it('dispatches for both issue and PR when triage and review are both enabled', async () => {
    fetchSpy.mockImplementation(mockEnabledFetch());

    // Issue
    let body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 7, title: 'Both issue' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    let sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const issueResponse = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(issueResponse.status).toBe(204);

    // PR
    body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 8, title: 'Both PR' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const prResponse = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(prResponse.status).toBe(204);

    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(2);
  });

  it('forwards config fields in client_payload for PR dispatch', async () => {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\n  skip-labeled: true\n  instructions-file: .github/instructions/review.md'
          )
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 9, title: 'Config fields' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    const dispatchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/dispatches')
    ) as [string, RequestInit];
    const parsed = JSON.parse(dispatchCall[1].body as string);
    expect(parsed.client_payload.instructions_file).toBe(
      '.github/instructions/review.md'
    );
    expect(parsed.client_payload.skip_labeled).toBe(true);
  });

  it('gracefully handles config fetch timeout/500 by not dispatching', async () => {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          new Response('Internal Server Error', { status: 500 })
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 10, title: 'Timeout test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });
});

describe('error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('returns 500 when getInstallationToken throws on issues.opened', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: mocking requires casting to any
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockRejectedValue(new Error('Invalid credentials'))
    );
    fetchSpy.mockImplementation(mockEnabledFetch());

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(500);
  });

  it('returns 500 when dispatchEvent throws on issues.opened', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: mocking requires casting to any
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockResolvedValue({ token: 'mock-token' })
    );

    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\n'
          )
        );
      }
      if (urlStr.includes('/dispatches')) {
        return Promise.resolve(new Response('Forbidden', { status: 403 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(500);
  });

  it('returns 500 when getInstallationToken throws on pull_request.opened', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: mocking requires casting to any
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockRejectedValue(new Error('Network error'))
    );
    fetchSpy.mockImplementation(mockEnabledFetch());

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 1, title: 'Test PR' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(500);
  });

  it('returns 500 when dispatchEvent throws on pull_request.opened', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: mocking requires casting to any
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockResolvedValue({ token: 'mock-token' })
    );

    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\n'
          )
        );
      }
      if (urlStr.includes('/dispatches')) {
        return Promise.resolve(
          new Response('Service Unavailable', { status: 503 })
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 1, title: 'Test PR' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(500);
  });
});

describe('AI configuration and external installations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('includes ai_provider, ai_model, ai_key_secret in client_payload for issues.opened when config.ai is present', async () => {
    fetchSpy.mockImplementation(mockEnabledWithAiFetch());
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 10 },
      issue: { number: 42, title: 'Test Issue' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    const dispatchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/dispatches')
    ) as [string, RequestInit];
    const parsed = JSON.parse(dispatchCall[1].body as string);
    expect(parsed.client_payload).toHaveProperty('ai_provider', 'openai');
    expect(parsed.client_payload).toHaveProperty('ai_model', 'gpt-4o');
    expect(parsed.client_payload).toHaveProperty(
      'ai_key_secret',
      'OPENAI_API_KEY'
    );
    expect(parsed.client_payload).toHaveProperty(
      'originating_repo',
      'owner/repo'
    );
    expect(parsed.client_payload).toHaveProperty('issue_number', 42);
    expect(parsed.client_payload).toHaveProperty('issue_title', 'Test Issue');
  });

  it('includes ai_provider, ai_model, ai_key_secret in client_payload for pull_request when config.ai is present', async () => {
    fetchSpy.mockImplementation(mockEnabledWithAiFetch());
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 10 },
      pull_request: { number: 15, title: 'Test PR' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    const dispatchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/dispatches')
    ) as [string, RequestInit];
    const parsed = JSON.parse(dispatchCall[1].body as string);
    expect(parsed.client_payload).toHaveProperty('ai_provider', 'openai');
    expect(parsed.client_payload).toHaveProperty('ai_model', 'gpt-4o');
    expect(parsed.client_payload).toHaveProperty(
      'ai_key_secret',
      'OPENAI_API_KEY'
    );
  });

  it('omits ai_provider, ai_model, ai_key_secret from client_payload when config.ai is absent', async () => {
    fetchSpy.mockImplementation(mockEnabledFetch());
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 10 },
      issue: { number: 42, title: 'Test Issue' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    const dispatchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/dispatches')
    ) as [string, RequestInit];
    const parsed = JSON.parse(dispatchCall[1].body as string);
    expect(parsed.client_payload).not.toHaveProperty('ai_provider');
    expect(parsed.client_payload).not.toHaveProperty('ai_model');
    expect(parsed.client_payload).not.toHaveProperty('ai_key_secret');
  });
});

describe('shouldSkipPrDispatch direct unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('returns true (skip) when all PR files match path_filters exclude patterns', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'docs/readme.md' },
          { filename: 'docs/guide.md' },
        ]),
        { status: 200 }
      )
    );
    const { shouldSkipPrDispatch } = await import('./index.js');
    const result = await shouldSkipPrDispatch(
      'clouatre-labs/clouatre.ca',
      42,
      'mock-token',
      { version: 1, path_filters: ['!docs/**'] }
    );
    expect(result).toBe(true);
  });

  it('returns false (dispatch) when aptuConfig has no path_filters, without triggering a PR files fetch', async () => {
    const { shouldSkipPrDispatch } = await import('./index.js');
    const result = await shouldSkipPrDispatch(
      'clouatre-labs/clouatre.ca',
      42,
      'mock-token',
      { version: 1 }
    );
    expect(result).toBe(false);
    const prFilesCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/pulls/')
    );
    expect(prFilesCalls.length).toBe(0);
  });
});

describe('Quota check integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
    quotaControl.body = JSON.stringify({
      count: 0,
      exceeded: false,
      retryAfter: null,
    });
    quotaControl.status = 200;
    globalQuotaControl.body = JSON.stringify({
      count: 1,
      exceeded: false,
      retryAfter: null,
    });
    globalQuotaControl.status = 200;
  });

  it.each([
    {
      eventHeader: 'issues',
      bodyField: 'issue',
      eventLabel: 'issues',
    },
    {
      eventHeader: 'pull_request',
      bodyField: 'pull_request',
      eventLabel: 'pull_request',
    },
  ])('returns 429 with Retry-After header when quota exceeded for $eventLabel event, without dispatching repository_dispatch', async ({
    eventHeader,
    bodyField,
  }) => {
    quotaControl.body = JSON.stringify({
      count: 50,
      exceeded: true,
      retryAfter: 3600,
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      [bodyField]: { number: 1, title: 'Test' },
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': eventHeader,
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');

    // No dispatch call should be made for a quota-exceeded request
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('proceeds to normal dispatch flow when quota not exceeded', async () => {
    quotaControl.body = JSON.stringify({
      count: 1,
      exceeded: false,
      retryAfter: null,
    });

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);

    // Dispatch should have been called
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it('returns 500 when quota check fails', async () => {
    quotaControl.status = 500;
    quotaControl.body = 'Internal Server Error';

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(500);
  });

  it('returns 429 with global Retry-After when org-wide quota exceeded but per-installation is not', async () => {
    globalQuotaControl.body = JSON.stringify({
      count: 500,
      exceeded: true,
      retryAfter: 3600,
    });
    globalQuotaControl.status = 200;

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');

    // No dispatch call should be made when global quota is exceeded
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 500 when global quota check fails (does not proceed to installation check)', async () => {
    globalQuotaControl.status = 500;
    globalQuotaControl.body = 'Internal Server Error';

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(500);
  });

  it('falls back to default limit 500 when GLOBAL_QUOTA_LIMIT is missing or non-numeric', async () => {
    const stub = {
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              count: 1,
              exceeded: false,
              retryAfter: null,
            }),
            { status: 200 }
          )
        )
      ),
    };
    const namespace = {
      idFromName: vi.fn(() => 'mock-id' as unknown as DurableObjectId),
      get: vi.fn(() => stub as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    const env = {
      ...mockEnv,
      GLOBAL_QUOTA_LIMIT: '',
      GLOBAL_QUOTA: namespace,
    };
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(env.WEBHOOK_SECRET, body);
    const response = await callHandler(
      body,
      {
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      env
    );
    expect(response.status).toBe(204);
    const fetchCalls = stub.fetch.mock.calls as unknown as Array<
      [Request, RequestInit]
    >;
    const sentBody = JSON.parse(fetchCalls[0]?.[1].body as string);
    expect(sentBody.limit).toBe(500);
  });
});

describe('mention commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('/collaborators/')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: { permissions: { pull: true } },
              role_name: 'read',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      if (urlStr.includes('/dispatches')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    quotaControl.body = JSON.stringify({
      count: 0,
      exceeded: false,
      retryAfter: null,
    });
    quotaControl.status = 200;
    globalQuotaControl.body = JSON.stringify({
      count: 1,
      exceeded: false,
      retryAfter: null,
    });
    globalQuotaControl.status = 200;
  });

  it('returns 200 OK without action when comment body does not contain @aptu', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: { user: { id: 100, login: 'user1' }, id: 1, body: 'hello' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issue_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
  });

  it('dispatches aptu-triage when issue comment contains @aptu and commenter has read+ access', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 42,
        body: 'please @aptu triage this',
      },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issue_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
    const dispatchBody = JSON.parse(
      (dispatchCalls[0]?.[1] as RequestInit).body as string
    );
    expect(dispatchBody.event_type).toBe('aptu-triage');
    expect(dispatchBody.client_payload.trigger_type).toBe('mention');
    expect(dispatchBody.client_payload.comment_id).toBe(42);
    expect(dispatchBody.client_payload.commenter_login).toBe('user1');
    expect(dispatchBody.client_payload.comment_body).toBe(
      'please @aptu triage this'
    );
    expect(dispatchBody.client_payload.comment_body_truncated).toBe(false);
  });

  it('dispatches aptu-review when PR review comment contains @aptu and commenter has read+ access', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 99,
        body: '@aptu review this',
      },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request_review_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
    const dispatchBody = JSON.parse(
      (dispatchCalls[0]?.[1] as RequestInit).body as string
    );
    expect(dispatchBody.event_type).toBe('aptu-review');
  });

  it('returns false when @aptu appears inside a markdown code fence', async () => {
    const { hasMentionCommand } = await import('./index.js');
    expect(hasMentionCommand('```\n@aptu do something\n```')).toBe(false);
  });

  it('ignores @aptu-other and @aptu_suffix but matches bare @aptu', async () => {
    const { hasMentionCommand } = await import('./index.js');
    expect(hasMentionCommand('@aptu-other')).toBe(false);
    expect(hasMentionCommand('@aptu_suffix')).toBe(false);
    expect(hasMentionCommand('@aptu')).toBe(true);
    expect(hasMentionCommand('hello @aptu please')).toBe(true);
  });

  it('returns false for HTTP 404 from collaborator endpoint', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('/collaborators/')) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (urlStr.includes('/dispatches')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 1,
        body: '@aptu triage',
      },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issue_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });

  it('returns true when user.permissions.pull is true', async () => {
    const { checkCollaboratorPermission } = await import('./index.js');
    const result = await checkCollaboratorPermission(
      'token',
      'owner',
      'repo',
      'user1'
    );
    expect(result).toBe(true);
  });

  it('returns true when user.permissions.admin is true', async () => {
    const { checkCollaboratorPermission } = await import('./index.js');
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('/collaborators/')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: { permissions: { admin: true } },
              role_name: 'admin',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const result = await checkCollaboratorPermission(
      'token',
      'owner',
      'repo',
      'admin-user'
    );
    expect(result).toBe(true);
  });

  it('enforces quota check before dispatching mention-triggered events', async () => {
    quotaControl.body = JSON.stringify({
      count: 50,
      exceeded: true,
      retryAfter: 3600,
    });
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 1,
        body: '@aptu triage',
      },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issue_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(429);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 429 when quota is exceeded for mention-triggered events', async () => {
    quotaControl.body = JSON.stringify({
      count: 50,
      exceeded: true,
      retryAfter: 7200,
    });
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 1,
        body: '@aptu review this',
      },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request_review_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('7200');
  });

  it('skips dispatch when commenter user ID matches APTU_BOT_ID (self-mention guard)', async () => {
    const botEnv = { ...mockEnv, APTU_BOT_ID: '999' };
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: {
        user: { id: 999, login: 'aptu[bot]' },
        id: 1,
        body: '@aptu triage',
      },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(
      body,
      {
        'X-GitHub-Event': 'issue_comment',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      botEnv
    );
    expect(response.status).toBe(200);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('includes trigger_type=mention and comment context fields in client_payload', async () => {
    const longBody = 'x'.repeat(5000);
    const commentBody = `@aptu ${longBody}`;
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 77,
        body: commentBody,
      },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issue_comment',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
    const dispatchBody = JSON.parse(
      (dispatchCalls[0]?.[1] as RequestInit).body as string
    );
    expect(dispatchBody.client_payload.trigger_type).toBe('mention');
    expect(dispatchBody.client_payload.comment_id).toBe(77);
    expect(dispatchBody.client_payload.commenter_login).toBe('user1');
    expect(dispatchBody.client_payload.comment_body.length).toBe(4000);
    expect(dispatchBody.client_payload.comment_body_truncated).toBe(true);
  });
});

describe('Sentry integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('calls captureException with installationId tag when Durable Object fetch throws', async () => {
    const { captureException: sentryCapture } = await import(
      '@sentry/cloudflare'
    );
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: mocking requires casting to any
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockRejectedValue(new Error('DO error'))
    );

    // Mock the QUOTA stub to throw
    const quotaStub = {
      fetch: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };
    const quotaNamespace = {
      idFromName: vi.fn(() => 'mock-id' as unknown as DurableObjectId),
      get: vi.fn(() => quotaStub as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const sentryEnv = { ...mockEnv, QUOTA: quotaNamespace };
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 42 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(
      body,
      {
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      sentryEnv
    );
    expect(response.status).toBe(500);
    expect(sentryCapture).toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: check sentry call args
    const callArg = (sentryCapture as any).mock.calls[0][1];
    expect(callArg?.tags?.installationId).toBe('42');
  });

  it('calls captureException with response text context when Durable Object returns non-2xx', async () => {
    const { captureException: sentryCapture } = await import(
      '@sentry/cloudflare'
    );
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: mocking requires casting to any
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockRejectedValue(new Error('DO non-2xx'))
    );

    const quotaStub = {
      fetch: vi.fn(() =>
        Promise.resolve(new Response('Rate limited', { status: 429 }))
      ),
    };
    const quotaNamespace = {
      idFromName: vi.fn(() => 'mock-id' as unknown as DurableObjectId),
      get: vi.fn(() => quotaStub as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;

    const sentryEnv = { ...mockEnv, QUOTA: quotaNamespace };
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(
      body,
      {
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      sentryEnv
    );
    expect(response.status).toBe(500);
    expect(sentryCapture).toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: check sentry call args
    const callArg = (sentryCapture as any).mock.calls[0][1];
    expect(callArg?.tags?.installationId).toBe('1');
  });

  it('loads withSentry-wrapped handler without crashing', async () => {
    // Verify the module loads without uncaught errors from the withSentry wrapper
    const { default: handler } = await import('./index.js');
    expect(handler).toBeDefined();
    expect(typeof handler.fetch).toBe('function');
  });
});

describe('scan dispatch', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: restoring the mocked auth factory
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockResolvedValue({ token: 'mock-installation-token' })
    );
  });

  function mockConfig(yaml: string) {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(makeConfigResponse(yaml));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
  }

  it('dispatches aptu-scan-security alongside aptu-review when scan.enabled is true', async () => {
    mockConfig(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nscan:\n  enabled: true\n  fail-on: critical,high\n  path: src/'
    );

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 10, title: 'Scan test', head: { sha: 'abc123' } },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(2);
    const scanCall = dispatchCalls[1] as [string, RequestInit];
    const parsed = JSON.parse(scanCall[1].body as string);
    expect(parsed.event_type).toBe('aptu-scan-security');
    expect(parsed.client_payload).toMatchObject({
      installation_token: 'mock-installation-token',
      originating_repo: 'owner/repo',
      head_sha: 'abc123',
      pull_number: 10,
      scan_path: '.',
      fail_on: 'critical,high',
    });
  });

  it('does not dispatch aptu-scan-security when scan.enabled is false', async () => {
    mockConfig(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nscan:\n  enabled: false'
    );

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 11, title: 'No scan', head: { sha: 'def456' } },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
    const parsed = JSON.parse(
      (dispatchCalls[0] as [string, RequestInit])[1].body as string
    );
    expect(parsed.event_type).toBe('aptu-review');
  });

  it('dispatches only aptu-scan-security when review.enabled is false but scan.enabled is true', async () => {
    mockConfig(
      'version: 1\ntriage:\n  enabled: false\nreview:\n  enabled: false\nscan:\n  enabled: true'
    );

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 12, title: 'Scan only', head: { sha: 'ghi789' } },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    expect(response.status).toBe(204);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
    const parsed = JSON.parse(
      (dispatchCalls[0] as [string, RequestInit])[1].body as string
    );
    expect(parsed.event_type).toBe('aptu-scan-security');
  });
});
