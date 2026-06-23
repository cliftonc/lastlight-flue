import { flue } from '@flue/runtime/routing';
import { getRun, listAgents, listRuns } from '@flue/runtime';
import { Hono } from 'hono';
import type { RunStatus } from '@flue/runtime';
import {
  toAgentSummary,
  toRunDetail,
  toRunSummary,
  type RunsReader,
} from './admin/runs-reader.ts';
import {
  loginHandler,
  operatorAuthConfigFromEnv,
  requireOperator,
  type OperatorAuthConfig,
} from './admin/auth.ts';
import { mountDashboard } from './admin/dashboard.ts';
import {
  createDefaultApprovalsBackend,
  type ApprovalsBackend,
} from './admin/approvals.ts';
import {
  createDefaultSessionReader,
  toTranscriptMessages,
  type SessionReader,
} from './admin/session-reader.ts';
import {
  buildStatsResponse,
  createDefaultStatsReader,
  type StatsReader,
} from './admin/stats-reader.ts';
import { recoverOrphanRuns } from './resume.ts';
import { recoverOrphanExploreRuns } from './resume-explore.ts';
import { startCrons, stopCrons } from './crons.ts';
import { startOtel } from './otel.ts';

// ── Last Light on Flue · server composition (Phase 2) ────────────────────────
//
// `src/app.ts`'s default export OWNS the request pipeline of the built Node
// server (`dist/server.mjs`); the generated entry validates it has `.fetch`,
// then calls `serve({ fetch: app.fetch, port: PORT||3000 })` and registers its
// OWN SIGINT/SIGTERM handlers (see PROGRESS.md "Shutdown/signal finding" and
// flue-reference §0). So `app.ts` does NOT call `listen()` and is NOT the
// AUTHORITATIVE signal trap. Graceful shutdown of app-owned resources is
// FINALIZED (Phase 5) as ADDITIVE `process.on('SIGTERM'|'SIGINT', …)` handlers
// in this module's scope (they run alongside Flue's generated-entry handler,
// which owns agent/db shutdown + process.exit) — NOT a forked server entry. The
// crons.stop() handler is registered at the bottom of this file.
//
// Phase-2 slice 1 (foundation): the real composition SHAPE the rest of Phase 2
// builds on — `createApp()` (app-owned routes, unit-testable WITHOUT flue()),
// plus the default export that mounts `flue()` beside it.
//
// Phase-2 slice 2 (this slice): the THIN `/admin/api/*` READ pass-through over
// Flue's `listRuns`/`getRun`/`listAgents` inspection primitives. `createApp`
// now takes an optional `RunsReader` seam (see src/admin/runs-reader.ts): the
// default export injects the real Flue free functions, and tests inject a fake —
// because those functions THROW "runtime not configured" outside a Flue-built
// server entry (verified), so the routes can't be exercised offline otherwise.
// Trigger routes (`/api/*`) + crons + auth middleware + boot/preflight land in
// later Phase-2 slices; stats/sessions/approvals stay 501 (Phase 7). Seams below.

/** Process start time — basis for `/health` uptime. */
const STARTED_AT = Date.now();

/**
 * Server version. The built server reads only env present at start, and
 * `.env` is build-time only, so we surface a coarse version string. A later
 * slice can wire this to package.json at build time; for now `LASTLIGHT_VERSION`
 * (or `npm_package_version`) overrides the `0.0.0` default.
 */
const VERSION =
  process.env.LASTLIGHT_VERSION ?? process.env.npm_package_version ?? '0.0.0';

export interface HealthBody {
  /** Preserved Last Light shape: `lastlight status` and the dashboard probe
   *  this field; legacy server returned `{ status: "ok", ... }`. */
  status: 'ok';
  ok: true;
  version: string;
  /** Whole seconds since process start. */
  uptime: number;
}

/** Build the `/health` body. Shallow by design (Q2.4): "process up" only —
 *  a `lastlight status` / dashboard poll every ~5s must not load the db. A
 *  deep readiness probe (db reachable, crons registered) is a later concern. */
