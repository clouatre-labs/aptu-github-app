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

const mockEnv = {
  WEBHOOK_SECRET: 'test-secret',
  APP_PRIVATE_KEY: 'fake-key',
  APP_ID: '4134521',
  TARGET_REPO: 'clouatre-labs/aptu-github-app',
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'myorg/myrepo' },
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
      repository: { full_name: 'myorg/myrepo' },
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
      repository: { full_name: 'clouatre-labs/clouatre.ca' },
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
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { filename: 'src/data/blog/post.md' },
          { filename: 'worker/src/index.ts' },
        ]),
        { status: 200 }
      )
    );
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true'
      )
    );
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 43, title: 'Mixed changes' },
      repository: { full_name: 'clouatre-labs/clouatre.ca' },
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
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true'
      )
    );
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 44, title: 'Unconfigured repo' },
      repository: { full_name: 'unconfigured/repo' },
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
    fetchSpy.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    );
    fetchSpy.mockResolvedValueOnce(
      makeConfigResponse(
        'version: 1\ntriage:\n  enabled: true\nreview:\n  enabled: true'
      )
    );
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 45, title: 'API failure test' },
      repository: { full_name: 'clouatre-labs/clouatre.ca' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
      repository: { full_name: 'owner/repo' },
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
