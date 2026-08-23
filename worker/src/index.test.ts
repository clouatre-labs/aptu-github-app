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

function makeReplayGuardMockNamespace(): DurableObjectNamespace {
  const stored = new Set<string>();
  const stub = {
    fetch: vi.fn((_input: string, init?: RequestInit) => {
      const { deliveryId } = JSON.parse((init?.body as string) ?? '{}') as {
        deliveryId: string;
      };
      if (stored.has(deliveryId)) {
        return Promise.resolve(new Response(null, { status: 409 }));
      }
      stored.add(deliveryId);
      return Promise.resolve(new Response(null, { status: 200 }));
    }),
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
          'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o'
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
  APTU_BOT_ID: '0',
  SENTRY_DSN: '',
  QUOTA: makeMockQuotaNamespace(),
  REPLAY_GUARD: makeReplayGuardMockNamespace(),
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

describe('owner processing without allowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('processes webhooks from any owner without checking allowlist', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'any-org/any-repo', owner: { login: 'any-org' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
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

  it('createAppAuth receives APP_ID and APP_PRIVATE_KEY from env and requests scoped installation token', async () => {
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
    expect(authFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'installation',
        installationId: 55,
        repositoryNames: ['repo'],
        permissions: { contents: 'read', pull_requests: 'read' },
      })
    );
  });
});

describe('repository_dispatch client_payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('dispatched payload includes originating_repo and issue_number for issues event', async () => {
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
      originating_repo: 'myorg/myrepo',
      issue_number: 42,
    });
    expect(parsed.client_payload).not.toHaveProperty('installation_id');
    expect(parsed.client_payload).not.toHaveProperty('originating_owner');
    expect(parsed.client_payload).not.toHaveProperty('originating_repo_name');
    expect(parsed.client_payload).not.toHaveProperty('issue_title');
    expect(parsed.client_payload).not.toHaveProperty('installation_token');
    expect(parsed.client_payload).not.toHaveProperty('ai_key_secret');
  });

  it('dispatched payload includes originating_repo, pull_number, instructions_file, skip_labeled for pull_request event', async () => {
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
      originating_repo: 'myorg/myrepo',
      pull_number: 99,
      instructions_file: '.github/instructions/review.md',
      skip_labeled: true,
    });
    expect(parsed.client_payload).not.toHaveProperty('installation_id');
    expect(parsed.client_payload).not.toHaveProperty('originating_owner');
    expect(parsed.client_payload).not.toHaveProperty('originating_repo_name');
    expect(parsed.client_payload).not.toHaveProperty('pull_title');
    expect(parsed.client_payload).not.toHaveProperty('installation_token');
    expect(parsed.client_payload).not.toHaveProperty('ai_key_secret');
  });

  it('requests dispatch token with short repository name for caller repository', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 20 },
      pull_request: { number: 99, title: 'Token scope test' },
      repository: { full_name: 'myorg/myrepo', owner: { login: 'myorg' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    const mockedCreateAppAuth = createAppAuth as ReturnType<typeof vi.fn>;
    // createAppAuth is called once per token request; each call returns a
    // fresh inner vi.fn.  Iterate all results to find the dispatch token call
    // (the one with contents:write permission).
    const allAuthCalls = mockedCreateAppAuth.mock.results.flatMap((r) =>
      r.type === 'return' ? r.value.mock.calls : []
    ) as unknown[][];
    const dispatchTokenCall = allAuthCalls.find((call) => {
      const opts = call[0] as Record<string, unknown> | undefined;
      const perms = opts?.permissions as Record<string, unknown> | undefined;
      return perms?.contents === 'write';
    });
    expect(dispatchTokenCall).toBeDefined();
    expect(dispatchTokenCall?.[0]).toEqual(
      expect.objectContaining({
        type: 'installation',
        installationId: 20,
        repositoryNames: ['myrepo'],
        permissions: { contents: 'write' },
      })
    );
  });
});