export function healthBody(now: number = Date.now()): HealthBody {
  return {
    status: 'ok',
    ok: true,
    version: VERSION,
    uptime: Math.floor((now - STARTED_AT) / 1000),
  };
}

/** `/admin/api/auth-required` body — the CLI `status` command and the dashboard
 *  login flow probe this to discover available auth methods. `required` is true
 *  when an operator password is configured (auth is enforced); `slackOAuth` /
 *  `githubOAuth` reflect configured OAuth providers. OAuth is not ported until
 *  Phase 6, so they are `false` (TODO below), never fabricated. */
export function authRequiredBody(auth: OperatorAuthConfig) {
  return {
    required: Boolean(auth.password),
    // TODO(phase-6/admin-oauth): source from configured Slack/GitHub OAuth
    // providers once OAuth login is ported. Config does not model these yet.
    slackOAuth: false,
    githubOAuth: false,
  };
}

/** Optional dependencies injected into the app-owned surface. */
export interface CreateAppOptions {
  /**
   * The Flue-data seam backing `/admin/api/*` reads. Injected so the routes are
   * testable WITHOUT a running Flue runtime (the real `listRuns`/`getRun`/
   * `listAgents` throw "runtime not configured" in-process). When omitted, the
   * admin DATA routes return 501 — they only light up once a reader is wired
   * (the default export wires the real Flue functions). `auth-required` is
   * always mounted, reader or not.
   */
  runsReader?: RunsReader;
  /**
   * Operator-auth config gating `/admin/api/*` (password + token-signing
   * secret). Defaults to `operatorAuthConfigFromEnv()` (reads `ADMIN_PASSWORD` /
   * `ADMIN_SECRET`). Tests inject an explicit config to exercise enabled vs
   * disabled auth without touching env. When `password` is empty, auth is
   * DISABLED (dev/fresh install) — the reference behaviour.
   */
  authConfig?: OperatorAuthConfig;
  /**
   * Serve the prebuilt admin dashboard SPA under `/admin` (static assets +
   * SPA fallback to index.html). Defaults to `true` for the live wiring. Tests
   * that only exercise the JSON surface pass `false` (or an explicit
   * `dashboardRoot`) so they don't depend on the committed `dashboard/dist`.
   * The shell/assets are PUBLIC — mounted AFTER `/admin/api/*` so the API and
   * its operator-auth middleware are never shadowed by the static serving.
   */
  serveDashboard?: boolean;
  /** Override the dashboard assets root (absolute path). Tests inject a fixture. */
  dashboardRoot?: string;
  /**
   * The approvals backend gating the durable build gate (Phase 4 · resume wiring):
   * lists PAUSED build runs (pending gates) and maps approve/reject to
   * `resume(runId, decision)`. Mounted under `/admin/api/*` (operator-auth gated).
   * Injected so the routes are testable offline with a fake store + fake resume.
   * When omitted, the approvals routes 501 (honest) — the default export wires the
   * real build-run-store-backed backend.
   */
  approvals?: ApprovalsBackend;
  /**
   * The session/transcript data layer backing `/admin/api/sessions` (Phase 7).
   * Lists workflow-run sessions blob-free (via `RunStore.listRuns`) and reads a
   * session's transcript from Flue's durable `EventStreamStore`
   * (`runStreamPath`/`agentStreamPath`), mapping its events → the dashboard's
   * transcript shape. Injected so the routes test OFFLINE with a fake (the real
   * Flue stores throw outside a configured runtime). When omitted, the session
   * routes 501 (honest) — the default export wires the real Flue-backed reader.
   */
  sessionReader?: SessionReader;
  /**
   * The per-phase STATS data layer backing `/admin/api/stats` (Phase 7 · slice 2).
   * Rolls up the app-owned `executions` table (cost/tokens per phase/workflow,
   * totals) into the dashboard + `lastlight stats` CLI shape. Injected so the
   * route tests OFFLINE with a fake. When omitted, `/admin/api/stats` 501s
   * (honest) — the default export wires the on-disk stats-store reader.
   */
  statsReader?: StatsReader;
}

