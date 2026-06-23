import { Cron } from 'croner';
import {
  CRON_DEFS,
  CronRegistry,
  getCronRegistry,
  isCronEnabled,
  type CronJobDef,
} from '../crons.ts';
import {
  getRuntimeConfig,
  loadConfig,
  type LastLightConfig,
} from '../config.ts';
import {
  CronOverrideStore,
  type CronOverride,
} from './cron-override-store.ts';

// ── Last Light on Flue · admin crons seam (admin crons slice) ────────────────
//
// The data layer backing the four operator cron routes (was un-ported):
//   GET    /admin/api/crons                 → { crons: CronInfo[] }
//   POST   /admin/api/crons/:name/toggle    → { name, enabled }
//   POST   /admin/api/crons/:name/schedule  → { name, schedule }
//   DELETE /admin/api/crons/:name/override  → { name, schedule, enabled }
//
// Mechanical port of ~/work/lastlight/src/admin/routes.ts (~1012-1147): list
// every cron defined statically, MERGED with the persisted override row and the
// LIVE scheduler state (registered? nextRun?). Reference fields with no flue
// equivalent return honest defaults (see NOTE blocks below), never fabricated.
//
// Behind an INJECTABLE seam (`CronsReader`, like `StatsReader`): the default
// (`createDefaultCronsReader`) wires the static CRON_DEFS, a LIVE CronRegistry
// (src/crons.ts — the real croner instances for nextRun/registered), and the
// app-owned CronOverrideStore. Tests inject a fake and run fully offline.

/** The dashboard `CronInfo` shape (dashboard/src/api.ts) — matched EXACTLY. */
export interface CronInfo {
  name: string;
  workflow: string;
  schedule: string;
  originalSchedule: string;
  enabled: boolean;
  registered: boolean;
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  recentFailures: number;
  context: Record<string, unknown>;
  override: {
    updatedAt: string;
    updatedBy: string | null;
    hasScheduleOverride: boolean;
  } | null;
}

/** The `POST :name/toggle` response. */
export interface CronToggleResult {
  name: string;
  enabled: boolean;
}

/** The `POST :name/schedule` response. */
export interface CronScheduleResult {
  name: string;
  schedule: string;
}

/** The `DELETE :name/override` response. */
export interface CronResetResult {
  name: string;
  schedule: string;
  enabled: boolean;
}

/**
 * Thrown by `setSchedule` when the cron expression fails croner validation, so
 * the route can map it to a 400 (the reference returns `invalid schedule: …`).
 */
export class InvalidCronScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCronScheduleError';
  }
}

/** Thrown when an operation names a cron that isn't defined → route 404s. */
export class CronNotFoundError extends Error {
  constructor(public readonly cronName: string) {
    super(`cron not found: ${cronName}`);
    this.name = 'CronNotFoundError';
  }
}

/** The injectable seam `createApp()` mounts the four cron routes over. */
export interface CronsReader {
  /** List every cron, merged with overrides + live scheduler state. */
  listCrons(): CronInfo[];
  /** Flip enabled and apply to the live scheduler. Throws CronNotFoundError. */
  toggle(name: string): CronToggleResult;
  /**
   * Persist + apply a schedule override. Throws CronNotFoundError (unknown name)
   * or InvalidCronScheduleError (bad expression → route 400).
   */
  setSchedule(name: string, schedule: string): CronScheduleResult;
  /** Drop the override, re-register at the default. Throws CronNotFoundError. */
  resetOverride(name: string): CronResetResult;
}

/** Validate a cron expression with croner; throw on failure (route → 400). */
export function validateCronExpression(schedule: string): void {
  try {
    const probe = new Cron(schedule, { paused: true }, () => {});
    probe.stop();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidCronScheduleError(`invalid schedule: ${msg}`);
  }
}

/**
 * Project one cron def + its (optional) override + live state into a CronInfo
 * row (pure). Mirrors the reference's per-cron merge in `GET /crons`.
 *
 * NOTE — fields with no flue equivalent (honest defaults, not fabricated):
 *   - `lastRun` / `lastStatus`: the reference reads the most-recent
 *     workflow_run for the cron's workflow from its own run-store; flue's
 *     CronRegistry carries no last-run record (croner exposes nextRun only, not
 *     a run log). Defaulted to `null` until a run-history join is added.
 *   - `recentFailures`: the reference reads `consecutiveFailures(workflow)` from
 *     its executions table; the flue stats-store (src/stats-store.ts) records
 *     per-execution cost/tokens with NO success/fail outcome column, so a
 *     consecutive-failure count cannot be derived. Defaulted to `0`.
 */