describe('path filter config', () => {
  it('dispatches review when ready_for_review action and files match paths', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeConfigResponse(
          'version: 1\nreview:\n  enabled: true\n  paths:\n    - "src/**"'
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ filename: 'src/index.ts' }]), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const body = JSON.stringify({
      action: 'ready_for_review',
      installation: { id: 1 },
      pull_request: { number: 46, title: 'Ready', head: { sha: 'abc' } },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sign(mockEnv.WEBHOOK_SECRET, body),
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    expect(
      fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes('/dispatches')
      )
    ).toHaveLength(1);
  });

  it('returns 204 without dispatch when opened action has a draft PR', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 47, title: 'Draft', draft: true },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sign(mockEnv.WEBHOOK_SECRET, body),
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    expect(
      fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes('/dispatches')
      )
    ).toHaveLength(0);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('dispatches when at least one PR file matches review.paths patterns', async () => {
    // Mock config fetch - aptu.yml with review.paths
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\n  paths:\n    - "src/data/**"'
      )
    );
    // Mock PR files fetch - all files match review.paths
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
    expect(dispatchCalls.length).toBe(1);
  });

  it('returns 204 without dispatch when no PR file matches review.paths patterns', async () => {
    // Mock config fetch - includes review.paths in aptu.yml
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\n  paths:\n    - "src/data/**"'
      )
    );
    // Mock PR files fetch - no files match review.paths
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'worker/src/index.ts' },
          { filename: 'docs/readme.md' },
        ]),
        { status: 200 }
      )
    );

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
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 204 and dispatches when aptuConfig has no review.paths field', async () => {
    // Mock config fetch - no review.paths
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

  it('returns 204 and dispatches on GitHub PR-files API failure when review.paths are configured (error-resilient contract)', async () => {
    // Mock config fetch - has review.paths
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\n  paths:\n    - "docs/**"'
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

  it('includes ai_provider and ai_model but omits ai_key_secret in client_payload for issues.opened when config.ai is present', async () => {
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
    expect(parsed.client_payload).not.toHaveProperty('ai_key_secret');
    expect(parsed.client_payload).not.toHaveProperty('installation_token');
    expect(parsed.client_payload).toHaveProperty(
      'originating_repo',
      'owner/repo'
    );
    expect(parsed.client_payload).toHaveProperty('issue_number', 42);
    expect(parsed.client_payload).not.toHaveProperty('issue_title');
    expect(parsed.client_payload).not.toHaveProperty('installation_id');
    expect(parsed.client_payload).not.toHaveProperty('originating_owner');
    expect(parsed.client_payload).not.toHaveProperty('originating_repo_name');
  });

  it('includes ai_provider and ai_model but omits ai_key_secret in client_payload for pull_request when config.ai is present', async () => {
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
    expect(parsed.client_payload).not.toHaveProperty('ai_key_secret');
    expect(parsed.client_payload).not.toHaveProperty('installation_token');
    expect(parsed.client_payload).not.toHaveProperty('installation_id');
    expect(parsed.client_payload).not.toHaveProperty('originating_owner');
    expect(parsed.client_payload).not.toHaveProperty('originating_repo_name');
    expect(parsed.client_payload).not.toHaveProperty('pull_title');
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
    expect(parsed.client_payload).not.toHaveProperty('installation_token');
  });
});

describe('shouldSkipPrDispatch direct unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('returns true (skip) when all PR files match review.paths exclude patterns', async () => {
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
      { version: 1, review: { enabled: true, paths: ['!docs/**'] } }
    );
    expect(result).toBe(true);
  });

  it('returns false (dispatch) when aptuConfig has no review.paths, without triggering a PR files fetch', async () => {
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
});

describe('quota enforcement with AI config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledWithAiFetch());
    quotaControl.body = JSON.stringify({
      count: 50,
      exceeded: true,
      retryAfter: 3600,
    });
    quotaControl.status = 200;
  });

  it('returns 429 for issues.opened when config.ai is present and quota is exceeded', async () => {
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
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('returns 429 for pull_request when config.ai is present and quota is exceeded', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 1, title: 'Test PR' },
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(429);
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(0);
  });
});

