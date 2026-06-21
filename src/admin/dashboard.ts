import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

// ── Admin dashboard SPA serving (Phase 2 · slice 5) ──────────────────────────
//
// Serve the PREBUILT Last Light admin dashboard (a Vite SPA, committed at
// `dashboard/dist/`) from the same Hono app, preserving the reference's layout:
// the dashboard lives under `/admin` and the SPA's Vite `base` is `/admin/` (so
// its assets reference `/admin/assets/*` + `/admin/logo.png`). This MUST NOT
// shadow `/admin/api/*` (the operator API) — it's mounted on `/admin/*` only,
// AFTER the admin API routes, so Hono's first-match-wins ordering lets the API
// win for `/admin/api/...`. The SHELL + assets are PUBLIC (no operator auth):
// the SPA itself obtains a token via /admin/api/login and then calls the API
// with it. (Matches ~/work/lastlight/src/admin/index.ts.)
//
// ASSET PATH: `@hono/node-server`'s serveStatic resolves `root` relative to
// `process.cwd()` (it `join(root, reqPath)`s and reads from disk). CWD-relative
// is fragile across `flue dev` (tsx, cwd=repo root) and the built
// `dist/server.mjs` (cwd=repo root, but module file under dist/). We instead
// resolve an ABSOLUTE root from a set of candidate locations and pass that —
// `join(absoluteRoot, …)` is stable regardless of cwd.

/** Where the SPA is mounted. The committed assets' Vite `base` is `/admin/`. */
export const DASHBOARD_MOUNT = '/admin';

/**
 * The route prefixes the dashboard static/SPA-fallback serving must NOT handle
 * (they belong to the API + Flue + health surfaces). The SPA is mounted only on
 * `/admin/*`, and `/admin/api/*` is registered BEFORE it, so in practice only
 * `/admin/api` could collide — but this list documents the full set of
 * non-SPA prefixes and powers the unit-testable routing decision below.
 */
export const NON_SPA_PREFIXES = [
  '/admin/api',
  '/api',
  '/health',
  '/agents',
  '/workflows',
  '/runs',
  '/channels',
  '/openapi.json',
] as const;

/**
 * Pure routing decision: should the SPA fallback (serve index.html) handle this
 * path? True only for `/admin` paths that are NOT the API prefix and NOT a
 * concrete asset request (assets are served by serveStatic before the fallback;
 * this models "an unknown /admin/* client route → index.html"). Kept pure +
 * exported so the fallback decision is unit-testable without booting serveStatic
 * (whose disk reads can't be exercised purely via app.request for a miss).
 */
export function isSpaFallbackPath(path: string): boolean {
  // Only /admin and /admin/* are owned by the SPA at all.
  if (path !== DASHBOARD_MOUNT && !path.startsWith(`${DASHBOARD_MOUNT}/`)) {
    return false;
  }
  // The operator API under /admin/api is never the SPA's.
  if (path === '/admin/api' || path.startsWith('/admin/api/')) return false;
  return true;
}

/**
 * Resolve the absolute path to the committed `dashboard/dist` directory,
 * robust to both run layouts:
 *   - `flue dev` (tsx): this module is `src/admin/dashboard.ts` → repo root is
 *     two dirs up → `<root>/dashboard/dist`.
 *   - built server: `app.ts` is inlined into `dist/server.mjs`, but THIS module
 *     stays a separate externalized file under `dist/` (deps aren't bundled);
 *     candidates cover `<dist>/../dashboard/dist` and a cwd-relative fallback.
 * Returns the first candidate that exists, or the cwd-relative path as a last
 * resort (serveStatic will log a clear "root not found" warning if so).
 */
export function resolveDashboardRoot(
  moduleUrl: string = import.meta.url,
): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    // src/admin/dashboard.ts → repo root → dashboard/dist
    resolve(here, '..', '..', 'dashboard', 'dist'),
    // built layout: this file under dist/ (or dist/admin/) → repo-root sibling
    resolve(here, '..', 'dashboard', 'dist'),
    resolve(here, 'dashboard', 'dist'),
    // cwd-relative (the reference's original strategy; server launched from root)
    resolve(process.cwd(), 'dashboard', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

/**
 * Mount the prebuilt dashboard SPA on `app` under `/admin`. Call AFTER the
 * admin API routes (`/admin/api/*`) are registered so the API wins first-match.
 *
 * - `/admin/*` (assets) → serveStatic from `dashboard/dist`, stripping the
 *   `/admin` prefix so `/admin/assets/x.js` reads `<root>/assets/x.js`.
 * - `/admin` and any unmatched `/admin/*` → `index.html` (SPA fallback) so
 *   client-side state/deep links resolve.
 *
 * PUBLIC by design — no operator auth on the shell/assets.
 */
export function mountDashboard(
  app: Hono,
  root: string = resolveDashboardRoot(),
): void {
  // Static assets first: `/admin/assets/*`, `/admin/logo.png`, `/admin/index.html`.
  app.use(
    `${DASHBOARD_MOUNT}/*`,
    serveStatic({
      root,
      rewriteRequestPath: (p) => p.replace(new RegExp(`^${DASHBOARD_MOUNT}`), ''),
    }),
  );

  // SPA fallback: serve index.html for `/admin` and any `/admin/*` that didn't
  // resolve to a real file above (serveStatic calls next() on a miss).
  const indexPath = join(root, 'index.html');
  app.get(`${DASHBOARD_MOUNT}`, serveStatic({ path: indexPath }));
  app.get(`${DASHBOARD_MOUNT}/*`, serveStatic({ path: indexPath }));
}
