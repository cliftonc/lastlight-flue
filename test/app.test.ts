import { describe, it, expect } from 'vitest';
import { createApp, healthBody, authRequiredBody } from '../src/app.ts';

// Phase 2 · slice 1 — contract tests for the APPLICATION-OWNED server surface.
//
// These use `createApp()` (the app-owned factory) + Hono's in-process
// `app.request(...)`, so they run fully OFFLINE: no `flue dev` server, no build,
// no model call. `createApp()` deliberately does NOT mount `flue()`, so these
// exercise exactly the routes Last Light owns (/health, /api/status,
// /admin/api/auth-required) plus the 501 seams for not-yet-ported routes.

describe('app-owned surface (createApp, in-process)', () => {
  const app = createApp();

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

  it('not-yet-ported admin data routes return 501', async () => {
    for (const path of ['/admin/api/runs', '/admin/api/agents', '/admin/api/stats']) {
      const res = await app.request(path);
      expect(res.status).toBe(501);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('not_implemented');
    }
  });

  it('unknown route → 404 (Hono default, no flue() mounted)', async () => {
    const res = await app.request('/no-such-route');
    expect(res.status).toBe(404);
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

  it('authRequiredBody reports the unconfigured baseline', () => {
    const b = authRequiredBody();
    expect(b.required).toBe(false);
    expect(b.slackOAuth).toBe(false);
    expect(b.githubOAuth).toBe(false);
  });
});