describe('quota record after dispatch', () => {
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
  });

  it('records quota timestamp after successful dispatch on issues.opened', async () => {
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
    await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    // Verify QUOTA namespace received a 'record' action call
    const quotaStub = mockEnv.QUOTA.get(
      'mock-id' as unknown as DurableObjectId
    );
    const quotaFetchCalls = (
      quotaStub as unknown as { fetch: ReturnType<typeof vi.fn> }
    ).fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const recordCalls = quotaFetchCalls.filter((call) => {
      const parsed = JSON.parse(call[1].body as string) as {
        action?: string;
      };
      return parsed.action === 'record';
    });
    expect(recordCalls.length).toBe(1);
  });

  it('does not record quota when dispatch fails on issues.opened', async () => {
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
      repository: {
        full_name: 'owner/repo',
        owner: { login: 'owner' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    // Verify QUOTA namespace did NOT receive a 'record' action call
    const quotaStub = mockEnv.QUOTA.get(
      'mock-id' as unknown as DurableObjectId
    );
    const quotaFetchCalls = (
      quotaStub as unknown as { fetch: ReturnType<typeof vi.fn> }
    ).fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const recordCalls = quotaFetchCalls.filter((call) => {
      const parsed = JSON.parse(call[1].body as string) as {
        action?: string;
      };
      return parsed.action === 'record';
    });
    expect(recordCalls.length).toBe(0);
  });
});