/**
 * Compose the APPLICATION-OWNED surface onto a Hono app: `/health`, the status
 * probe, `/admin/api/*` reads (when a `runsReader` is injected), and the seams
 * where `/api/*` and operator-auth attach in later slices. This factory does
 * NOT mount `flue()` — that keeps the app-owned routes importable and testable
 * in-process WITHOUT build-generated wiring or Flue's coordinators.
 */
export function createApp(opts: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const authConfig = opts.authConfig ?? operatorAuthConfigFromEnv();

  // ── /health — app-owned, UNAUTHENTICATED (CLI `status` + dashboard poll) ──
  app.get('/health', (c) => c.json(healthBody()));

  // ── /api/* — Last-Light-owned trigger surface (distinct from Flue's
  //    /agents, /workflows). Real handlers in the trigger-routes slice. ──────
  //
  // SEAM: a later slice mounts bearer auth here, e.g.
  //   app.use('/api/*', requireBearer);
  // then `mountApi(app)` registers POST /api/run, /api/build, /api/chat which
  // call invoke()/dispatch() (the envelope-bypass dispatch path, spec/03).

  // `/api/status` — extended status the dashboard/CLI can read beside /health.
  // Kept thin (no db) this slice; returns the same readiness view as /health.
  app.get('/api/status', (c) => c.json(healthBody()));

  // Not-yet-ported trigger routes — return 501 so callers get an honest
  // "not implemented here yet" rather than fabricated success. Replaced by the
  // real invoke()/dispatch() handlers in the Phase-2 trigger-routes slice.
  for (const path of ['/api/run', '/api/build', '/api/chat'] as const) {
    app.post(path, (c) =>
      c.json(
        { error: 'not_implemented', route: path, slice: 'phase-2/trigger-routes' },
        501,
      ),
    );
  }

  // ── /admin/api/* — 100% application-owned (Flue ships no admin HTTP
  //    surface). THIN read pass-through over listRuns/getRun/listAgents this
  //    slice; the FULL re-back (app run-store join: phasesDone/pendingGate/
  //    stats/thread-grouping + EventStreamStore transcripts) is Phase 7. ──────
  //
  // OPERATOR AUTH (this slice): the ported HMAC-bearer middleware gates the
  // whole prefix. It is mounted ONCE here, BEFORE any /admin/api route, so it
  // runs for every admin request. The middleware itself EXEMPTS the public-by-
  // contract paths (`auth-required`, `login`) — see `requireOperator` /
  // `isPublicAuthPath` in src/admin/auth.ts — so those stay reachable without a
  // token (the CLI/dashboard read auth-required to learn HOW to authenticate,
  // and POST login to obtain a token). When no password is configured, auth is
  // disabled and everything passes through (reference behaviour).
  app.use('/admin/api/*', requireOperator(authConfig));

  // `auth-required` is unauthenticated by contract — reports REAL config now
  // (required = password set; OAuth flags false until Phase 6). Exempted by the
  // middleware above.
  app.get('/admin/api/auth-required', (c) => c.json(authRequiredBody(authConfig)));

  // `login` (password → signed token). Also exempted by the middleware so the
  // dashboard/CLI can obtain a token. Part of the same coherent auth unit.
  app.post('/admin/api/login', loginHandler(authConfig));

  // ── Admin DATA reads — backed by the injected RunsReader seam ─────────────
  // Only mounted when a reader is provided (default export wires the real Flue
  // functions; tests inject a fake). Without one the routes 501 like the
  // genuinely-Phase-7 routes below — honest, never fabricated.
  const reader = opts.runsReader;
  if (reader) {
    // Run list. Both `/runs` and `/workflow-runs` map to the SAME listRuns
    // pass-through — `src/cli.ts` + the dashboard call `/admin/api/workflow-runs`
    // (with filters workflow/status/limit), so we serve both aliases. Returns
    // the legacy `{ workflowRuns, total }` envelope (blob-free: listRuns excludes
    // payload/result/error natively — we never load event streams in the list
    // path). NOTE(phase-7): `total` here is the page count, not a global count —
    // Flue's listRuns is cursor-paged, not offset/total. The app run-store will
    // own a true total + offset paging in Phase 7; `nextCursor` is surfaced now.
    const handleList = async (c: import('hono').Context) => {
      const limitRaw = c.req.query('limit');
      const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 20, 1), 1000) : undefined;
      const workflowName = c.req.query('workflow') || undefined;
      const statusRaw = c.req.query('status');
      // Map the dashboard's status vocabulary back to Flue's where it's a clean
      // 1:1; ambiguous values (paused/cancelled — app-run-store concepts) are
      // ignored as a filter this slice (TODO(phase-7)).
      const statusMap: Record<string, RunStatus> = {
        running: 'active',
        active: 'active',
        succeeded: 'completed',
        completed: 'completed',
        failed: 'errored',
        errored: 'errored',
      };
      const status = statusRaw ? statusMap[statusRaw] : undefined;
      const cursor = c.req.query('cursor') || undefined;
      const res = await reader.listRuns({ limit, workflowName, status, cursor });
      const workflowRuns = res.runs.map(toRunSummary);
      return c.json({
        workflowRuns,
        total: workflowRuns.length, // TODO(phase-7): true global total via app run-store
        nextCursor: res.nextCursor ?? null,
      });
    };
    app.get('/admin/api/runs', handleList);
    app.get('/admin/api/workflow-runs', handleList);

    // Run detail → getRun(id); 404 when absent. Legacy envelope `{ workflowRun }`.
    const handleDetail = async (c: import('hono').Context) => {
      const id = c.req.param('id') ?? '';
      const run = await reader.getRun(id);
      if (!run) return c.json({ error: 'workflow run not found' }, 404);
      return c.json({ workflowRun: toRunDetail(run) });
    };
    app.get('/admin/api/runs/:id', handleDetail);
    app.get('/admin/api/workflow-runs/:id', handleDetail);

    // Agents list → listAgents(). New surface; Flue's manifest is the source.
    app.get('/admin/api/agents', async (c) => {
      const agents = await reader.listAgents();
      return c.json({ agents: agents.map(toAgentSummary) });
    });
  }

  // ── Approvals — the durable build gate (Phase 4 · resume wiring) ──────────
  // Backed by the injected ApprovalsBackend seam (build run-store + resume).
  // Operator-auth gated by the `/admin/api/*` middleware above. Matches the CLI
  // contract (`src/cli.ts` cmdApprovals): GET lists paused runs; POST
  // `:id/respond { decision: 'approved'|'rejected' }` maps to resume(approve|reject).
  // Without a backend the routes 501 (honest) — wired by the default export.
  const approvals = opts.approvals;
  if (approvals) {
    app.get('/admin/api/approvals', async (c) => {
      const rows = await approvals.list();
      return c.json({ approvals: rows });
    });
    app.post('/admin/api/approvals/:id/respond', async (c) => {
      const id = c.req.param('id') ?? '';
      const body = await c.req
        .json<{ decision?: string }>()
        .catch((): { decision?: string } => ({}));
      // The CLI sends 'approved'/'rejected'; map to the resume decision.
      const decision =
        body.decision === 'approved'
          ? 'approve'
          : body.decision === 'rejected'
            ? 'reject'
            : null;
      if (!decision) {
        return c.json({ error: 'decision must be "approved" or "rejected"' }, 400);
      }
      const result = await approvals.respond(id, decision);
      if (!result) return c.json({ error: 'approval not found' }, 404);
      return c.json(result);
    });
  } else {
    app.get('/admin/api/approvals', (c) =>
      c.json({ error: 'not_implemented', route: '/admin/api/approvals', slice: 'phase-4 (no approvals backend wired)' }, 501),
    );
  }

  // ── Sessions / transcripts — Flue durable store (Phase 7 · slice 1) ───────
  // Backed by the injected SessionReader seam (RunStore.listRuns for the
  // blob-free session LIST + EventStreamStore.readEvents for a session's
  // TRANSCRIPT, mapped to the dashboard's message shape). Operator-auth gated by
  // the `/admin/api/*` middleware above. Matches the reference dashboard's
  // response envelopes (`{ sessions, liveCount }` / `{ session }` /
  // `{ source, messages, last_id }`). Without a reader the routes 501 (honest) —
  // the default export wires the real Flue-backed reader.
  const sessionReader = opts.sessionReader;
  if (sessionReader) {
    // Session list — blob-free (listRuns pointers; NO transcript read). Mirrors
    // the reference `{ sessions, liveCount }` shape; `liveCount` is 0 here
    // (container-liveness is a sandbox concern not modelled this slice).
    app.get('/admin/api/sessions', async (c) => {
      const limitRaw = c.req.query('limit');
      const limit = limitRaw
        ? Math.min(Math.max(parseInt(limitRaw, 10) || 200, 1), 1000)
        : undefined;
      const cursor = c.req.query('cursor') || undefined;
      const res = await sessionReader.listSessions({ limit, cursor });
      return c.json({
        sessions: res.sessions,
        liveCount: 0,
        nextCursor: res.nextCursor,
      });
    });

    // Single session meta. 404 when the id resolves to no run/agent stream.
    app.get('/admin/api/sessions/:id', async (c) => {
      const id = c.req.param('id') ?? '';
      if (!(await sessionReader.exists(id))) {
        return c.json({ error: 'session not found' }, 404);
      }
      // Derive live counts from the transcript (the list path stays blob-free).
      const kind = c.req.query('kind') === 'agent' ? 'agent' : 'run';
      const t = await sessionReader.readTranscript(id, { kind });
      const messages = toTranscriptMessages(t.events);
      const toolCount = messages.reduce(
        (n, m) => n + (m.tool_calls?.length ?? 0),
        0,
      );
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === 'assistant' && typeof m.content === 'string');
      const model = messages.find((m) => m.model)?.model ?? null;
      return c.json({
        session: {
          id,
          source: kind === 'agent' ? 'chat' : 'run',
          sessionType: kind === 'agent' ? 'chat' : 'run',
          model,
          message_count: messages.length,
          tool_call_count: toolCount,
          conversation_message_count: messages.length,
          last_assistant_content:
            typeof lastAssistant?.content === 'string' ? lastAssistant.content : null,
          agentIds: [],
        },
      });
    });

    // Transcript — the durable event stream mapped to the dashboard's messages.
    // Mirrors the reference `{ source, messages, last_id }`; `last_id` here is
    // the stream's resume offset (catch-up read; SSE-follow reuses GET /runs/:id).
    app.get('/admin/api/sessions/:id/messages', async (c) => {
      const id = c.req.param('id') ?? '';
      if (!(await sessionReader.exists(id))) {
        return c.json({ source: 'none', messages: [], last_id: null });
      }
      const kind = c.req.query('kind') === 'agent' ? 'agent' : 'run';
      const since = c.req.query('since') || undefined;
      const t = await sessionReader.readTranscript(id, { kind, offset: since });
      const messages = toTranscriptMessages(t.events).map((m, i) => ({ id: i, ...m }));
      return c.json({ source: 'flue', messages, last_id: t.nextOffset });
    });
  }

  // ── Stats — per-phase cost/token rollups (Phase 7 · slice 2) ──────────────
  // Backed by the injected StatsReader seam (the app-owned `executions` table,
  // src/stats-store.ts). Operator-auth gated by the `/admin/api/*` middleware
  // above. Returns the CLI's `{ total_executions, today_count, running,
  // by_skill }` surface PLUS the richer `{ byPhase, byWorkflow, byRun, totals }`
  // rollups the dashboard shows. An EMPTY store returns honest ZEROS (never
  // fabricated). Without a reader the route 501s (honest) — the default export
  // wires the real on-disk-stats-store reader.
  const statsReader = opts.statsReader;
  if (statsReader) {
    app.get('/admin/api/stats', (c) => c.json(buildStatsResponse(statsReader)));
  } else {
    app.get('/admin/api/stats', (c) =>
      c.json(
        { error: 'not_implemented', route: '/admin/api/stats', slice: 'phase-7 (no stats reader wired)' },
        501,
      ),
    );
  }
  // No session reader wired (e.g. createApp() with no opts in a unit test) →
  // 501 the session routes so the surface is complete and honest.
  if (!sessionReader) {
    app.get('/admin/api/sessions', (c) =>
      c.json({ error: 'not_implemented', route: '/admin/api/sessions', slice: 'phase-7 (no session reader wired)' }, 501),
    );
  }
  // When no reader is injected (e.g. createApp() with no opts in a unit test),
  // the data routes above were never mounted — 501 them too so the surface is
  // complete and honest regardless of wiring.
  if (!reader) {
    for (const path of [
      '/admin/api/runs',
      '/admin/api/workflow-runs',
      '/admin/api/agents',
    ] as const) {
      app.get(path, (c) =>
        c.json(
          { error: 'not_implemented', route: path, slice: 'phase-2/admin-thin (no reader wired)' },
          501,
        ),
      );
    }
  }

  // ── Admin dashboard SPA (Phase 2 · slice 5) ──────────────────────────────
  // Serve the prebuilt Vite SPA under `/admin` (static assets + SPA fallback).
  // Mounted LAST — after every `/admin/api/*` route + the operator-auth
  // middleware — so the static/fallback serving cannot shadow the JSON API,
  // /health, /api/*, or Flue's routes. Public by design (the SPA logs in via
  // /admin/api/login itself). Off by default ONLY in opts where a test asks; the
  // live default export turns it on.
  if (opts.serveDashboard ?? true) {
    mountDashboard(app, opts.dashboardRoot);
  }

  return app;
}

