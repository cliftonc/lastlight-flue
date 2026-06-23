// ── Last Light on Flue · operator auth (Phase 2 · slice 3) ───────────────────
//
// Ported from the reference `~/work/lastlight/src/admin/auth.ts`, adapted to a
// Hono `MiddlewareHandler` factory + the `/admin/api/login` token-issue route.
//
// Scheme (preserved VERBATIM from the reference): a stateless HMAC-signed bearer
// token. `createToken(secret, method?)` builds `base64url(payload).base64url(sig)`
// where payload = `{ exp, method? }` (7-day TTL) and sig = HMAC-SHA256(payload,
// secret). `verifyToken` recomputes the HMAC and compares with `timingSafeEqual`
// (constant-time), then checks `exp`. There is NO server-side session store —
// the token is self-describing and self-verifying, so it SURVIVES PROCESS
// RESTART as long as `ADMIN_SECRET` is stable (a fixed env secret). This is the
// reference's exact mechanism; no in-memory store, no db. Caveat: rotating
// `ADMIN_SECRET` invalidates every outstanding token (intended).
//
// SECURITY: the password compare is constant-time (`timingSafeEqual` over equal-
// length buffers); the HMAC compare is constant-time; secrets are read from env
// (never hardcoded) and never logged.

import crypto from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler, Next } from 'hono';

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** Authentication method recorded in a token payload (informational). */
export type AuthMethod = 'password' | 'slack' | 'github';

/**
 * Operator-auth configuration. `password` empty ⇒ auth is DISABLED (the
 * reference behaviour — a fresh/dev install with no `ADMIN_PASSWORD` set lets
 * everything through). `secret` signs/verifies tokens and must be stable across
 * restarts for tokens to survive (it is — it comes from `ADMIN_SECRET`).
 */
export interface OperatorAuthConfig {
  password: string;
  secret: string;
}

/**
 * Resolve operator-auth config from the environment, matching the reference
 * defaults (`~/work/lastlight/src/index.ts`): `ADMIN_PASSWORD` (default ""), and
 * `ADMIN_SECRET` (default the reference's `"lastlight-dev-secret"` dev fallback).
 * The current `src/config.ts` does NOT model admin auth (it never did in the
 * reference's config module either — these were read straight from env at the
 * server-wiring layer), so we source them here and inject at `createApp`.
 */
export function operatorAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OperatorAuthConfig {
  return {
    password: env.ADMIN_PASSWORD ?? '',
    secret: env.ADMIN_SECRET ?? 'lastlight-dev-secret',
  };
}

/** Build a signed bearer token (`payload.sig`, base64url), valid for 7 days. */
export function createToken(secret: string, method?: AuthMethod): string {
  const payload: { exp: number; method?: string } = {
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  if (method) payload.method = method;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

/** Verify a bearer token's signature (constant-time) and expiry. */
export function verifyToken(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts as [string, string];
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  if (
    expectedSig.length !== sig.length ||
    !timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig))
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return false;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Paths that must stay reachable WITHOUT a token even when auth is enabled — the
 * CLI/dashboard read `auth-required` to learn HOW to authenticate, POST `login`
 * to obtain a token, and run the OAuth authorize/callback flow (which is itself
 * the login mechanism — it ISSUES the token). Everything else under
 * `/admin/api/*` requires a valid bearer token.
 */
function isPublicAuthPath(path: string): boolean {
  return (
    path.endsWith('/auth-required') ||
    path.endsWith('/login') ||
    path.includes('/oauth/')
  );
}

/**
 * Operator-auth Hono middleware factory. Mounted on `/admin/api/*`.
 *  - When no password is configured, auth is DISABLED → pass through (dev/fresh
 *    install). Matches the reference.
 *  - Public-by-contract paths (`auth-required`, `login`) pass through even when
 *    enabled.
 *  - Otherwise require a valid bearer token, accepted via the `Authorization:
 *    Bearer <token>` header OR a `?token=` query param (EventSource can't set
 *    headers). Invalid/absent → `401 { error: "unauthorized" }` (exact reference
 *    shape).
 */
export function requireOperator(config: OperatorAuthConfig): MiddlewareHandler {
  const enabled = Boolean(config.password);
  return async (c: Context, next: Next) => {
    if (!enabled) return next();

    const path = new URL(c.req.url).pathname;
    if (isPublicAuthPath(path)) return next();

    const header = c.req.header('Authorization');
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) token = c.req.query('token') ?? undefined;

    if (!token || !verifyToken(token, config.secret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}

/**
 * POST `/admin/api/login` handler (password → token). Mirrors the reference:
 *  - auth disabled (no password) → issue a token + `{ authDisabled: true }`.
 *  - missing password field → `400`.
 *  - wrong password → `401` (constant-time compare over equal-length buffers).
 *  - correct → `{ token }` (method=password).
 */
export function loginHandler(config: OperatorAuthConfig) {
  return async (c: Context) => {
    if (!config.password) {
      return c.json({ token: createToken(config.secret), authDisabled: true });
    }
    const body = await c.req
      .json<{ password?: string }>()
      .catch((): { password?: string } => ({}));
    if (typeof body.password !== 'string') {
      return c.json({ error: 'password required' }, 400);
    }
    const a = Buffer.from(body.password);
    const b = Buffer.from(config.password);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      return c.json({ error: 'invalid password' }, 401);
    }
    return c.json({ token: createToken(config.secret, 'password') });
  };
}
