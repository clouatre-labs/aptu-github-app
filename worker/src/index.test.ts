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

const mockEnv = {
  WEBHOOK_SECRET: 'test-secret',
  APP_PRIVATE_KEY: 'fake-key',
  APP_ID: '4134521',
  TARGET_REPO: 'clouatre-labs/aptu-github-app',
  EXCLUDED_REPOS: '',
};

async function callHandler(body: string, headers: Record<string, string>) {
  const { default: handler } = await import('./index.js');
  const request = new Request('https://aptu.dev/webhook', {
    method: 'POST',
    headers,
    body,
  });
  return handler.fetch(request, mockEnv);
}

describe('HMAC validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
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
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
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
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ['opened', 'opened PR'],
    ['synchronize', 'sync PR'],
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
    expect(fetchSpy).toHaveBeenCalledOnce();
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
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
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
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
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
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed.client_payload).toMatchObject({
      installation_token: 'mock-installation-token',
      originating_repo: 'myorg/myrepo',
      issue_number: 42,
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
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed.client_payload).toMatchObject({
      installation_token: 'mock-installation-token',
      originating_repo: 'myorg/myrepo',
      pull_number: 99,
    });
  });
});

describe('excluded repos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
  });

  async function callHandlerWithEnv(
    body: string,
    headers: Record<string, string>,
    env: Record<string, string>
  ) {
    const { default: handler } = await import('./index.js');
    const request = new Request('https://aptu.dev/webhook', {
      method: 'POST',
      headers,
      body,
    });
    return handler.fetch(request, env);
  }

  it('returns 200 without dispatch when issues.opened repo matches EXCLUDED_REPOS', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Excluded issue' },
      repository: { full_name: 'clouatre-labs/aptu' },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandlerWithEnv(
      body,
      {
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      { ...mockEnv, EXCLUDED_REPOS: 'clouatre-labs/aptu' }
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 200 without dispatch when pull_request.opened repo matches EXCLUDED_REPOS', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      pull_request: { number: 1, title: 'Excluded PR' },
      repository: { full_name: 'clouatre-labs/aptu' },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandlerWithEnv(
      body,
      {
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      { ...mockEnv, EXCLUDED_REPOS: 'clouatre-labs/aptu' }
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 204 and calls dispatch when issues.opened repo does not match EXCLUDED_REPOS (different repo)', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Non-excluded issue' },
      repository: { full_name: 'other-org/other-repo' },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandlerWithEnv(
      body,
      {
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      { ...mockEnv, EXCLUDED_REPOS: 'clouatre-labs/aptu' }
    );
    expect(response.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns 204 and calls dispatch when EXCLUDED_REPOS is empty string', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'Empty excluded' },
      repository: { full_name: 'clouatre-labs/aptu' },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandlerWithEnv(
      body,
      {
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      { ...mockEnv, EXCLUDED_REPOS: '' }
    );
    expect(response.status).toBe(204);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns 200 without dispatch when repo matches from comma-separated EXCLUDED_REPOS list', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      issue: { number: 1, title: 'List excluded' },
      repository: { full_name: 'my-org/my-repo' },
    });
    const sig = sign(mockEnv.WEBHOOK_SECRET, body);
    const response = await callHandlerWithEnv(
      body,
      {
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
        'Content-Type': 'application/json',
      },
      {
        ...mockEnv,
        EXCLUDED_REPOS: 'clouatre-labs/aptu, my-org/my-repo, other/third',
      }
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