// ── Default export = the deploy entrypoint the built server consumes ─────────
// `app.route('/', flue())` mounts Flue's public routes (/agents, /workflows,
// /runs, /channels/*) BESIDE the app-owned surface above — one Hono app, one
// listener, one port (PORT||3000; set PORT=8644 to preserve Last Light's port).
//
// The real Flue inspection primitives back the admin reads here. They THROW
// "runtime not configured" if called OUTSIDE a Flue-built server entry, so we
// pass them through directly (not invoked) — inside the built server they read
// the configured run store, and the throw can only surface at request time, not
// at import. Tests use `createApp({ runsReader: fake })` and never touch these.
const liveRunsReader: RunsReader = { listRuns, getRun, listAgents };
const app = createApp({
  runsReader: liveRunsReader,
  approvals: createDefaultApprovalsBackend(),
  sessionReader: createDefaultSessionReader(),
  statsReader: createDefaultStatsReader(),
});
app.route('/', flue());

// ── Boot orphan recovery (Phase 4 · resume wiring) ───────────────────────────
// Flue does NOT recover workflows on Node (flue-reference §0); durability is
// app-owned. On a fresh server start we reconcile the build run-store: re-invoke
// every `status='active'` run that crashed mid-phase (idempotent — phasesDone
// skips completed phases) and LEAVE `paused` runs for a human (slice-1 semantics).
// The restart-count breaker in build.ts caps a wedged run at MAX_RESTART_RESUMES.
//
// WHERE THIS RUNS: app.ts's module scope is evaluated at boot — the generated
// `dist/server.mjs` inlines it and owns serve()/listen() (flue-reference §0). So
// this fires ONCE, at module-eval, BEFORE listen returns. It is:
//   - run-once: a module-level guard (`bootRecoveryStarted`) so a re-import (HMR /
//     test double-import) can't double-trigger it;
//   - non-blocking: kicked off as a detached promise — listen() is NOT awaited on
//     it, so a slow recovery never delays the server accepting requests;
//   - non-fatal: errors are logged, never thrown, so a recovery failure can't
//     crash the server entry.
// CAVEAT: in unit tests app.ts is imported (createApp is exercised), which would
// also trigger this. It is suppressed when LASTLIGHT_SKIP_BOOT_RECOVERY is set OR
// when not running a real server (vitest sets VITEST=true) — see runBootRecovery.
let bootRecoveryStarted = false;
function runBootRecovery(): void {
  if (bootRecoveryStarted) return;
  bootRecoveryStarted = true;
  // Skip in test/import contexts: only the real built server should reconcile.
  if (process.env.LASTLIGHT_SKIP_BOOT_RECOVERY === '1' || process.env.VITEST) {
    return;
  }
  void recoverOrphanRuns()
    .then((ids) => {
      if (ids.length) {
        console.log(`[boot] recovered ${ids.length} orphaned build run(s): ${ids.join(', ')}`);
      }
    })
    .catch((err: unknown) => {
      console.error('[boot] orphan recovery failed (non-fatal):', err);
    });
  // Same reconciliation for the explore run-store: re-invoke `active` orphans (a
  // crash mid-research), LEAVE `paused` runs (those await a human reply in the
  // thread). The explore restart-count breaker caps a wedged run.
  void recoverOrphanExploreRuns()
    .then((ids) => {
      if (ids.length) {
        console.log(`[boot] recovered ${ids.length} orphaned explore run(s): ${ids.join(', ')}`);
      }
    })
    .catch((err: unknown) => {
      console.error('[boot] explore orphan recovery failed (non-fatal):', err);
    });
}
runBootRecovery();

