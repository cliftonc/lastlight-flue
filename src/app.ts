import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

// Phase 0 · spike app entrypoint. A real Hono app that mounts Flue's public
// routes at `/`. Phase 2 grows this into the full server (/api, /admin/api,
// crons, auth middleware) — for now it just exposes a health check plus the
// discovered agents/workflows/channels.

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.route('/', flue());

export default app;