describe('InstallationQuota check/record split', () => {
  function makeMockStorage() {
    const storage = new Map<string, unknown>();
    return {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> =>
          storage.get(key) as T | undefined,
        put: async (key: string, value: unknown): Promise<void> => {
          storage.set(key, value);
        },
      },
      _map: storage,
    };
  }

  it('check action does not append timestamp', async () => {
    const mock = makeMockStorage();
    const state = mock as unknown as DurableObjectState;
    const { InstallationQuota } = await import('./quota.js');
    const instance = new InstallationQuota(state);

    const response = await instance.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'triage',
          installationId: 1,
          action: 'check',
        }),
      })
    );
    const result = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(result.count).toBe(0);
    expect(result.exceeded).toBe(false);
    // No timestamp should have been appended
    const stored = mock._map.get('quota:1:triage') as
      | {
          timestamps: number[];
        }
      | undefined;
    if (stored) {
      expect(stored.timestamps.length).toBe(0);
    }
  });

  it('record action appends timestamp', async () => {
    const mock = makeMockStorage();
    const state = mock as unknown as DurableObjectState;
    const { InstallationQuota } = await import('./quota.js');
    const instance = new InstallationQuota(state);

    const response = await instance.fetch(
      new Request('https://quota/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'triage',
          installationId: 1,
          action: 'record',
        }),
      })
    );
    const result = (await response.json()) as {
      count: number;
      exceeded: boolean;
    };
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
    const stored = mock._map.get('quota:1:triage') as {
      timestamps: number[];
    };
    expect(stored).toBeDefined();
    expect(stored.timestamps.length).toBe(1);
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
      issue: { number: 42 },
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
    expect(dispatchBody.client_payload.originating_repo).toBe('owner/repo');
    expect(dispatchBody.client_payload.issue_number).toBe(42);
    expect(dispatchBody.client_payload.trigger_type).toBeUndefined();
    expect(dispatchBody.client_payload.comment_id).toBeUndefined();
    expect(dispatchBody.client_payload.commenter_login).toBeUndefined();
    expect(dispatchBody.client_payload.comment_body).toBeUndefined();
    expect(dispatchBody.client_payload.comment_body_truncated).toBeUndefined();
  });

  it('dispatches aptu-review when PR review comment contains @aptu and commenter has read+ access', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      pull_request: { number: 99 },
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
    expect(dispatchBody.client_payload.originating_repo).toBe('owner/repo');
    expect(dispatchBody.client_payload.pull_number).toBe(99);
    expect(dispatchBody.client_payload.instructions_file).toBeNull();
    expect(dispatchBody.client_payload.skip_labeled).toBe(false);
  });

  it('dispatches aptu-review when issue_comment is on a PR (payload.issue.pull_request present)', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      issue: { number: 55, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/55' } },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 88,
        body: '@aptu review please',
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
    expect(dispatchBody.event_type).toBe('aptu-review');
    expect(dispatchBody.client_payload.originating_repo).toBe('owner/repo');
    expect(dispatchBody.client_payload.pull_number).toBe(55);
    expect(dispatchBody.client_payload.instructions_file).toBeNull();
    expect(dispatchBody.client_payload.skip_labeled).toBe(false);
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
      issue: { number: 1 },
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
      issue: { number: 1 },
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
      pull_request: { number: 1 },
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
      issue: { number: 1 },
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

  it('includes issue_number in dispatch payload when comment body is long (no truncation)', async () => {
    const longBody = 'x'.repeat(5000);
    const commentBody = `@aptu ${longBody}`;
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      issue: { number: 77 },
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
    expect(dispatchBody.event_type).toBe('aptu-triage');
    expect(dispatchBody.client_payload.originating_repo).toBe('owner/repo');
    expect(dispatchBody.client_payload.issue_number).toBe(77);
    expect(dispatchBody.client_payload.trigger_type).toBeUndefined();
    expect(dispatchBody.client_payload.comment_body).toBeUndefined();
  });

  it('enforces quota when config.ai is present for mention-triggered events', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nai:\n  provider: openai\n  model: gpt-4o'
          )
        );
      }
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
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    // Quota is exceeded; AI config does NOT bypass quota
    quotaControl.body = JSON.stringify({
      count: 50,
      exceeded: true,
      retryAfter: 3600,
    });

    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      issue: { number: 42 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 42,
        body: '@aptu triage this',
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

  it('proceeds to quota enforcement when config fetch fails for mention', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          new Response('Internal Server Error', { status: 500 })
        );
      }
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
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    // Quota is exceeded; config fetch fails so no AI exemption
    quotaControl.body = JSON.stringify({
      count: 50,
      exceeded: true,
      retryAfter: 3600,
    });

    const body = JSON.stringify({
      action: 'created',
      installation: { id: 1 },
      issue: { number: 42 },
      comment: {
        user: { id: 100, login: 'user1' },
        id: 42,
        body: '@aptu triage this',
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
});

describe('Sentry integration', () => {
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
  });

  it('calls captureException with installationId tag when Durable Object fetch throws', async () => {
    const { captureException: sentryCapture } = await import(
      '@sentry/cloudflare'
    );
    const { createAppAuth } = await import('@octokit/auth-app');
    // biome-ignore lint/suspicious/noExplicitAny: mocking requires casting to any
    (createAppAuth as any).mockImplementation(() =>
      vi.fn().mockResolvedValue({ token: 'mock-installation-token' })
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
      vi.fn().mockResolvedValue({ token: 'mock-installation-token' })
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
    quotaControl.body = JSON.stringify({
      count: 0,
      exceeded: false,
      retryAfter: null,
    });
    quotaControl.status = 200;
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
    expect(parsed.client_payload).toEqual({
      originating_repo: 'owner/repo',
      head_sha: 'abc123',
      pull_number: 10,
      scan_path: 'src/',
      fail_on: 'critical,high',
    });
    expect(parsed.client_payload).not.toHaveProperty('installation_id');
    expect(parsed.client_payload).not.toHaveProperty('originating_owner');
    expect(parsed.client_payload).not.toHaveProperty('originating_repo_name');
    expect(parsed.client_payload).not.toHaveProperty('ai_provider');
    expect(parsed.client_payload).not.toHaveProperty('ai_model');
    expect(parsed.client_payload).not.toHaveProperty('ai_key_secret');
    expect(parsed.client_payload).not.toHaveProperty('installation_token');
  });

  it('dispatches aptu-scan-security with exactly 5 keys when config.ai is present', async () => {
    mockConfig(
      'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nscan:\n  enabled: true\n  fail-on: critical,high\n  path: src/\nai:\n  provider: openai\n  model: gpt-4o\n  api-key-secret: OPENAI_API_KEY'
    );

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 10, title: 'Scan test with AI', head: { sha: 'abc123' } },
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
    expect(parsed.client_payload).toEqual({
      originating_repo: 'owner/repo',
      head_sha: 'abc123',
      pull_number: 10,
      scan_path: 'src/',
      fail_on: 'critical,high',
    });
    expect(Object.keys(parsed.client_payload).length).toBe(5);
    expect(parsed.client_payload).not.toHaveProperty('ai_provider');
    expect(parsed.client_payload).not.toHaveProperty('ai_model');
    expect(parsed.client_payload).not.toHaveProperty('ai_key_secret');
    expect(parsed.client_payload).not.toHaveProperty('installation_id');
    expect(parsed.client_payload).not.toHaveProperty('originating_owner');
    expect(parsed.client_payload).not.toHaveProperty('originating_repo_name');
    expect(parsed.client_payload).not.toHaveProperty('installation_token');
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

  it('records quota with eventType scan after scan dispatch, not review', async () => {
    mockConfig(
      'version: 1\ntriage:\n  enabled: false\nreview:\n  enabled: false\nscan:\n  enabled: true'
    );

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 13, title: 'Quota scan', head: { sha: 'jkl012' } },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });

    const quotaStub = mockEnv.QUOTA.get(
      'mock-id' as unknown as DurableObjectId
    );
    const quotaFetchCalls = (
      quotaStub as unknown as { fetch: ReturnType<typeof vi.fn> }
    ).fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const recordCalls = quotaFetchCalls.filter((call) => {
      const parsed = JSON.parse(call[1].body as string) as {
        action?: string;
        eventType?: string;
      };
      return parsed.action === 'record';
    });
    expect(recordCalls.length).toBe(1);
    const recordBody = JSON.parse(recordCalls[0]![1].body as string) as {
      eventType: string;
    };
    expect(recordBody.eventType).toBe('scan');
  });
});

