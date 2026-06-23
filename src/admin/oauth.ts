import type { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { Slack, GitHub } from 'arctic';
import { createToken } from './auth.ts';

// ── Last Light on Flue · admin OAuth login (Slack + GitHub "Sign in with…") ───
//
// Ports the reference's `/admin/api/oauth/{slack,github}/{authorize,callback}`
// flow (~/work/lastlight/src/admin/routes.ts) onto flue. The dashboard's login
// card shows a "Connect Slack"/"Connect GitHub" button ONLY when
// `/admin/api/auth-required` reports the provider enabled (see authRequiredBody
// in app.ts). The flow is stateless on our side: authorize sets a short-lived
// CSRF `state` cookie and redirects to the provider; callback validates the
// state, exchanges the code (arctic), enforces the workspace/org allowlist, then
// issues the SAME HMAC bearer token `loginHandler` issues (`createToken`) and
// redirects to `/admin/?token=…` — the SPA strips the token and is logged in.
//
// Config comes from ENV (like operator-auth in auth.ts; flue's config.ts does
// not model these — neither did the reference's config module). Providers are
// independently optional: a provider is ENABLED only when its full credential
// set is present, else its routes return an honest `404 { error }` (never the
// SPA HTML — these are mounted under /admin/api/* which is JSON by contract).

/** Per-provider + shared OAuth configuration, resolved from env. */
export interface OAuthConfig {
  slack: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** When set, only this Slack team id OR domain may sign in. */
    allowedWorkspace: string;
  };
  github: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** Required to enable GitHub OAuth. `"*"` ⇒ any authenticated user. */
    allowedOrg: string;
  };
}

/**
 * Resolve OAuth config from env, matching the reference's variable names so an
 * existing `secrets/.env` works unchanged:
 *   SLACK_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI / SLACK_ALLOWED_WORKSPACE
 *   GITHUB_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI / GITHUB_ALLOWED_ORG
 */
export function oauthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OAuthConfig {
  return {
    slack: {
      clientId: env.SLACK_OAUTH_CLIENT_ID ?? '',
      clientSecret: env.SLACK_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: env.SLACK_OAUTH_REDIRECT_URI ?? '',
      allowedWorkspace: env.SLACK_ALLOWED_WORKSPACE ?? '',
    },
    github: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID ?? '',
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: env.GITHUB_OAUTH_REDIRECT_URI ?? '',
      allowedOrg: env.GITHUB_ALLOWED_ORG ?? '',
    },
  };
}

/** Slack OAuth is enabled when both client credentials are present. */
export function slackOAuthEnabled(cfg: OAuthConfig): boolean {
  return Boolean(cfg.slack.clientId && cfg.slack.clientSecret);
}

/** GitHub OAuth needs both creds AND an org allowlist (`"*"` = any user). */
export function githubOAuthEnabled(cfg: OAuthConfig): boolean {
  return Boolean(
    cfg.github.clientId && cfg.github.clientSecret && cfg.github.allowedOrg,
  );
}

/** `"*"` org allowlist ⇒ skip the org-membership check (any GitHub user). */
function githubAllowAnyUser(cfg: OAuthConfig): boolean {
  return cfg.github.allowedOrg === '*';
}

const STATE_COOKIE = {
  httpOnly: true,
  sameSite: 'Lax',
  path: '/',
  maxAge: 600, // 10 minutes
} as const;

export interface MountOAuthOptions {
  /** The HMAC secret used to sign the issued admin token (= ADMIN_SECRET). */
  secret: string;
  /** Resolved OAuth config (defaults to env). */
  oauth?: OAuthConfig;
}

/**
 * Register the four OAuth routes on `app` under `/admin/api/oauth/*`. MUST be
 * mounted BEFORE the `/admin/api/*` operator-auth middleware (these ARE the
 * login mechanism, so they are public — same treatment as `auth-required`/
 * `login`, also exempted in auth.ts `isPublicAuthPath`).
 */
