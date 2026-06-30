// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 aptu-github-app Contributors

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(() =>
    vi.fn().mockResolvedValue({ token: 'mock-installation-token' })
  ),
}));

// biome-ignore lint/suspicious/noExplicitAny: spyOn type parameters require any for global fetch overload
let fetchSpy: ReturnType<typeof vi.spyOn<any, any>>;

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

function mockEnabledFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((url: string | URL | Request) => {
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
  });
}

function mockDisabledFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((url: string | URL | Request) => {
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
  });
}

function mockAbsentConfigFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((url: string | URL | Request) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('/contents/.github/aptu.yml')) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
}

function mockEnabledWithAiFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((url: string | URL | Request) => {
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
  });
}

const mockEnv = {
  WEBHOOK_SECRET: 'test-secret',
  APP_PRIVATE_KEY: 'fake-key',
  APP_ID: '4134521',
  TARGET_REPO: 'clouatre-labs/aptu-github-app',
  ALLOWED_OWNERS: 'owner,myorg,clouatre-labs,unconfigured',
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
      JSON.stringify({ action: 'created', comment: {}, issue: {} }),
    ],
    [
      'pull_request_review_comment',
      JSON.stringify({ action: 'created', comment: {}, pull_request: {} }),
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
    const body = JSON.stringify({ action: 'created' });
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

  it('returns 204 without dispatch when all PR files match exclude_paths patterns', async () => {
    // Mock config fetch (404 - no aptu.yml)
    fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    // Mock PR files fetch - all files match exclude_paths in repos.json
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'src/data/blog/post.md' },
          { filename: 'src/assets/images/photo.png' },
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

  it('returns 204 and dispatches when one file does not match exclude_paths (partial match)', async () => {
    // Mock config fetch - includes exclude_paths in aptu.yml
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nexclude_paths:\n  - "src/data/**"'
      )
    );
    // Mock PR files fetch - one file doesn't match exclude_paths so should dispatch
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

  it('returns 204 and dispatches normally when repo has no entry in config/repos.json', async () => {
    // Mock config fetch - no exclude_paths defined, repo not in repos.json
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

  it('returns 204 and dispatches when GitHub API fetch for PR files throws or fails', async () => {
    // Mock config fetch - has exclude_paths
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true\nexclude_paths:\n  - "docs/**"'
      )
    );
    // Mock PR files fetch failure - should return false (dispatch)
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

describe('allowlist (ALLOWED_OWNERS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(mockEnabledFetch());
  });

  it('returns 403 when issues.opened owner is not in ALLOWED_OWNERS', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'untrusted/repo',
        owner: { login: 'untrusted' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });

  it('returns 403 when pull_request owner is not in ALLOWED_OWNERS', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 1, title: 'Test PR' },
      repository: {
        full_name: 'untrusted/repo',
        owner: { login: 'untrusted' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'pull_request',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });

  it('passes through to processing when issues.opened owner is in ALLOWED_OWNERS', async () => {
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
  });

  it('returns 403 when repository.owner.login is missing', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: { full_name: 'owner/repo' },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
  });
});

describe('isOwnerAllowed', () => {
  it('handles case-insensitive matching', async () => {
    const { isOwnerAllowed } = await import('./index.js');
    expect(isOwnerAllowed('Clouatre-Labs', 'clouatre-labs,clouatre')).toBe(
      true
    );
    expect(isOwnerAllowed('CLOUATRE', 'clouatre-labs,clouatre')).toBe(true);
    expect(isOwnerAllowed('Other', 'clouatre-labs,clouatre')).toBe(false);
  });

  it('returns false when ALLOWED_OWNERS is empty string', async () => {
    const { isOwnerAllowed } = await import('./index.js');
    expect(isOwnerAllowed('clouatre-labs', '')).toBe(false);
  });

  it('handles trailing comma without producing empty match', async () => {
    const { isOwnerAllowed } = await import('./index.js');
    expect(isOwnerAllowed('clouatre-labs', 'clouatre-labs,')).toBe(true);
    expect(isOwnerAllowed('other', 'clouatre-labs,')).toBe(false);
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

  it('returns 403 with diagnostic body when owner not in ALLOWED_OWNERS and ai block absent', async () => {
    fetchSpy.mockImplementation(mockAbsentConfigFetch());
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'external/repo',
        owner: { login: 'external' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(403);
    const body_text = await response.text();
    expect(body_text).toBe(
      'External installations require an ai block in .github/aptu.yml'
    );
  });

  it('returns 204 and dispatches when owner not in ALLOWED_OWNERS but valid ai block present', async () => {
    fetchSpy.mockImplementation(mockEnabledWithAiFetch());
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Test' },
      repository: {
        full_name: 'external/repo',
        owner: { login: 'external' },
      },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandler(body, {
      'X-GitHub-Event': 'issues',
      'X-Hub-Signature-256': sig,
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(204);
    const dispatchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/dispatches')
    );
    expect(dispatchCall).toBeDefined();
  });
});

describe('shouldSkipPrDispatch direct unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('returns true (skip) when both repos.json and aptu.yml have matching exclude_paths (precedence: aptu.yml wins)', async () => {
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
      { version: 1, exclude_paths: ['docs/**'] }
    );
    expect(result).toBe(true);
  });

  it('falls back to repos.json exclude_paths when aptu.yml is null and repos.json has an entry', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'src/data/blog/post.md' },
          { filename: 'public/audio/podcast.mp3' },
        ]),
        { status: 200 }
      )
    );
    const { shouldSkipPrDispatch } = await import('./index.js');
    const result = await shouldSkipPrDispatch(
      'clouatre-labs/clouatre.ca',
      42,
      'mock-token',
      null
    );
    expect(result).toBe(true);
  });

  it('falls back to repos.json exclude_paths when aptu.yml has no exclude_paths field and repos.json has an entry', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'src/data/blog/post.md' },
          { filename: 'public/audio/podcast.mp3' },
        ]),
        { status: 200 }
      )
    );
    const { shouldSkipPrDispatch } = await import('./index.js');
    const result = await shouldSkipPrDispatch(
      'clouatre-labs/clouatre.ca',
      42,
      'mock-token',
      { version: 1 }
    );
    expect(result).toBe(true);
  });

  it('returns false (dispatch) when both aptu.yml and repos.json are null/no entry', async () => {
    const { shouldSkipPrDispatch } = await import('./index.js');
    const result = await shouldSkipPrDispatch(
      'unknown/repo',
      42,
      'mock-token',
      null
    );
    expect(result).toBe(false);
  });

  it('returns false (dispatch) when aptu.yml has exclude_paths but no PR file matches any pattern', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'worker/src/index.ts' },
          { filename: 'worker/src/config.ts' },
        ]),
        { status: 200 }
      )
    );
    const { shouldSkipPrDispatch } = await import('./index.js');
    const result = await shouldSkipPrDispatch(
      'clouatre-labs/clouatre.ca',
      42,
      'mock-token',
      { version: 1, exclude_paths: ['docs/**'] }
    );
    expect(result).toBe(false);
  });

  it('returns false (dispatch) on GitHub API failure even when aptu.yml or repos.json has exclude_paths (error-resilient contract)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );
    const { shouldSkipPrDispatch } = await import('./index.js');
    const result = await shouldSkipPrDispatch(
      'clouatre-labs/clouatre.ca',
      42,
      'mock-token',
      { version: 1, exclude_paths: ['docs/**'] }
    );
    expect(result).toBe(false);
  });
});