describe('scoped token helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases = [
    {
      key: 'config',
      installId: 1,
      repo: 'owner/repo',
      expected: { contents: 'read', pull_requests: 'read' },
    },
    {
      key: 'triage',
      installId: 2,
      repo: 'owner/repo',
      expected: { contents: 'read', issues: 'write' },
    },
    {
      key: 'review',
      installId: 3,
      repo: 'owner/repo',
      expected: { contents: 'read', pull_requests: 'write' },
    },
    {
      key: 'scan',
      installId: 4,
      repo: 'owner/repo',
      expected: {
        contents: 'read',
        security_events: 'write',
        statuses: 'write',
      },
    },
    {
      key: 'dispatch',
      installId: 5,
      repo: 'target-repo',
      expected: { contents: 'write' },
    },
  ] as const;

  it.each(
    cases
  )('getScopedToken with PERMS.$key passes correct permissions to auth', async ({
    key,
    installId,
    repo,
    expected,
  }) => {
    const { createAppAuth } = await import('@octokit/auth-app');
    const { getScopedToken, PERMS } = await import('./index.js');

    await getScopedToken(mockEnv, installId, repo, PERMS[key]);

    const mockedCreateAppAuth = createAppAuth as ReturnType<typeof vi.fn>;
    const authFn = mockedCreateAppAuth.mock.results[0]?.value as ReturnType<
      typeof vi.fn
    >;
    expect(authFn).toHaveBeenCalledWith({
      type: 'installation',
      installationId: installId,
      repositoryNames: [repo.split('/')[1] ?? repo],
      permissions: expected,
    });
  });

  it('getScopedToken preserves a repository name without an owner prefix', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    const { getScopedToken, PERMS } = await import('./index.js');

    await getScopedToken(mockEnv, 7, 'standalone-repo', PERMS.config);

    const mockedCreateAppAuth = createAppAuth as ReturnType<typeof vi.fn>;
    const authFn = mockedCreateAppAuth.mock.results[0]?.value as ReturnType<
      typeof vi.fn
    >;
    expect(authFn).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryNames: ['standalone-repo'],
      })
    );
  });

  it('getInstallationToken passes repositoryNames and explicit permissions map to auth', async () => {
    const { createAppAuth } = await import('@octokit/auth-app');
    const { getInstallationToken } = await import('./index.js');

    await getInstallationToken(mockEnv, 6, {
      repositoryNames: ['a', 'b'],
      permissions: { contents: 'read', issues: 'write' },
    });

    const mockedCreateAppAuth = createAppAuth as ReturnType<typeof vi.fn>;
    const authFn = mockedCreateAppAuth.mock.results[0]?.value as ReturnType<
      typeof vi.fn
    >;
    expect(authFn).toHaveBeenCalledWith({
      type: 'installation',
      installationId: 6,
      repositoryNames: ['a', 'b'],
      permissions: { contents: 'read', issues: 'write' },
    });
  });
});