export function mountOAuthRoutes(app: Hono, opts: MountOAuthOptions): void {
  const cfg = opts.oauth ?? oauthConfigFromEnv();

  // ── Slack ────────────────────────────────────────────────────────────────
  app.get('/admin/api/oauth/slack/authorize', (c) => {
    if (!slackOAuthEnabled(cfg)) {
      return c.json({ error: 'Slack OAuth not configured' }, 404);
    }
    const slack = new Slack(
      cfg.slack.clientId,
      cfg.slack.clientSecret,
      cfg.slack.redirectUri,
    );
    const state = randomBytes(16).toString('hex');
    setCookie(c, 'slack_oauth_state', state, STATE_COOKIE);
    // "Sign in with Slack" → OIDC scopes (openid + profile).
    const url = slack.createAuthorizationURL(state, ['openid', 'profile']);
    return c.redirect(url.toString());
  });

  app.get('/admin/api/oauth/slack/callback', async (c) => {
    if (!slackOAuthEnabled(cfg)) {
      return c.json({ error: 'Slack OAuth not configured' }, 404);
    }
    const storedState = getCookie(c, 'slack_oauth_state');
    deleteCookie(c, 'slack_oauth_state', { path: '/' });
    const { code, state } = c.req.query() as { code?: string; state?: string };
    if (!storedState || !state || storedState !== state) {
      return c.json({ error: 'invalid state parameter' }, 400);
    }
    if (!code) {
      return c.json({ error: 'missing authorization code' }, 400);
    }
    try {
      const slack = new Slack(
        cfg.slack.clientId,
        cfg.slack.clientSecret,
        cfg.slack.redirectUri,
      );
      // Slack's OIDC tokens are rejected by the classic auth.test endpoint —
      // use the OIDC userInfo endpoint (claims under namespaced URLs).
      const tokens = await slack.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();
      const res = await fetch('https://slack.com/api/openid.connect.userInfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userInfo = (await res.json()) as {
        ok?: boolean;
        error?: string;
        'https://slack.com/team_id'?: string;
        'https://slack.com/team_domain'?: string;
      };
      if (userInfo.ok === false) {
        console.error('Slack openid.connect.userInfo failed:', userInfo.error);
        return c.json({ error: 'Slack userInfo failed' }, 502);
      }
      const teamId = userInfo['https://slack.com/team_id'];
      const teamDomain = userInfo['https://slack.com/team_domain'];
      if (cfg.slack.allowedWorkspace) {
        const allowed = cfg.slack.allowedWorkspace;
        if (teamId !== allowed && teamDomain !== allowed) {
          console.warn(
            `[oauth] Slack login rejected: workspace ${teamDomain ?? teamId ?? 'unknown'} not in allowlist (${allowed})`,
          );
          return c.json({ error: 'workspace not allowed' }, 403);
        }
      }
      const token = createToken(opts.secret, 'slack');
      return c.redirect(`/admin/?token=${encodeURIComponent(token)}`);
    } catch (err: unknown) {
      console.error('OAuth exchange failed:', err);
      return c.json({ error: 'OAuth exchange failed' }, 502);
    }
  });

  // ── GitHub ───────────────────────────────────────────────────────────────
  app.get('/admin/api/oauth/github/authorize', (c) => {
    if (!githubOAuthEnabled(cfg)) {
      return c.json({ error: 'GitHub OAuth not configured' }, 404);
    }
    const github = new GitHub(
      cfg.github.clientId,
      cfg.github.clientSecret,
      cfg.github.redirectUri,
    );
    const state = randomBytes(16).toString('hex');
    setCookie(c, 'github_oauth_state', state, STATE_COOKIE);
    // `read:org` is only needed for the org-membership check; skip it for "*".
    const scopes = githubAllowAnyUser(cfg) ? [] : ['read:org'];
    const url = github.createAuthorizationURL(state, scopes);
    return c.redirect(url.toString());
  });

  app.get('/admin/api/oauth/github/callback', async (c) => {
    if (!githubOAuthEnabled(cfg)) {
      return c.json({ error: 'GitHub OAuth not configured' }, 404);
    }
    // The SPA maps a short `?error=` code to an inline login-card message.
    const fail = (code: string) =>
      c.redirect(`/admin/?error=${encodeURIComponent(code)}`);
    const storedState = getCookie(c, 'github_oauth_state');
    deleteCookie(c, 'github_oauth_state', { path: '/' });
    const { code, state } = c.req.query() as { code?: string; state?: string };
    if (!storedState || !state || storedState !== state) return fail('oauth_state');
    if (!code) return fail('oauth_code');
    try {
      const github = new GitHub(
        cfg.github.clientId,
        cfg.github.clientSecret,
        cfg.github.redirectUri,
      );
      const tokens = await github.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'lastlight-admin',
          Accept: 'application/vnd.github+json',
        },
      });
      const userInfo = (await res.json()) as { login?: string };
      if (!userInfo.login) {
        console.error('GitHub /user failed: missing login field');
        return fail('github_userinfo');
      }
      const login = userInfo.login;
      if (!githubAllowAnyUser(cfg)) {
        const org = cfg.github.allowedOrg;
        const memberRes = await fetch(
          `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'User-Agent': 'lastlight-admin',
              Accept: 'application/vnd.github+json',
            },
            redirect: 'manual',
          },
        );
        // Only 204 No Content confirms membership; 302 (no read:org visibility)
        // and 404 (not a member) are both rejected.
        if (memberRes.status !== 204) {
          console.warn(
            `[oauth] GitHub login rejected: ${login} not a confirmed member of ${org} (status ${memberRes.status})`,
          );
          return fail('github_org');
        }
      }
      const token = createToken(opts.secret, 'github');
      return c.redirect(`/admin/?token=${encodeURIComponent(token)}`);
    } catch (err: unknown) {
      console.error('GitHub OAuth exchange failed:', err);
      return fail('oauth_exchange');
    }
  });
}
