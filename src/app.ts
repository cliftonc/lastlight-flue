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

// ── Last Light on Flue · server composition (Phase 2) ────────────────────────
//
// `src/app.ts`'s default export OWNS the request pipeline of the built Node
// server (`dist/server.mjs`); the generated entry validates it has `.fetch`,
// then calls `serve({ fetch: app.fetch, port: PORT||3000 })` and registers its
// OWN SIGINT/SIGTERM handlers (see PROGRESS.md "Shutdown/signal finding" and
// flue-reference §0). So `app.ts` does NOT call `listen()` and CANNOT own the
// top-level signal traps — graceful shutdown of app-owned resources (crons, db)
// must hang off a custom Node entry in a later slice (see NEXT in PROGRESS.md).
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
 *  login flow probe this to discover available auth methods. Real values come
 *  from config in the auth slice; for now report the unconfigured baseline. */
export function authRequiredBody() {
  // TODO(phase-2/admin-auth-slice): source `required` from
  // config.adminPassword and slackOAuth/githubOAuth from configured providers.
  return { required: false, slackOAuth: false, githubOAuth: false } as const;
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
  // SEAM (auth slice): operator auth middleware mounts here —
  //   TODO(phase-2/operator-auth): app.use('/admin/api/*', requireOperator);
  // These routes are operator-only by contract; this slice does NOT build the
  // middleware, only leaves the single attach point. `auth-required` MUST stay
  // unauthenticated (it's read to learn HOW to authenticate) — keep it ABOVE
  // any `requireOperator` mount, or exempt it explicitly.

  // `auth-required` is unauthenticated by contract (the CLI/dashboard read it
  // to learn HOW to authenticate) — implement now so `lastlight status` works.
  app.get('/admin/api/auth-required', (c) => c.json(authRequiredBody()));

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

  // Genuinely-Phase-7 routes (not backable by listRuns/getRun/listAgents):
  // per-phase stats rollups, session transcripts (EventStreamStore), and the
  // approvals queue (app run-store pendingGate). Stay 501 — honest, not fake.
  for (const path of [
    '/admin/api/stats',
    '/admin/api/sessions',
    '/admin/api/approvals',
  ] as const) {
    app.get(path, (c) =>
      c.json({ error: 'not_implemented', route: path, slice: 'phase-7' }, 501),
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
const app = createApp({ runsReader: liveRunsReader });
app.route('/', flue());

export default app;
