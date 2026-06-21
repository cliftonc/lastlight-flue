import { describe, it, expect } from 'vitest';
import type {
  ListRunsResponse,
  RunRecord,
  AgentManifestEntry,
} from '@flue/runtime';
import { createApp, healthBody, authRequiredBody } from '../src/app.ts';
import type { RunsReader } from '../src/admin/runs-reader.ts';
import { createToken } from '../src/admin/auth.ts';

// Phase 2 · slice 1 — contract tests for the APPLICATION-OWNED server surface.
//
// These use `createApp()` (the app-owned factory) + Hono's in-process
// `app.request(...)`, so they run fully OFFLINE: no `flue dev` server, no build,
// no model call. `createApp()` deliberately does NOT mount `flue()`, so these
// exercise exactly the routes Last Light owns (/health, /api/status,
// /admin/api/auth-required) plus the 501 seams for not-yet-ported routes.

describe('app-owned surface (createApp, in-process)', () => {
  // Explicit disabled-auth config so these assertions never depend on whether
  // the developer happens to have ADMIN_PASSWORD exported in their shell.
  const app = createApp({ authConfig: { password: '', secret: 'x' } });

  it('GET /health → 200 with preserved Last Light shape', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Legacy server returned { status: "ok", ... } — `lastlight status` reads it.
    expect(body.status).toBe('ok');
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime as number).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/status → 200 readiness view', async () => {
    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
  });

  it('GET /admin/api/auth-required → 200 with auth-method shape', async () => {
    const res = await app.request('/admin/api/auth-required');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // CLI `status` reads required/slackOAuth/githubOAuth booleans.
    expect(typeof body.required).toBe('boolean');
    expect(typeof body.slackOAuth).toBe('boolean');
    expect(typeof body.githubOAuth).toBe('boolean');
  });

  it('not-yet-ported trigger routes return 501 (honest, not fake data)', async () => {
    for (const path of ['/api/run', '/api/build', '/api/chat']) {
      const res = await app.request(path, { method: 'POST' });
      expect(res.status).toBe(501);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('not_implemented');
    }
  });

  it('admin data routes 501 with NO reader injected (honest, not fake)', async () => {
    // createApp() with no opts → admin data routes are not backed; they 501.
    for (const path of [
      '/admin/api/runs',
      '/admin/api/workflow-runs',
      '/admin/api/agents',
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(501);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('not_implemented');
    }
  });

  it('genuinely-Phase-7 admin routes stay 501 (stats/sessions/approvals)', async () => {
    for (const path of ['/admin/api/stats', '/admin/api/sessions', '/admin/api/approvals']) {
      const res = await app.request(path);
      expect(res.status).toBe(501);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('not_implemented');
      expect(body.slice).toBe('phase-7');
    }
  });

  it('unknown route → 404 (Hono default, no flue() mounted)', async () => {
    const res = await app.request('/no-such-route');
    expect(res.status).toBe(404);
  });
});

// ── Admin reads backed by an INJECTED fake RunsReader (no live Flue runtime) ──
// The real listRuns/getRun/listAgents throw "runtime not configured" outside a
// built server; injecting a fake exercises the routes + the shape mapping fully
// offline. Asserts status + mapped shape + 404 for a missing run.
describe('admin reads with injected RunsReader (offline)', () => {
  const sampleRuns: ListRunsResponse = {
    runs: [
      {
        runId: 'run_a',
        workflowName: 'build',
        status: 'active',
        startedAt: '2026-06-21T10:00:00.000Z',
      },
      {
        runId: 'run_b',
        workflowName: 'pr-review',
        status: 'completed',
        startedAt: '2026-06-21T09:00:00.000Z',
        endedAt: '2026-06-21T09:05:00.000Z',
        durationMs: 300000,
        isError: false,
      },
    ],
    nextCursor: 'cur_next',
  };
  const sampleRecord: RunRecord = {
    runId: 'run_a',
    workflowName: 'build',
    status: 'active',
    startedAt: '2026-06-21T10:00:00.000Z',
    payload: { repo: 'owner/repo', issue: 7 },
  };
  const sampleAgents: AgentManifestEntry[] = [
    { name: 'hello', transports: { http: true }, created: true },
  ];

  function makeApp(overrides: Partial<RunsReader> = {}) {
    const reader: RunsReader = {
      listRuns: async () => sampleRuns,
      getRun: async (id) => (id === 'run_a' ? sampleRecord : null),
      listAgents: async () => sampleAgents,
      ...overrides,
    };
    return {
      app: createApp({ runsReader: reader, authConfig: { password: '', secret: 'x' } }),
      reader,
    };
  }

  it('GET /admin/api/workflow-runs → 200 mapped { workflowRuns, total, nextCursor }', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/api/workflow-runs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflowRuns: Array<Record<string, unknown>>;
      total: number;
      nextCursor: string | null;
    };
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBe('cur_next');
    expect(body.workflowRuns[0]!.id).toBe('run_a'); // runId → id
    expect(body.workflowRuns[0]!.status).toBe('running'); // active → running
    expect(body.workflowRuns[1]!.status).toBe('succeeded'); // completed → succeeded
    // blob-free: no payload/result/error on list rows
    expect('payload' in body.workflowRuns[0]!).toBe(false);
    // explicit Phase-7 nulls, not fabricated
    expect(body.workflowRuns[0]!.currentPhase).toBeNull();
  });

  it('GET /admin/api/runs is an alias for the same list', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/api/runs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflowRuns: unknown[] };
    expect(body.workflowRuns).toHaveLength(2);
  });

  it('passes limit/workflow/status filters through to listRuns', async () => {
    let seen: unknown;
    const { app } = makeApp({
      listRuns: async (opts) => {
        seen = opts;
        return { runs: [] };
      },
    });
    await app.request('/admin/api/workflow-runs?limit=5&workflow=build&status=running');
    expect(seen).toEqual({
      limit: 5,
      workflowName: 'build',
      status: 'active', // dashboard 'running' → Flue 'active'
      cursor: undefined,
    });
  });

  it('GET /admin/api/workflow-runs/:id → 200 detail with blobs', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/api/workflow-runs/run_a');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflowRun: Record<string, unknown> };
    expect(body.workflowRun.id).toBe('run_a');
    expect(body.workflowRun.payload).toEqual({ repo: 'owner/repo', issue: 7 });
  });

  it('GET /admin/api/runs/:id missing → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/api/runs/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('workflow run not found');
  });

  it('GET /admin/api/agents → 200 mapped agents', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/api/agents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toEqual([
      { name: 'hello', description: null, http: true, created: true },
    ]);
  });

  it('auth-required stays mounted (unauthenticated) even with a reader', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/api/auth-required');
    expect(res.status).toBe(200);
  });
});

