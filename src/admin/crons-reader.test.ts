import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRON_DEFS, CronRegistry } from '../crons.ts';
import {
  buildCronInfo,
  validateCronExpression,
  createDefaultCronsReader,
  InvalidCronScheduleError,
  CronNotFoundError,
  type CronInfo,
  type CronsReader,
} from './crons-reader.ts';
import type { LastLightConfig } from '../config.ts';
import type { CronOverride } from './cron-override-store.ts';

// Colocated, runnable offline:
//   pnpm vitest run src/admin/crons-reader.test.ts
//
// Two layers: (1) pure-builder/validator units (no sqlite, no croner timer);
// (2) the live default reader over a throwaway tmp sqlite override store +
// PAUSED registry (no armed timer, no flue runtime). A FAKE CronsReader pins
// the seam shape the routes consume.

const HEALTH = CRON_DEFS.find((d) => d.name === 'weekly-health-report')!;

// ── buildCronInfo (pure projection) ──────────────────────────────────────────

describe('buildCronInfo', () => {
  it('projects a def with NO override at its default schedule + base-enabled', () => {
    const info = buildCronInfo(
      HEALTH,
      null,
      { registered: true, nextRun: new Date('2026-06-29T09:00:00.000Z') },
      ['o/r1', 'o/r2'],
      true,
    );
    expect(info).toEqual<CronInfo>({
      name: 'weekly-health-report',
      workflow: 'repo-health',
      schedule: '0 9 * * 1',
      originalSchedule: '0 9 * * 1',
      enabled: true,
      registered: true,
      nextRun: '2026-06-29T09:00:00.000Z',
      lastRun: null,
      lastStatus: null,
      recentFailures: 0,
      context: { repos: ['o/r1', 'o/r2'], mode: 'report' },
      override: null,
    });
  });

  it('applies a schedule override + flips enabled + sets hasScheduleOverride', () => {
    const override: CronOverride = {
      name: 'weekly-health-report',
      schedule: '0 6 * * 1',
      enabled: false,
      updatedAt: '2026-06-23T00:00:00.000Z',
      updatedBy: 'admin',
    };
    const info = buildCronInfo(HEALTH, override, { registered: false, nextRun: null }, [], true);
    expect(info.schedule).toBe('0 6 * * 1');
    expect(info.originalSchedule).toBe('0 9 * * 1');
    expect(info.enabled).toBe(false);
    expect(info.registered).toBe(false);
    expect(info.nextRun).toBeNull();
    expect(info.override).toEqual({
      updatedAt: '2026-06-23T00:00:00.000Z',
      updatedBy: 'admin',
      hasScheduleOverride: true,
    });
  });

  it('an enabled-only override (schedule=null) reports hasScheduleOverride:false and keeps the default schedule', () => {
    const override: CronOverride = {
      name: 'weekly-health-report',
      schedule: null,
      enabled: false,
      updatedAt: '2026-06-23T00:00:00.000Z',
      updatedBy: 'admin',
    };
    const info = buildCronInfo(HEALTH, override, { registered: true, nextRun: null }, [], true);
    expect(info.schedule).toBe('0 9 * * 1');
    expect(info.override?.hasScheduleOverride).toBe(false);
    expect(info.enabled).toBe(false);
  });
});

// ── validateCronExpression ───────────────────────────────────────────────────

describe('validateCronExpression', () => {
  it('accepts a valid expression', () => {
    expect(() => validateCronExpression('0 9 * * 1')).not.toThrow();
  });
  it('throws InvalidCronScheduleError on a bad expression', () => {
    expect(() => validateCronExpression('not a cron')).toThrow(InvalidCronScheduleError);
  });
});

// ── createDefaultCronsReader (live over a tmp sqlite store) ───────────────────

function fakeConfig(overrides: Partial<LastLightConfig> = {}): LastLightConfig {
  return {
    managedRepos: ['acme/widgets'],
    webhookSecret: '',
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    ...overrides,
  } as LastLightConfig;
}

