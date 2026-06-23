import { describe, it, expect } from 'vitest';
import type {
  ListRunsResponse,
  RunRecord,
  AgentManifestEntry,
} from '@flue/runtime';
import { createApp, healthBody, authRequiredBody } from '../src/app.ts';
import type { RunsReader } from '../src/admin/runs-reader.ts';
import {
  buildStatsResponse,
  type StatsReader,
} from '../src/admin/stats-reader.ts';
import type { RollupRow, StatsTotals } from '../src/stats-store.ts';
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

  it('GET / → 302 redirect to the admin dashboard', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/');
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

  it('stats 501 with NO stats reader wired (honest, not fake)', async () => {
    const res = await app.request('/admin/api/stats');
    expect(res.status).toBe(501);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('not_implemented');
    expect(body.slice).toContain('no stats reader');
  });

  it('sessions 501 with NO session reader wired (honest, not fake)', async () => {
    const res = await app.request('/admin/api/sessions');
    expect(res.status).toBe(501);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('not_implemented');
    expect(body.slice).toContain('no session reader');
  });

  it('approvals 501 with NO approvals backend wired (honest, not fake)', async () => {
    const res = await app.request('/admin/api/approvals');
    expect(res.status).toBe(501);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('not_implemented');
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

// ── Approvals surface (Phase 4 · resume wiring) ──────────────────────────────
// The durable build gate, driven by the CLI (`lastlight approvals` /
// approve / reject). GET lists PAUSED build runs; POST `:id/respond
// { decision }` maps to resume(approve|reject). Backend is an injected fake so
// the routes are exercised OFFLINE — no build run-store, no `flue run` spawn.
describe('approvals endpoints (Phase 4 resume wiring)', () => {
  type RespondCall = { id: string; decision: 'approve' | 'reject' };

  function fakeBackend(overrides: {
    rows?: import('../src/admin/approvals.ts').ApprovalSummary[];
    respond?: (
      id: string,
      decision: 'approve' | 'reject',
    ) => Promise<import('../src/admin/approvals.ts').ApprovalRespondResult | null> | import('../src/admin/approvals.ts').ApprovalRespondResult | null;
  } = {}) {
    const calls: RespondCall[] = [];
    const backend: import('../src/admin/approvals.ts').ApprovalsBackend = {
      list: async () =>
        overrides.rows ?? [
          {
            id: 'run-1',
            gate: 'post_architect',
            kind: 'architect',
            workflowRunId: 'run-1',
            summary: 'o/r#7 — .lastlight/issue-7/architect-plan.md',
            restartCount: 0,
            createdAt: null,
          },
        ],
      respond: async (id: string, decision: 'approve' | 'reject') => {
        calls.push({ id, decision });
        if (overrides.respond) return overrides.respond(id, decision);
        return { ok: true, status: decision === 'reject' ? 'failed' : 'complete', decision };
      },
    };
    return { backend, calls };
  }

  it('GET /admin/api/approvals lists paused runs in the CLI shape', async () => {
    const { backend } = fakeBackend();
    const app = createApp({ approvals: backend, authConfig: { password: '', secret: 'x' } });
    const res = await app.request('/admin/api/approvals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<Record<string, unknown>> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.id).toBe('run-1');
    expect(body.approvals[0]!.gate).toBe('post_architect');
    expect(body.approvals[0]!.workflowRunId).toBe('run-1');
  });

  it('POST approve → resume("approve")', async () => {
    const { backend, calls } = fakeBackend();
    const app = createApp({ approvals: backend, authConfig: { password: '', secret: 'x' } });
    const res = await app.request('/admin/api/approvals/run-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('complete');
    expect(calls).toEqual([{ id: 'run-1', decision: 'approve' }]);
  });

  it('POST reject → resume("reject") (terminalize)', async () => {
    const { backend, calls } = fakeBackend();
    const app = createApp({ approvals: backend, authConfig: { password: '', secret: 'x' } });
    const res = await app.request('/admin/api/approvals/run-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'rejected' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('failed');
    expect(calls).toEqual([{ id: 'run-1', decision: 'reject' }]);
  });

  it('double-approve is idempotent — second resume is a no-op at the data layer', async () => {
    // The fake mimics resume()'s idempotency: a re-approve of an already-complete
    // run returns 'complete' without a second re-invoke. The endpoint just relays.
    let approveCount = 0;
    const { backend } = fakeBackend({
      respond: () => {
        approveCount++;
        return { ok: true, status: 'complete', decision: 'approve' };
      },
    });
    const app = createApp({ approvals: backend, authConfig: { password: '', secret: 'x' } });
    const body = JSON.stringify({ decision: 'approved' });
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
    const r1 = await app.request('/admin/api/approvals/run-1/respond', opts);
    const r2 = await app.request('/admin/api/approvals/run-1/respond', opts);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Endpoint relays each call; idempotency itself lives in resume() (covered by
    // the resume/build tests). Here we assert the route is a clean pass-through.
    expect(approveCount).toBe(2);
  });

  it('unknown runId → 404', async () => {
    const { backend } = fakeBackend({ respond: () => null });
    const app = createApp({ approvals: backend, authConfig: { password: '', secret: 'x' } });
    const res = await app.request('/admin/api/approvals/nope/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('approval not found');
  });

  it('invalid decision → 400', async () => {
    const { backend } = fakeBackend();
    const app = createApp({ approvals: backend, authConfig: { password: '', secret: 'x' } });
    const res = await app.request('/admin/api/approvals/run-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('operator-auth gates approvals — 401 without a token', async () => {
    const SECRET = 'approvals-secret';
    const { backend } = fakeBackend();
    const app = createApp({ approvals: backend, authConfig: { password: 'hunter2', secret: SECRET } });
    const list = await app.request('/admin/api/approvals');
    expect(list.status).toBe(401);
    const respond = await app.request('/admin/api/approvals/run-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(respond.status).toBe(401);
    // …and 200 with a valid token.
    const token = createToken(SECRET, 'password');
    const ok = await app.request('/admin/api/approvals', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });
});

// ── Default approvals backend over a real build run-store (offline) ───────────
// Exercises createDefaultApprovalsBackend against an on-disk BuildRunStore with an
// INJECTED fake resume — no `flue run` spawn, no GitHub. Asserts list maps paused
// runs and respond routes the decision through resume + 404s an unknown id.
describe('default approvals backend (build run-store + injected resume)', () => {
  it('lists paused runs and routes respond through resume', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { BuildRunStore } = await import('../src/build-run-store.ts');
    const { createDefaultApprovalsBackend } = await import('../src/admin/approvals.ts');

    const dir = mkdtempSync(join(tmpdir(), 'apr-'));
    const storePath = join(dir, 'b.db');
    try {
      const store = new BuildRunStore(storePath);
      store.getOrCreate('paused-run', { owner: 'o', repo: 'r', issue: 7, branch: 'b', taskId: 't' });
      store.markPhaseDone('paused-run', 'architect', {
        architectPlan: '.lastlight/issue-7/architect-plan.md',
      });
      store.setPending('paused-run', 'post_architect');
      store.getOrCreate('active-run', { owner: 'o', repo: 'r', issue: 8, branch: 'b', taskId: 't' });
      store.close();

      const calls: Array<{ id: string; decision: string }> = [];
      const fakeResume = (async (id: string, decision: string) => {
        calls.push({ id, decision });
        return { status: decision === 'reject' ? 'failed' : 'complete' };
      }) as unknown as typeof import('../src/resume.ts').resume;

      const backend = createDefaultApprovalsBackend({ storePath, resume: fakeResume });
      const rows = await backend.list();
      // Only the PAUSED run is surfaced (the active one is not an approval).
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('paused-run');
      expect(rows[0]!.gate).toBe('post_architect');
      expect(rows[0]!.summary).toContain('o/r#7');
      expect(rows[0]!.summary).toContain('architect-plan.md');

      const ok = await backend.respond('paused-run', 'approve');
      expect(ok?.status).toBe('complete');
      expect(calls).toEqual([{ id: 'paused-run', decision: 'approve' }]);

      // Unknown id → null (route 404s).
      const missing = await backend.respond('no-such-run', 'approve');
      expect(missing).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Sessions / transcripts on the Flue durable store (Phase 7 · slice 1) ──────
//
// Routes via `app.request` with the SessionReader seam MOCKED — the real Flue
// RunStore/EventStreamStore throw outside a configured runtime, so the routes
// are exercised fully OFFLINE with a fake (list returns blob-free metas; :id
// returns a transcript; 404 unknown; operator-auth 401).

import type {
  SessionReader,
  SessionMeta,
  TranscriptReadResult,
} from '../src/admin/session-reader.ts';

describe('admin sessions with injected SessionReader (offline)', () => {
  const sampleMeta: SessionMeta = {
    id: 'run_a',
    source: 'run',
    sessionType: 'build',
    kind: 'run',
    model: null,
    started_at: 1_700_000_000,
    last_message_at: 1_700_000_300,
    message_count: 0,
    tool_call_count: 0,
    conversation_message_count: 0,
    last_assistant_content: null,
    agentIds: [],
    platform: null,
  };

  const transcript: TranscriptReadResult = {
    events: [
      { data: { type: 'message_end', message: { role: 'user', content: 'hi' }, timestamp: 't1' }, offset: '0_1' },
      {
        data: {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu_1', name: 'github_read', input: {} }], model: 'openai/x' },
          timestamp: 't2',
        },
        offset: '0_2',
      },
      { data: { type: 'tool', toolName: 'github_read', toolCallId: 'tu_1', result: 'done', timestamp: 't3' }, offset: '0_3' },
    ],
    nextOffset: '0_3',
    upToDate: true,
  };

  const fakeReader = (overrides: Partial<SessionReader> = {}): SessionReader => ({
    async listSessions() {
      return { sessions: [sampleMeta], nextCursor: 'cur_next' };
    },
    async exists(id) {
      return id === 'run_a';
    },
    async readTranscript() {
      return transcript;
    },
    ...overrides,
  });

  const makeApp = (reader: SessionReader) =>
    createApp({ sessionReader: reader, authConfig: { password: '', secret: 'x' } });

  it('GET /admin/api/sessions → 200 blob-free list { sessions, liveCount, nextCursor }', async () => {
    const app = makeApp(fakeReader());
    const res = await app.request('/admin/api/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: SessionMeta[]; liveCount: number; nextCursor: string | null };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.id).toBe('run_a');
    expect(body.sessions[0]!.message_count).toBe(0); // list path reads no transcript
    expect(body.liveCount).toBe(0);
    expect(body.nextCursor).toBe('cur_next');
  });

  it('list path NEVER calls readTranscript (blob-free invariant)', async () => {
    let read = 0;
    const app = makeApp(
      fakeReader({
        async readTranscript() {
          read++;
          return transcript;
        },
      }),
    );
    await app.request('/admin/api/sessions');
    expect(read).toBe(0);
  });

  it('GET /admin/api/sessions/:id → 200 meta with counts derived from transcript', async () => {
    const app = makeApp(fakeReader());
    const res = await app.request('/admin/api/sessions/run_a');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: SessionMeta };
    expect(body.session.id).toBe('run_a');
    expect(body.session.message_count).toBe(3); // user + assistant + tool rows
    expect(body.session.tool_call_count).toBe(1);
    expect(body.session.model).toBe('openai/x');
    expect(body.session.last_assistant_content).toBe('hello');
  });

  it('GET /admin/api/sessions/:id/messages → 200 transcript { source, messages, last_id }', async () => {
    const app = makeApp(fakeReader());
    const res = await app.request('/admin/api/sessions/run_a/messages');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      messages: Array<{ id: number; role: string; content?: unknown; tool_calls?: unknown[] }>;
      last_id: string;
    };
    expect(body.source).toBe('flue');
    expect(body.last_id).toBe('0_3'); // the stream resume offset
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(body.messages[1]!.tool_calls).toEqual([
      { id: 'tu_1', name: 'github_read', arguments: {} },
    ]);
  });

  it('GET /admin/api/workflow-runs/:id/phases → derived phases from the run stream', async () => {
    const phaseStream = {
      events: [
        { data: { type: 'run_start' }, offset: '0_0' },
        { data: { type: 'agent_start', operationId: 'op1', session: 'guardrails', timestamp: 't1' }, offset: '0_1' },
        { data: { type: 'message_end', operationId: 'op1', message: { role: 'user', content: 'go' }, timestamp: 't2' }, offset: '0_2' },
        { data: { type: 'agent_start', operationId: 'op2', session: 'architect', timestamp: 't3' }, offset: '0_3' },
        { data: { type: 'tool', operationId: 'op2', result: 'ok', timestamp: 't4' }, offset: '0_4' },
      ],
      nextOffset: '0_4',
      upToDate: true,
    };
    const app = makeApp(
      fakeReader({
        async exists() {
          return true;
        },
        async readTranscript() {
          return phaseStream;
        },
      }),
    );
    const res = await app.request('/admin/api/workflow-runs/run_a/phases');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phases: Array<{ operationId: string; name: string; messageCount: number; toolCount: number }> };
    expect(body.phases.map((p) => p.name)).toEqual(['guardrails', 'architect']);
    expect(body.phases[0]!.messageCount).toBe(1);
    expect(body.phases[1]!.toolCount).toBe(1);
  });

  it('GET /admin/api/workflow-runs/:id/phases unknown → 404', async () => {
    const app = makeApp(fakeReader());
    const res = await app.request('/admin/api/workflow-runs/nope/phases');
    expect(res.status).toBe(404);
  });

  it('messages route drains all pages (no first-page truncation) + operation filter', async () => {
    // Two pages: page 1 not up-to-date, page 2 finishes. Each page carries one
    // op1 + one op2 event so we can assert both the drain and the filter.
    const page1 = {
      events: [
        { data: { type: 'message_end', operationId: 'op1', message: { role: 'user', content: 'a' } }, offset: '0_1' },
        { data: { type: 'message_end', operationId: 'op2', message: { role: 'assistant', content: 'b' } }, offset: '0_2' },
      ],
      nextOffset: '0_2',
      upToDate: false,
    };
    const page2 = {
      events: [
        { data: { type: 'message_end', operationId: 'op1', message: { role: 'user', content: 'c' } }, offset: '0_3' },
      ],
      nextOffset: '0_3',
      upToDate: true,
    };
    const makeFake = () => {
      let call = 0;
      return makeApp(
        fakeReader({
          async exists() {
            return true;
          },
          async readTranscript() {
            return call++ === 0 ? page1 : page2;
          },
        }),
      );
    };
    const all = (await (await makeFake().request('/admin/api/sessions/run_a/messages')).json()) as { messages: unknown[] };
    expect(all.messages).toHaveLength(3); // drained both pages
    const filtered = (await (await makeFake().request('/admin/api/sessions/run_a/messages?operation=op1')).json()) as { messages: unknown[] };
    expect(filtered.messages).toHaveLength(2); // only op1
  });

  it('sessions list surfaces chat threads + runs together with kind tags', async () => {
    const chatRow: SessionMeta = {
      id: 'slack:v1:T1:C2:100.1',
      source: 'chat',
      sessionType: 'chat',
      kind: 'chat',
      model: null,
      started_at: 1_700_000_500,
      last_message_at: 1_700_000_900,
      message_count: 4,
      tool_call_count: 0,
      conversation_message_count: 4,
      last_assistant_content: null,
      agentIds: ['slack:v1:T1:C2:100.1'],
      platform: 'slack',
    };
    const app = makeApp(
      fakeReader({
        async listSessions() {
          return { sessions: [chatRow, sampleMeta], nextCursor: null };
        },
      }),
    );
    const res = await app.request('/admin/api/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: SessionMeta[] };
    expect(body.sessions.map((s) => s.kind)).toEqual(['chat', 'run']);
    expect(body.sessions[0]!.agentIds).toEqual(['slack:v1:T1:C2:100.1']);
    expect(body.sessions[0]!.platform).toBe('slack');
  });

  it('GET /admin/api/sessions/:id unknown → 404', async () => {
    const app = makeApp(fakeReader());
    const res = await app.request('/admin/api/sessions/nope');
    expect(res.status).toBe(404);
  });

  it('GET /admin/api/sessions/:id/messages unknown → 200 empty (source none)', async () => {
    const app = makeApp(fakeReader());
    const res = await app.request('/admin/api/sessions/nope/messages');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; messages: unknown[] };
    expect(body.source).toBe('none');
    expect(body.messages).toEqual([]);
  });

  it('kind=agent selects the chat-agent transcript stream', async () => {
    let usedKind: string | undefined;
    const app = makeApp(
      fakeReader({
        async exists() {
          return true;
        },
        async readTranscript(_id, opts) {
          usedKind = opts?.kind;
          return transcript;
        },
      }),
    );
    const res = await app.request('/admin/api/sessions/thread-7/messages?kind=agent');
    expect(res.status).toBe(200);
    expect(usedKind).toBe('agent');
  });

  it('operator auth gates the session routes → 401 without a token', async () => {
    const SECRET = 'sek';
    const app = createApp({
      sessionReader: fakeReader(),
      authConfig: { password: 'pw', secret: SECRET },
      serveDashboard: false,
    });
    const res = await app.request('/admin/api/sessions');
    expect(res.status).toBe(401);

    const token = createToken(SECRET, 'password');
    const ok = await app.request('/admin/api/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });
});

// ── Stats — /admin/api/stats backed by an INJECTED fake StatsReader (Phase 7 s2) ─
// The route aggregates the app-owned `executions` rollups into the dashboard +
// CLI shape. All offline: a fake StatsReader backs the route, no on-disk store.
describe('stats endpoint with injected StatsReader (offline)', () => {
  const phaseRows: RollupRow[] = [
    { key: 'executor', count: 3, totalCost: 4.5, inputTokens: 600, outputTokens: 120, totalTokens: 720 },
    { key: 'architect', count: 1, totalCost: 0.5, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  ];
  const workflowRows: RollupRow[] = [
    { key: 'build', count: 3, totalCost: 4.0, inputTokens: 500, outputTokens: 100, totalTokens: 600 },
    { key: 'pr-review', count: 1, totalCost: 1.0, inputTokens: 200, outputTokens: 40, totalTokens: 240 },
  ];
  const totals: StatsTotals = { count: 4, totalCost: 5.0, inputTokens: 700, outputTokens: 140, totalTokens: 840 };

  const fakeStats = (over: Partial<StatsReader> = {}): StatsReader => ({
    byPhase: () => phaseRows,
    byWorkflow: () => workflowRows,
    byRun: () => [],
    totals: () => totals,
    todayCount: () => 2,
    dailyStats: () => [],
    hourlyStats: () => [],
    listExecutions: () => [],
    ...over,
  });

  function statsApp(reader: StatsReader) {
    return createApp({
      statsReader: reader,
      authConfig: { password: '', secret: 'x' },
      serveDashboard: false,
    });
  }

  it('aggregates rollups + the CLI surface', async () => {
    const app = statsApp(fakeStats());
    const res = await app.request('/admin/api/stats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.total_executions).toBe(4);
    expect(body.today_count).toBe(2);
    expect(body.running).toBe(0);
    // by_skill (CLI shape) keyed by workflow; count real, success/fail run-level → 0.
    expect(body.by_skill.build).toEqual({ count: 3, success: 0, fail: 0 });
    expect(body.byPhase[0].key).toBe('executor');
    expect(body.byWorkflow[1].key).toBe('pr-review');
    expect(body.totals.totalCost).toBeCloseTo(5.0);
  });

  it('empty store → honest zeros (not fabricated)', async () => {
    const app = statsApp(
      fakeStats({
        byPhase: () => [],
        byWorkflow: () => [],
        byRun: () => [],
        totals: () => ({ count: 0, totalCost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        todayCount: () => 0,
      }),
    );
    const res = await app.request('/admin/api/stats');
    const body = (await res.json()) as Record<string, any>;
    expect(body.total_executions).toBe(0);
    expect(body.today_count).toBe(0);
    expect(body.by_skill).toEqual({});
    expect(body.byPhase).toEqual([]);
  });

  it('operator auth gates the stats route → 401 without a token', async () => {
    const SECRET = 'sek';
    const app = createApp({
      statsReader: fakeStats(),
      authConfig: { password: 'pw', secret: SECRET },
      serveDashboard: false,
    });
    const res = await app.request('/admin/api/stats');
    expect(res.status).toBe(401);

    const token = createToken(SECRET, 'password');
    const ok = await app.request('/admin/api/stats', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });

  it('buildStatsResponse is a pure aggregator', () => {
    const body = buildStatsResponse(fakeStats());
    expect(body.total_executions).toBe(4);
    expect(body.by_skill['pr-review']).toEqual({ count: 1, success: 0, fail: 0 });
    expect(body.byPhase).toBe(phaseRows);
  });
});