// ── OpenTelemetry observability wiring (Phase 7 · slice 3) ────────────────────
// Register the `@flue/opentelemetry` adapter onto Flue's `observe(...)` live
// stream, fed by `LASTLIGHT_OTEL_*` env — armed HERE at module-eval, alongside
// the boot-recovery + cron hooks. `startOtel()` is:
//   - ENABLED-gated: only subscribes when LASTLIGHT_OTEL_ENABLED is truthy;
//     otherwise COMPLETELY INERT (no adapter, no exporter, no error);
//   - run-once (a module-level guard) so a re-import can't double-register;
//   - NON-FATAL: a bad OTel config logs a warning, never crashes the server
//     (strict-off warns; even a strict rethrow is caught at this boot hook);
//   - SKIPPED under VITEST / LASTLIGHT_SKIP_OTEL so tests/imports never start an
//     exporter or subscribe to the live stream. See src/otel.ts.
startOtel();

// ── Cron scheduler start + graceful shutdown (Phase 5 · FINAL slice) ──────────
// The four scheduled jobs (cron-health/security/triage/review → repo-health/
// security-review/issue-triage/pr-review, each fanning out over the managed
// repos) are armed HERE at module-eval, alongside the boot-recovery hook above —
// run-once, non-blocking (croner schedules its own timers), non-fatal, and
// SKIPPED under VITEST/LASTLIGHT_SKIP_CRONS (see startCrons). See src/crons.ts.
startCrons();

// GRACEFUL SHUTDOWN — FINALIZED DECISION (flue-reference §0 + the slice-2/5
// leaning): an ADDITIVE `process.on('SIGTERM'|'SIGINT', …)` handler that stops
// the crons. This is NOT a forked server entry. The GENERATED `dist/server.mjs`
// owns serve()/listen() AND its own SIGINT/SIGTERM handler (agentCoordinator
// shutdown + persistence close + process.exit) — Node signal handlers are
// ADDITIVE, so the handler below runs TOO, before Flue's async shutdown finishes,
// and halts every cron timer so no new tick fires mid-shutdown. It is non-fatal
// (stopCrons swallows + logs) and does NOT call process.exit (Flue owns exit
// timing). Suppressed under tests so the in-process Vitest worker isn't trapped.
if (!process.env.VITEST && process.env.LASTLIGHT_SKIP_CRONS !== '1') {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      stopCrons();
    });
  }
}

export default app;