describe('replay guard', () => {
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
  });

  it('rejects a repeated X-GitHub-Delivery ID with 202 and does not dispatch', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const headers = {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'X-GitHub-Delivery': 'dup-123',
      'Content-Type': 'application/json',
    };

    // First request: should succeed
    const r1 = await callHandler(body, headers);
    expect(r1.status).toBe(204);

    // Second request with same delivery ID: should be rejected
    const r2 = await callHandler(body, headers);
    expect(r2.status).toBe(202);

    // Only one dispatch should have occurred
    const dispatchCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCalls.length).toBe(1);
  });

  it('handles absent delivery ID by proceeding without dedup', async () => {
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
  });

  it('handles empty delivery ID by proceeding without dedup', async () => {
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
      'X-GitHub-Delivery': '   ',
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
  });

  it('handles malformed delivery ID by logging a warning and proceeding without dedup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      'X-GitHub-Delivery': 'malformed!@#',
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledWith(
      'X-GitHub-Delivery header contains malformed delivery ID, proceeding without replay dedup'
    );
    warnSpy.mockRestore();
  });
});

describe('IP validation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { __resetIpCache } = await import('./index.js');
    __resetIpCache();
    quotaControl.body = JSON.stringify({
      count: 0,
      exceeded: false,
      retryAfter: null,
    });
    quotaControl.status = 200;
  });

  it('accepts a request from a known GitHub hook IP', async () => {
    // Mock /meta to return a known hook CIDR
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('api.github.com/meta')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ hooks: ['192.30.252.0/22', '140.82.112.0/20'] }),
            { status: 200 }
          )
        );
      }
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true'
          )
        );
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
      'X-GitHub-Delivery': 'ip-test-1',
      'CF-Connecting-IP': '192.30.252.5',
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
  });

  it('rejects a request from an IP outside the GitHub hooks list', async () => {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('api.github.com/meta')) {
        return Promise.resolve(
          new Response(JSON.stringify({ hooks: ['192.30.252.0/22'] }), {
            status: 200,
          })
        );
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
      'X-GitHub-Delivery': 'ip-test-2',
      'CF-Connecting-IP': '10.0.0.1',
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });

  it('proceeds normally (fail-open) when /meta is unavailable', async () => {
    fetchSpy.mockImplementation((url: unknown) => {
      const urlStr =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : (url as Request).url;
      if (urlStr.includes('api.github.com/meta')) {
        return Promise.resolve(
          new Response('Service Unavailable', { status: 503 })
        );
      }
      if (urlStr.includes('/contents/.github/aptu.yml')) {
        return Promise.resolve(
          makeConfigResponse(
            'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true'
          )
        );
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
      'X-GitHub-Delivery': 'ip-test-3',
      'CF-Connecting-IP': '10.0.0.1',
      'Content-Type': 'application/json',
    });
    // Fail-open: should proceed despite unknown IP when /meta is down
    expect(response.status).toBe(204);
  });
});
