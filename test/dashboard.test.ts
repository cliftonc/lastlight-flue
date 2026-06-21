import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { createApp } from '../src/app.ts';
import {
  isSpaFallbackPath,
  resolveDashboardRoot,
  DASHBOARD_MOUNT,
} from '../src/admin/dashboard.ts';

// Phase 2 · slice 5 — the prebuilt admin dashboard SPA is served from the same
// Hono app under `/admin`. These run fully OFFLINE via `app.request(...)`:
// serveStatic reads the committed `dashboard/dist/` from disk in-process (no
// real listener), so the SPA-fallback, asset serving, and the
// "API/health are NOT shadowed" invariants are all exercisable directly.

describe('dashboard SPA routing decision (pure)', () => {
  it('treats /admin and unknown /admin/* client routes as SPA fallback', () => {
    expect(isSpaFallbackPath('/admin')).toBe(true);
    expect(isSpaFallbackPath('/admin/')).toBe(true);
    expect(isSpaFallbackPath('/admin/some-view')).toBe(true);
    expect(isSpaFallbackPath('/admin/assets/index.js')).toBe(true);
  });

  it('NEVER claims the operator API, Flue, /health, or /api as SPA paths', () => {
    for (const p of [
      '/admin/api',
      '/admin/api/runs',
      '/admin/api/login',
      '/health',
      '/api/run',
      '/agents/x/y',
      '/workflows/build',
      '/runs/abc',
      '/channels/slack/events',
      '/',
    ]) {
      expect(isSpaFallbackPath(p)).toBe(false);
    }
  });
});

describe('resolveDashboardRoot', () => {
  it('resolves the committed dashboard/dist directory (with index.html)', () => {
    const root = resolveDashboardRoot();
    expect(existsSync(root)).toBe(true);
    expect(existsSync(`${root}/index.html`)).toBe(true);
  });
});

describe('dashboard served from the Hono app (in-process)', () => {
  // Auth ENABLED so we can prove the static serving does not shadow the
  // operator-auth gate on /admin/api/*.
  const app = createApp({ authConfig: { password: 'pw', secret: 's' } });

  it('GET /admin → 200 HTML index (SPA shell)', async () => {
    const res = await app.request(DASHBOARD_MOUNT);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root"');
  });

  it('GET /admin/ (trailing slash) → 200 HTML index', async () => {
    const res = await app.request(`${DASHBOARD_MOUNT}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root"');
  });

  it('GET a deep client route → 200 HTML (SPA fallback, not 404)', async () => {
    const res = await app.request(`${DASHBOARD_MOUNT}/some-deep-view`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(await res.text()).toContain('<div id="root"');
  });

  it('GET a real built asset → 200 with a non-HTML content type', async () => {
    const res = await app.request(`${DASHBOARD_MOUNT}/logo.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('image/png');
  });

  it('does NOT shadow /admin/api/* — still JSON 401 without a token', async () => {
    const res = await app.request('/admin/api/runs');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
  });

  it('does NOT shadow /admin/api/auth-required — still reachable JSON', async () => {
    const res = await app.request('/admin/api/auth-required');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.required).toBe('boolean');
  });

  it('does NOT shadow /health — still JSON, not HTML', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  it('can be disabled — serveDashboard:false leaves /admin unserved', async () => {
    const bare = createApp({
      authConfig: { password: '', secret: 'x' },
      serveDashboard: false,
    });
    const res = await bare.request('/admin');
    expect(res.status).toBe(404);
  });
});
