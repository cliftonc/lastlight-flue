import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  oauthConfigFromEnv,
  slackOAuthEnabled,
  githubOAuthEnabled,
  mountOAuthRoutes,
  type OAuthConfig,
} from './oauth.ts';

const SECRET = 'test-secret';

function cfg(over: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    slack: { clientId: '', clientSecret: '', redirectUri: '', allowedWorkspace: '', ...over.slack },
    github: { clientId: '', clientSecret: '', redirectUri: '', allowedOrg: '', ...over.github },
  };
}

function appWith(oauth: OAuthConfig): Hono {
  const app = new Hono();
  mountOAuthRoutes(app, { secret: SECRET, oauth });
  return app;
}

describe('oauthConfigFromEnv', () => {
  it('reads the reference env var names', () => {
    const c = oauthConfigFromEnv({
      SLACK_OAUTH_CLIENT_ID: 'sid',
      SLACK_OAUTH_CLIENT_SECRET: 'ssec',
      SLACK_OAUTH_REDIRECT_URI: 'https://x/slack',
      SLACK_ALLOWED_WORKSPACE: 'acme',
      GITHUB_OAUTH_CLIENT_ID: 'gid',
      GITHUB_OAUTH_CLIENT_SECRET: 'gsec',
      GITHUB_OAUTH_REDIRECT_URI: 'https://x/gh',
      GITHUB_ALLOWED_ORG: 'my-org',
    } as NodeJS.ProcessEnv);
    expect(c.slack.clientId).toBe('sid');
    expect(c.slack.allowedWorkspace).toBe('acme');
    expect(c.github.clientId).toBe('gid');
    expect(c.github.allowedOrg).toBe('my-org');
  });

  it('defaults to empty strings when unset', () => {
    const c = oauthConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(slackOAuthEnabled(c)).toBe(false);
    expect(githubOAuthEnabled(c)).toBe(false);
  });
});

describe('enabled-flag logic', () => {
  it('slack needs both client id + secret', () => {
    expect(slackOAuthEnabled(cfg({ slack: { clientId: 'a', clientSecret: '', redirectUri: '', allowedWorkspace: '' } }))).toBe(false);
    expect(slackOAuthEnabled(cfg({ slack: { clientId: 'a', clientSecret: 'b', redirectUri: '', allowedWorkspace: '' } }))).toBe(true);
  });

  it('github needs creds AND an org allowlist', () => {
    expect(githubOAuthEnabled(cfg({ github: { clientId: 'a', clientSecret: 'b', redirectUri: '', allowedOrg: '' } }))).toBe(false);
    expect(githubOAuthEnabled(cfg({ github: { clientId: 'a', clientSecret: 'b', redirectUri: '', allowedOrg: 'org' } }))).toBe(true);
    expect(githubOAuthEnabled(cfg({ github: { clientId: 'a', clientSecret: 'b', redirectUri: '', allowedOrg: '*' } }))).toBe(true);
  });
});

describe('OAuth routes — not configured', () => {
  it('returns honest 404 JSON (NOT SPA html) for every route when disabled', async () => {
    const app = appWith(cfg());
    for (const p of [
      '/admin/api/oauth/slack/authorize',
      '/admin/api/oauth/slack/callback',
      '/admin/api/oauth/github/authorize',
      '/admin/api/oauth/github/callback',
    ]) {
      const res = await app.request(p);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(((await res.json()) as { error: string }).error).toMatch(/not configured/);
    }
  });
});

describe('OAuth authorize — configured', () => {
  it('Slack authorize redirects to slack.com with a state cookie', async () => {
    const app = appWith(cfg({ slack: { clientId: 'sid', clientSecret: 'ssec', redirectUri: 'https://x/slack', allowedWorkspace: '' } }));
    const res = await app.request('/admin/api/oauth/slack/authorize');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('slack.com');
    expect(res.headers.get('set-cookie')).toContain('slack_oauth_state=');
  });

  it('GitHub authorize redirects to github.com with a state cookie', async () => {
    const app = appWith(cfg({ github: { clientId: 'gid', clientSecret: 'gsec', redirectUri: 'https://x/gh', allowedOrg: 'org' } }));
    const res = await app.request('/admin/api/oauth/github/authorize');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('github.com');
    expect(res.headers.get('set-cookie')).toContain('github_oauth_state=');
  });
});

describe('OAuth callback — CSRF state guard (pre-network)', () => {
  it('Slack callback rejects a missing/mismatched state with 400 JSON', async () => {
    const app = appWith(cfg({ slack: { clientId: 'sid', clientSecret: 'ssec', redirectUri: 'https://x/slack', allowedWorkspace: '' } }));
    const res = await app.request('/admin/api/oauth/slack/callback?code=abc&state=nope');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/state/);
  });

  it('GitHub callback redirects to the login card with an error code on bad state', async () => {
    const app = appWith(cfg({ github: { clientId: 'gid', clientSecret: 'gsec', redirectUri: 'https://x/gh', allowedOrg: 'org' } }));
    const res = await app.request('/admin/api/oauth/github/callback?code=abc&state=nope');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/?error=oauth_state');
  });
});
