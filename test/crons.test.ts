import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CronRegistry,
  CRON_DEFS,
  isCronEnabled,
  buildCronPayload,
  startCrons,
  stopCrons,
  type CronInvoker,
} from '../src/crons.ts';
import type { LastLightConfig } from '../src/config.ts';

// Phase 5 · FINAL slice — cron scheduler + graceful-shutdown tests.
//
// Fully OFFLINE: the invoke seam is a fake spy (NEVER spawns `flue run`), crons
// are constructed PAUSED (no live timer), and `trigger()` is called DIRECTLY so
// nothing depends on wall-clock. We additionally assert NO real timer is armed
// and NO real spawn happens.

/** Minimal config stub with just the fields the cron registry reads. */
function fakeConfig(over: Partial<LastLightConfig> = {}): LastLightConfig {
  return {
    managedRepos: ['acme/alpha', 'acme/beta'],
    webhookSecret: '',
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    ...over,
  } as unknown as LastLightConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron registry — definitions', () => {
  it('ports the four reference cron jobs with the right schedule + workflow', () => {
    const byName = Object.fromEntries(CRON_DEFS.map((d) => [d.name, d]));
    expect(byName['weekly-health-report']).toMatchObject({
      schedule: '0 9 * * 1',
      workflow: 'repo-health',
      webhookGated: false,
    });
    expect(byName['weekly-security-scan']).toMatchObject({
      schedule: '0 10 * * 1',
      workflow: 'security-review',
      webhookGated: false,
    });
    expect(byName['triage-new-issues']).toMatchObject({
      schedule: '*/15 * * * *',
      workflow: 'issue-triage',
      webhookGated: true,
    });
    expect(byName['check-prs-awaiting-review']).toMatchObject({
      schedule: '*/30 * * * *',
      workflow: 'pr-review',
      webhookGated: true,
    });
  });
});

describe('cron registry — positive-enable gating', () => {
  it('enables a non-webhook cron by default', () => {
    const def = CRON_DEFS.find((d) => d.name === 'weekly-health-report')!;
    expect(isCronEnabled(def, fakeConfig())).toBe(true);
  });

  it('disables a cron named in config.disabled.crons', () => {
    const def = CRON_DEFS.find((d) => d.name === 'weekly-health-report')!;
    const cfg = fakeConfig({
      disabled: { workflows: [], crons: ['weekly-health-report'], prompts: [], skills: [], agentContext: [] },
    });
    expect(isCronEnabled(def, cfg)).toBe(false);
  });

  it('webhook-gated cron is enabled only when webhooks are DISABLED', () => {
    const def = CRON_DEFS.find((d) => d.name === 'triage-new-issues')!;
    expect(isCronEnabled(def, fakeConfig({ webhookSecret: '' }))).toBe(true);
    expect(isCronEnabled(def, fakeConfig({ webhookSecret: 'shhh' }))).toBe(false);
  });

  it('a disabled cron does not register at all', () => {
    const reg = new CronRegistry({
      config: fakeConfig({
        disabled: { workflows: [], crons: ['weekly-health-report'], prompts: [], skills: [], agentContext: [] },
      }),
      invoke: vi.fn(),
    });
    expect(reg.names()).not.toContain('weekly-health-report');
    reg.stop();
  });

  it('webhook-gated crons drop out when webhooks are enabled', () => {
    const reg = new CronRegistry({ config: fakeConfig({ webhookSecret: 'on' }), invoke: vi.fn() });
    expect(reg.names()).toEqual(['weekly-health-report', 'weekly-security-scan']);
    reg.stop();
  });
});

describe('cron payload — per-repo fan-out shape', () => {
  it('splits owner/repo, stamps triggerType:cron, merges static context', () => {
    const def = CRON_DEFS.find((d) => d.name === 'weekly-health-report')!;
    expect(buildCronPayload(def, 'acme/alpha')).toEqual({
      owner: 'acme',
      repo: 'alpha',
      mode: 'report',
      triggerType: 'cron',
    });
  });

  it('returns null for a malformed slug (no slash / leading-or-trailing slash)', () => {
    const def = CRON_DEFS.find((d) => d.name === 'weekly-health-report')!;
    expect(buildCronPayload(def, 'nopeslug')).toBeNull();
    expect(buildCronPayload(def, '/leading')).toBeNull();
    expect(buildCronPayload(def, 'trailing/')).toBeNull();
  });
});

