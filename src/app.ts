import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

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
// Phase-2 slice 1 (this file): the real composition SHAPE the rest of Phase 2
// builds on — `createApp()` (app-owned routes, unit-testable WITHOUT flue()),
// plus the default export that mounts `flue()` beside it. Real `/api/*`,
// `/admin/api/*`, crons, auth middleware and the boot/preflight sequence land
// in later Phase-2 slices and Phase 7; their seams are marked below.

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

/**
 * Compose the APPLICATION-OWNED surface onto a Hono app: `/health`, the status
 * probe, and the seams where `/api/*` and `/admin/api/*` routers attach in
 * later slices. This factory does NOT mount `flue()` — that keeps the
 * app-owned routes importable and testable in-process WITHOUT build-generated
 * wiring or spinning up Flue's coordinators (`createApp()` in tests).
 */
export function createApp(): Hono {
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
  //    surface). Re-backed by listRuns/getRun/listAgents + the app run record
  //    in Phase 7; thin pass-through in a later Phase-2 slice. ───────────────
  //
  // SEAM: operator auth middleware mounts here, e.g.
  //   app.use('/admin/api/*', requireOperator);   // skips /health, /login

  // `auth-required` is unauthenticated by contract (the CLI/dashboard read it
  // to learn HOW to authenticate) — implement now so `lastlight status` works.
  app.get('/admin/api/auth-required', (c) => c.json(authRequiredBody()));

  // Data routes deferred to Phase 7 (run/session/stats re-back). 501, not fake.
  for (const path of [
    '/admin/api/runs',
    '/admin/api/workflow-runs',
    '/admin/api/agents',
    '/admin/api/stats',
    '/admin/api/sessions',
    '/admin/api/approvals',
  ] as const) {
    app.get(path, (c) =>
      c.json(
        { error: 'not_implemented', route: path, slice: 'phase-2/admin-thin + phase-7' },
        501,
      ),
    );
  }

  return app;
}

// ── Default export = the deploy entrypoint the built server consumes ─────────
// `app.route('/', flue())` mounts Flue's public routes (/agents, /workflows,
// /runs, /channels/*) BESIDE the app-owned surface above — one Hono app, one
// listener, one port (PORT||3000; set PORT=8644 to preserve Last Light's port).
const app = createApp();
app.route('/', flue());

export default app;