describe('createDefaultCronsReader', () => {
  let dir: string;
  let registry: CronRegistry;
  let reader: CronsReader;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cron-reader-'));
    // A fresh PAUSED registry per test (no armed timer). croner registers named
    // jobs in a process-global table, so we `.stop()` it in afterEach to free
    // the names for the next test's registry.
    registry = new CronRegistry({ config: fakeConfig() });
    reader = createDefaultCronsReader({
      config: fakeConfig(),
      storePath: join(dir, 'cron-overrides.db'),
      registry,
    });
  });
  afterEach(() => {
    registry.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every CRON_DEF with managed repos in context and no overrides', () => {
    const crons = reader.listCrons();
    expect(crons.map((c) => c.name).sort()).toEqual(CRON_DEFS.map((d) => d.name).sort());
    const health = crons.find((c) => c.name === 'weekly-health-report')!;
    expect(health.schedule).toBe('0 9 * * 1');
    expect(health.override).toBeNull();
    expect(health.context.repos).toEqual(['acme/widgets']);
    // Non-webhook-gated crons are registered (enabled) → croner gives a nextRun.
    expect(health.registered).toBe(true);
    expect(health.nextRun).not.toBeNull();
    // Honest defaults for fields with no flue source.
    expect(health.lastRun).toBeNull();
    expect(health.lastStatus).toBeNull();
    expect(health.recentFailures).toBe(0);
  });

  it('toggle flips enabled, persists, and is reflected in listCrons', () => {
    const r1 = reader.toggle('weekly-health-report');
    expect(r1).toEqual({ name: 'weekly-health-report', enabled: false });
    const after = reader.listCrons().find((c) => c.name === 'weekly-health-report')!;
    expect(after.enabled).toBe(false);
    expect(after.override).not.toBeNull();
    // Toggling again returns to enabled.
    const r2 = reader.toggle('weekly-health-report');
    expect(r2).toEqual({ name: 'weekly-health-report', enabled: true });
  });

  it('setSchedule validates, persists the override, and lists the new schedule', () => {
    const r = reader.setSchedule('weekly-health-report', ' 0 6 * * 1 ');
    expect(r).toEqual({ name: 'weekly-health-report', schedule: '0 6 * * 1' });
    const info = reader.listCrons().find((c) => c.name === 'weekly-health-report')!;
    expect(info.schedule).toBe('0 6 * * 1');
    expect(info.originalSchedule).toBe('0 9 * * 1');
    expect(info.override?.hasScheduleOverride).toBe(true);
  });

  it('setSchedule rejects an empty schedule with InvalidCronScheduleError("schedule is required")', () => {
    expect(() => reader.setSchedule('weekly-health-report', '  ')).toThrow(
      'schedule is required',
    );
  });

  it('setSchedule rejects a bad expression with InvalidCronScheduleError', () => {
    expect(() => reader.setSchedule('weekly-health-report', 'nope')).toThrow(
      InvalidCronScheduleError,
    );
  });

  it('resetOverride drops the override and returns the default schedule + enabled', () => {
    reader.setSchedule('weekly-health-report', '0 6 * * 1');
    reader.toggle('weekly-health-report');
    const r = reader.resetOverride('weekly-health-report');
    expect(r).toEqual({ name: 'weekly-health-report', schedule: '0 9 * * 1', enabled: true });
    const info = reader.listCrons().find((c) => c.name === 'weekly-health-report')!;
    expect(info.override).toBeNull();
    expect(info.schedule).toBe('0 9 * * 1');
    expect(info.enabled).toBe(true);
  });

  it('throws CronNotFoundError for an unknown cron name', () => {
    expect(() => reader.toggle('does-not-exist')).toThrow(CronNotFoundError);
    expect(() => reader.setSchedule('does-not-exist', '0 9 * * 1')).toThrow(CronNotFoundError);
    expect(() => reader.resetOverride('does-not-exist')).toThrow(CronNotFoundError);
  });
});

// ── A FAKE CronsReader pins the seam the routes consume ───────────────────────

describe('CronsReader seam (fake)', () => {
  const fake: CronsReader = {
    listCrons: () => [
      {
        name: 'weekly-health-report',
        workflow: 'repo-health',
        schedule: '0 9 * * 1',
        originalSchedule: '0 9 * * 1',
        enabled: true,
        registered: true,
        nextRun: null,
        lastRun: null,
        lastStatus: null,
        recentFailures: 0,
        context: { repos: [] },
        override: null,
      },
    ],
    toggle: (name) => ({ name, enabled: false }),
    setSchedule: (name, schedule) => ({ name, schedule }),
    resetOverride: (name) => ({ name, schedule: '0 9 * * 1', enabled: true }),
  };

  it('exposes the four route operations', () => {
    expect(fake.listCrons()).toHaveLength(1);
    expect(fake.toggle('x')).toEqual({ name: 'x', enabled: false });
    expect(fake.setSchedule('x', '0 1 * * *')).toEqual({ name: 'x', schedule: '0 1 * * *' });
    expect(fake.resetOverride('x')).toEqual({ name: 'x', schedule: '0 9 * * 1', enabled: true });
  });
});