describe('cron registry — fan-out invoke', () => {
  it('fires ONE invoke per managed repo with the right workflow + payload', async () => {
    const invoke = vi.fn<CronInvoker>().mockResolvedValue(undefined);
    const reg = new CronRegistry({
      config: fakeConfig({ managedRepos: ['acme/alpha', 'acme/beta'] }),
      invoke,
    });
    const health = reg.crons.find((c) => c.def.name === 'weekly-health-report')!;
    const count = await health.trigger();

    expect(count).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith('repo-health', {
      owner: 'acme',
      repo: 'alpha',
      mode: 'report',
      triggerType: 'cron',
    });
    expect(invoke).toHaveBeenCalledWith('repo-health', {
      owner: 'acme',
      repo: 'beta',
      mode: 'report',
      triggerType: 'cron',
    });
    reg.stop();
  });

  it('isolates a per-repo failure — one repo throwing does not abort the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = vi
      .fn<CronInvoker>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const reg = new CronRegistry({
      config: fakeConfig({ managedRepos: ['acme/alpha', 'acme/beta'] }),
      invoke,
    });
    const health = reg.crons.find((c) => c.def.name === 'weekly-health-report')!;
    const count = await health.trigger();

    // First repo threw → not counted; second still fired.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(count).toBe(1);
    reg.stop();
  });

  it('with no managed repos, a trigger fires no invoke', async () => {
    const invoke = vi.fn<CronInvoker>().mockResolvedValue(undefined);
    const reg = new CronRegistry({ config: fakeConfig({ managedRepos: [] }), invoke });
    const health = reg.crons.find((c) => c.def.name === 'weekly-health-report')!;
    expect(await health.trigger()).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    reg.stop();
  });
});

describe('cron registry — no live timer until start()', () => {
  it('crons are constructed PAUSED — building the registry arms no timer', () => {
    const reg = new CronRegistry({ config: fakeConfig(), invoke: vi.fn() });
    for (const c of reg.crons) {
      // croner: a paused cron reports no next-run until resumed.
      expect(c.cron.isRunning()).toBe(false);
    }
    reg.stop();
  });

  it('start() arms the timers; stop() halts them', () => {
    const reg = new CronRegistry({ config: fakeConfig(), invoke: vi.fn() });
    reg.start();
    expect(reg.crons.every((c) => c.cron.isRunning())).toBe(true);
    reg.stop();
    expect(reg.crons.every((c) => c.cron.isStopped())).toBe(true);
  });

  it('start() is idempotent (run-once guard)', () => {
    const reg = new CronRegistry({ config: fakeConfig(), invoke: vi.fn() });
    const spy = vi.spyOn(reg.crons[0]!.cron, 'resume');
    reg.start();
    reg.start();
    expect(spy).toHaveBeenCalledTimes(1);
    reg.stop();
  });
});

describe('startCrons / stopCrons — VITEST-inert lifecycle', () => {
  it('startCrons is a no-op under VITEST (never schedules / spawns)', () => {
    // VITEST is set during this run → startCrons must return undefined and arm
    // nothing. (If it scheduled, a real `flue run` could fire — forbidden.)
    expect(process.env.VITEST).toBeTruthy();
    expect(startCrons()).toBeUndefined();
  });

  it('startCrons honors LASTLIGHT_SKIP_CRONS even without VITEST', () => {
    const prev = process.env.VITEST;
    delete process.env.VITEST;
    process.env.LASTLIGHT_SKIP_CRONS = '1';
    try {
      expect(startCrons()).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.VITEST = prev;
      delete process.env.LASTLIGHT_SKIP_CRONS;
    }
  });

  it('stopCrons is safe when crons were never started', () => {
    expect(() => stopCrons()).not.toThrow();
  });
});