export function buildCronInfo(
  def: CronJobDef,
  override: CronOverride | null,
  live: { registered: boolean; nextRun: Date | null },
  managedRepos: string[],
  baseEnabled: boolean,
): CronInfo {
  const enabled = override ? override.enabled : baseEnabled;
  return {
    name: def.name,
    workflow: def.workflow,
    schedule: override?.schedule ?? def.schedule,
    originalSchedule: def.schedule,
    enabled,
    registered: live.registered,
    nextRun: live.nextRun ? live.nextRun.toISOString() : null,
    // No flue last-run record (see NOTE above) → honest null.
    lastRun: null,
    lastStatus: null,
    // No flue consecutive-failure source (see NOTE above) → honest 0.
    recentFailures: 0,
    context: { repos: managedRepos, ...def.context },
    override: override
      ? {
          updatedAt: override.updatedAt,
          updatedBy: override.updatedBy,
          hasScheduleOverride: override.schedule != null,
        }
      : null,
  };
}

/** Options for the default (live) crons reader. */
export interface DefaultCronsReaderOptions {
  /** Resolved config. Defaults to the runtime config (or loadConfig()). */
  config?: LastLightConfig;
  /** Override-store path. Defaults to `LASTLIGHT_CRON_OVERRIDES` or .data path. */
  storePath?: string;
  /**
   * The live cron registry whose croner instances back `registered`/`nextRun`.
   * Defaults to a fresh `new CronRegistry()` (built PAUSED → no live timer).
   */
  registry?: CronRegistry;
}

const defaultStorePath = () =>
  process.env.LASTLIGHT_CRON_OVERRIDES ?? './.data/cron-overrides.db';

/**
 * The production crons reader: the static CRON_DEFS merged with the app-owned
 * override store and the live CronRegistry's croner state. Opens the override
 * store per call (cheap sqlite; the dashboard polls) and closes it.
 *
 * The registry is consulted for `registered` (is this cron's name in the
 * enabled set?) and `nextRun` (croner's next fire time). It is built PAUSED by
 * default — reading `nextRun()` does NOT require an armed timer.
 */
export function createDefaultCronsReader(
  opts: DefaultCronsReaderOptions = {},
): CronsReader {
  const config = opts.config ?? getRuntimeConfig() ?? loadConfig();
  const storePath = opts.storePath ?? defaultStorePath();
  // The reader is READ-ONLY over the scheduler. When a registry is injected
  // (tests) use it; otherwise resolve the LIVE process registry that
  // `startCrons()` owns — lazily, since the default export builds this reader at
  // module-eval BEFORE startCrons() runs. Building our own `new CronRegistry()`
  // here would register croner jobs under the SAME global names startCrons()
  // uses, making the real scheduler fail with "name already taken".
  const getRegistry = (): CronRegistry | undefined =>
    opts.registry ?? getCronRegistry();
  const managedRepos = config.managedRepos;

  const liveOf = (name: string): { registered: boolean; nextRun: Date | null } => {
    const reg = getRegistry()?.crons.find((c) => c.def.name === name);
    if (!reg) return { registered: false, nextRun: null };
    return { registered: true, nextRun: reg.cron.nextRun() };
  };
  const defOf = (name: string): CronJobDef => {
    const def = CRON_DEFS.find((d) => d.name === name);
    if (!def) throw new CronNotFoundError(name);
    return def;
  };
  const withStore = <T>(fn: (s: CronOverrideStore) => T): T => {
    const store = new CronOverrideStore(storePath);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  return {
    listCrons() {
      return withStore((store) => {
        const overrides = store.getAll();
        return CRON_DEFS.map((def) =>
          buildCronInfo(
            def,
            overrides.get(def.name) ?? null,
            liveOf(def.name),
            managedRepos,
            isCronEnabled(def, config),
          ),
        );
      });
    },

    toggle(name) {
      const def = defOf(name);
      return withStore((store) => {
        const override = store.get(name);
        const currentlyEnabled = override
          ? override.enabled
          : isCronEnabled(def, config);
        const nextEnabled = !currentlyEnabled;
        store.set(name, { enabled: nextEnabled, updatedBy: 'admin' });
        return { name, enabled: nextEnabled };
      });
    },

    setSchedule(name, schedule) {
      const def = defOf(name);
      const trimmed = (schedule ?? '').trim();
      if (!trimmed) {
        throw new InvalidCronScheduleError('schedule is required');
      }
      validateCronExpression(trimmed);
      return withStore((store) => {
        store.set(name, { schedule: trimmed, updatedBy: 'admin' });
        return { name: def.name, schedule: trimmed };
      });
    },

    resetOverride(name) {
      const def = defOf(name);
      return withStore((store) => {
        store.clear(name);
        return { name, schedule: def.schedule, enabled: true };
      });
    },
  };
}