describe('shape builders (pure, unit)', () => {
  it('healthBody computes non-negative whole-second uptime', () => {
    const b = healthBody(Date.now() + 5000);
    expect(b.status).toBe('ok');
    expect(b.ok).toBe(true);
    expect(b.uptime).toBeGreaterThanOrEqual(5);
    expect(Number.isInteger(b.uptime)).toBe(true);
  });

  it('authRequiredBody reflects config: no password → not required', () => {
    const b = authRequiredBody({ password: '', secret: 's' });
    expect(b.required).toBe(false);
    expect(b.slackOAuth).toBe(false);
    expect(b.githubOAuth).toBe(false);
  });

  it('authRequiredBody reflects config: password set → required', () => {
    const b = authRequiredBody({ password: 'hunter2', secret: 's' });
    expect(b.required).toBe(true);
  });
});

// ── Operator auth on /admin/api/* (ported HMAC-bearer middleware) ─────────────
// Mounted on the whole prefix; exempts auth-required + login. When a password is
// configured, protected data routes need a valid bearer token; otherwise 401.
// All offline: an injected fake RunsReader backs the protected route, and the
// auth config is injected so no env/secrets are touched.
describe('operator auth on /admin/api/*', () => {
  const SECRET = 'test-admin-secret';
  const fakeReader: RunsReader = {
    listRuns: async () => ({ runs: [] }),
    getRun: async () => null,
    listAgents: async () => [],
  };

  function authedApp() {
    return createApp({
      runsReader: fakeReader,
      authConfig: { password: 'hunter2', secret: SECRET },
    });
  }

  it('protected /admin/api/runs → 401 without credentials', async () => {
    const app = authedApp();
    const res = await app.request('/admin/api/runs');
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
  });

  it('protected /admin/api/runs → 200 with a valid bearer token', async () => {
    const app = authedApp();
    const token = createToken(SECRET, 'password');
    const res = await app.request('/admin/api/runs', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('accepts a valid token via ?token= query param (EventSource path)', async () => {
    const app = authedApp();
    const token = createToken(SECRET, 'password');
    const res = await app.request(`/admin/api/runs?token=${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a token signed with the wrong secret → 401', async () => {
    const app = authedApp();
    const bad = createToken('some-other-secret', 'password');
    const res = await app.request('/admin/api/runs', {
      headers: { Authorization: `Bearer ${bad}` },
    });
    expect(res.status).toBe(401);
  });

  it('auth-required is reachable WITHOUT auth (and reports required:true)', async () => {
    const app = authedApp();
    const res = await app.request('/admin/api/auth-required');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.required).toBe(true);
  });

  it('login with the correct password → 200 { token } that authenticates', async () => {
    const app = authedApp();
    const res = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe('string');
    // The issued token must actually authenticate a protected route.
    const ok = await app.request('/admin/api/runs', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(ok.status).toBe(200);
  });

  it('login with the wrong password → 401', async () => {
    const app = authedApp();
    const res = await app.request('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid password');
  });

  it('auth DISABLED (no password) → protected routes pass through unauthenticated', async () => {
    const app = createApp({
      runsReader: fakeReader,
      authConfig: { password: '', secret: SECRET },
    });
    const res = await app.request('/admin/api/runs');
    expect(res.status).toBe(200);
    // login with no password issues a token + authDisabled flag
    const login = await app.request('/admin/api/login', { method: 'POST' });
    const body = (await login.json()) as Record<string, unknown>;
    expect(body.authDisabled).toBe(true);
    expect(typeof body.token).toBe('string');
  });
});
