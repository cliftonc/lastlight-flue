import { invokeFlueRun } from './agent-lib/invoke-flue-run.ts';
import { Cron, scheduledJobs } from 'croner';
import { getRuntimeConfig, loadConfig, type LastLightConfig } from './config.ts';

// ── Last Light on Flue · cron scheduler (Phase 5 · FINAL slice) ──────────────
//
// The four scheduled jobs, ported from the reference's `workflows/cron-*.yaml`
// (~/work/lastlight/workflows/cron-{health,review,security,triage}.yaml) +
// `src/cron/{scheduler,jobs,fanout}.ts`. Each cron, on its tick, FANS OUT over
// the managed repos and INVOKES the target workflow once per repo.
//
// INVOKE MECHANISM — the SAME path as `src/resume.ts`'s `reinvoke`: in-process
// `invoke(workflow, { input })` (beta.3), via `src/agent-lib/invoke-flue-run.ts`.
// (Beta.2 had NO top-level `invoke` — flue-reference §0/§9 — so this used to spawn a
// fresh `flue run` process; beta.3 exports it, so we call the runtime directly. This
// also keeps the agent transcript off stdout — see invoke-flue-run.ts.) It is an
// INJECTED seam (`invoke`) so tests never touch the real runtime. The fan-out is now
// fire-and-forget: each per-repo run admits quickly and proceeds concurrently under the
// runtime's own scheduling, rather than serially awaiting a child process's exit.
//
// POSITIVE-ENABLE — a cron registers only when ENABLED. `enabled` is computed
// from config: a cron is enabled unless its name is in `config.disabled.crons`
// (the existing negative-list config seam → effective positive-enable per job),
// AND, for the webhook-gated crons (cron-triage / cron-review, reference
// `condition.unless: webhooksEnabled`), only when webhooks are NOT enabled
// (the dual real-time/poll model — when WEBHOOK_SECRET is set those events
// arrive live, so the polling cron is redundant and stays off).
//
// VITEST-INERT — `startCrons()` is run-once + SKIPPED under VITEST /
// LASTLIGHT_SKIP_CRONS so a unit import or a test run NEVER schedules a real
// croner timer or spawns a real `flue run`. The croner jobs are constructed
// `{ paused: true }` and only `.resume()`d by `startCrons()` — so merely
// building the registry (what tests do) leaves NO live timer running.
//
// SHUTDOWN — `stopCrons()` calls `.stop()` on every job. It is invoked from an
// ADDITIVE `process.on('SIGTERM'|'SIGINT', …)` handler in `src/app.ts` module
// scope (NOT a forked server entry — see flue-reference §0 + app.ts). Flue's
// generated-entry signal handler still runs alongside it (handlers are additive
// in Node) and owns the agent/db shutdown + `process.exit`.
//
// NOTE: `crons.ts` lives at `src/` top-level — NOT under `src/workflows/` or
// `src/agents/` — so Flue's discovery does NOT pick it up as an entry (no
// phantom workflow/agent). It is wired in by import from `src/app.ts`.

/** The injectable invoke seam: fire one workflow run with a JSON payload. */
export type CronInvoker = (
  workflow: string,
  payload: Record<string, unknown>,
) => Promise<void>;

/**
 * Default production invoker: in-process `invoke(workflow, { input })` — the SAME
 * re-entry `src/resume.ts` uses. NEVER called under tests (the registry/fanout tests
 * inject a fake; `startCrons` is VITEST-inert).
 */
export const defaultCronInvoker: CronInvoker = async (workflow, payload) => {
  await invokeFlueRun(workflow, payload);
};

/** A registered cron job definition (pre-scheduling). */
export interface CronJobDef {
  /** Cron job name (matches the reference cron-*.yaml `name`). */
  name: string;
  /** Cron expression (croner pattern). */
  schedule: string;
  /** The workflow each tick invokes (filename = workflow name). */
  workflow: string;
  /** Static per-tick context merged into every per-repo payload. */
  context: Record<string, unknown>;
  /**
   * When true the cron is gated by `condition.unless: webhooksEnabled` — it is
   * only enabled while webhooks are DISABLED (reference dual model).
   */
  webhookGated: boolean;
}

/**
 * The four cron jobs, ported verbatim (name/schedule/workflow/context) from the
 * reference cron-*.yaml. The `webhookGated` flag reproduces
 * `condition.unless: webhooksEnabled`.
 */
export const CRON_DEFS: readonly CronJobDef[] = [
  {
    // cron-health.yaml — weekly repo-health scan (Mondays 09:00).
    name: 'weekly-health-report',
    schedule: '0 9 * * 1',
    workflow: 'repo-health',
    context: { mode: 'report' },
    webhookGated: false,
  },
  {
    // cron-security.yaml — weekly security-review scan (Mondays 10:00).
    name: 'weekly-security-scan',
    schedule: '0 10 * * 1',
    workflow: 'security-review',
    context: { deliverSlackSummary: true },
    webhookGated: false,
  },
  {
    // cron-triage.yaml — poll for new issues to triage (every 15m); only when
    // webhooks are disabled (otherwise issue_opened arrives live).
    name: 'triage-new-issues',
    schedule: '*/15 * * * *',
    workflow: 'issue-triage',
    context: { mode: 'scan' },
    webhookGated: true,
  },
  {
    // cron-review.yaml — poll for PRs awaiting review (every 30m); only when
    // webhooks are disabled.
    name: 'check-prs-awaiting-review',
    schedule: '*/30 * * * *',
    workflow: 'pr-review',
    context: { mode: 'scan' },
    webhookGated: true,
  },
] as const;

/** Resolve whether webhooks are enabled (WEBHOOK_SECRET present). */
function webhooksEnabled(config: LastLightConfig): boolean {
  return Boolean(config.webhookSecret);
}

/**
 * Positive-enable predicate for a cron: enabled unless disabled in config, and
 * (for webhook-gated crons) only when webhooks are NOT enabled.
 */
export function isCronEnabled(def: CronJobDef, config: LastLightConfig): boolean {
  if (config.disabled.crons.includes(def.name)) return false;
  if (def.webhookGated && webhooksEnabled(config)) return false;
  return true;
}

/**
 * Build the per-repo payload for one fan-out invoke. Mirrors the reference
 * fanout: drops the repo array, stamps `triggerType: 'cron'`, and supplies the
 * repo as `{owner, repo}` (our repo-scoped workflows take owner/repo, not the
 * `owner/repo` slug) plus the cron's static context. Returns null for a
 * malformed slug (skipped — never invoked).
 */
export function buildCronPayload(
  def: CronJobDef,
  repoSlug: string,
): Record<string, unknown> | null {
  const slash = repoSlug.indexOf('/');
  if (slash <= 0 || slash === repoSlug.length - 1) return null;
  const owner = repoSlug.slice(0, slash);
  const repo = repoSlug.slice(slash + 1);
  return { ...def.context, owner, repo, triggerType: 'cron' };
}

/** Options for building the cron registry (all seams injectable for tests). */
export interface CronRegistryOptions {
  /** The resolved config. Defaults to the runtime config (or loadConfig()). */
  config?: LastLightConfig;
  /** Managed repos to fan out over. Defaults to `config.managedRepos`. */
  managedRepos?: string[];
  /** The invoke seam. Defaults to spawning `flue run` (NEVER in tests). */
  invoke?: CronInvoker;
}

/**
 * One scheduled cron in the registry: its def + the croner instance + a direct
 * `trigger()` (the fan-out, callable in tests WITHOUT scheduling) + `stop()`.
 */
export interface RegisteredCron {
  def: CronJobDef;
  /** The croner instance (constructed paused → no live timer until resumed). */
  cron: Cron;
  /** Fire the fan-out NOW (one invoke per managed repo). Returns invoke count. */
  trigger(): Promise<number>;
  /** Stop this cron's timer. */
  stop(): void;
}

/**
 * The cron registry: the set of ENABLED scheduled jobs plus lifecycle control.
 * Built with all jobs PAUSED — `start()` resumes them (the only thing that
 * arms a real timer). `stop()` halts every job.
 */
export class CronRegistry {
  readonly crons: RegisteredCron[];
  private started = false;
  private running = new Set<string>();

  constructor(opts: CronRegistryOptions = {}) {
    const config = opts.config ?? getRuntimeConfig() ?? loadConfig();
    const managedRepos = opts.managedRepos ?? config.managedRepos;
    const invoke = opts.invoke ?? defaultCronInvoker;

    this.crons = CRON_DEFS.filter((def) => isCronEnabled(def, config)).map(
      (def) => {
        const trigger = async (): Promise<number> => {
          // Overlap protection (reference scheduler): skip if still running.
          if (this.running.has(def.name)) return 0;
          this.running.add(def.name);
          let dispatched = 0;
          try {
            for (const slug of managedRepos) {
              const payload = buildCronPayload(def, slug);
              if (!payload) continue;
              try {
                await invoke(def.workflow, payload);
                dispatched++;
              } catch (err) {
                // Per-repo isolation + non-fatal: one repo's failure must not
                // abort the rest of the fan-out (reference fanout semantics).
                console.error(
                  `[cron] ${def.name} → ${def.workflow} failed for ${slug}:`,
                  err,
                );
              }
            }
          } finally {
            this.running.delete(def.name);
          }
          return dispatched;
        };
        // Evict any stale croner job with this name FIRST. croner keeps named
        // jobs in a PROCESS-GLOBAL `scheduledJobs` array that survives Vite's HMR
        // module re-eval — so a dev-server reload would re-build this registry and
        // collide ("name already taken") with the prior module instance's job.
        // `stop()` splices the job out of the global array, freeing the name.
        for (const stale of scheduledJobs.filter((j) => j.name === def.name)) {
          stale.stop();
        }
        // Construct PAUSED → no live timer until start(); merely building the
        // registry (tests) never schedules anything.
        const cron = new Cron(def.schedule, { paused: true, name: def.name }, () => {
          void trigger();
        });
        return {
          def,
          cron,
          trigger,
          stop: () => cron.stop(),
        };
      },
    );
  }

  /** Names of the registered (enabled) crons. */
  names(): string[] {
    return this.crons.map((c) => c.def.name);
  }

  /** Arm every cron's timer (resume from paused). Idempotent (run-once). */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const c of this.crons) {
      c.cron.resume();
      console.log(`[cron] Started: ${c.def.name} (${c.def.schedule})`);
    }
  }

  /** Stop every cron's timer. Safe to call repeatedly. */
  stop(): void {
    for (const c of this.crons) c.stop();
  }
}

// ── Module-level lifecycle (mirrors app.ts's boot-recovery hook) ─────────────
// A single process-wide registry, lazily built on first `startCrons()`. Held so
// the SIGTERM/SIGINT handler in app.ts can `.stop()` exactly the crons that were
// started.

let registry: CronRegistry | undefined;
let cronsStarted = false;

/**
 * Start the cron scheduler at server boot. Called from `src/app.ts` module
 * scope, ALONGSIDE the boot-recovery hook. Like that hook it is:
 *   - run-once (a module guard so a re-import can't double-schedule);
 *   - non-blocking + non-fatal (errors are logged, never thrown);
 *   - SKIPPED under VITEST / LASTLIGHT_SKIP_CRONS=1 so unit imports + tests
 *     never schedule a real timer or spawn a real `flue run`.
 * Returns the registry (or undefined when skipped) for the shutdown handler.
 */
export function startCrons(): CronRegistry | undefined {
  if (cronsStarted) return registry;
  cronsStarted = true;
  if (process.env.LASTLIGHT_SKIP_CRONS === '1' || process.env.VITEST) {
    return undefined;
  }
  try {
    registry = new CronRegistry();
    registry.start();
    if (registry.crons.length) {
      console.log(`[cron] scheduled ${registry.crons.length} cron(s): ${registry.names().join(', ')}`);
    }
  } catch (err) {
    console.error('[cron] failed to start crons (non-fatal):', err);
  }
  return registry;
}

/**
 * Stop all started crons. Called from the additive SIGTERM/SIGINT handler in
 * app.ts. No-op when crons were never started. Non-fatal.
 */
export function stopCrons(): void {
  try {
    registry?.stop();
  } catch (err) {
    console.error('[cron] failed to stop crons (non-fatal):', err);
  }
}

/**
 * The live process-wide cron registry `startCrons()` owns, or `undefined` before
 * it has run (or when skipped under VITEST / LASTLIGHT_SKIP_CRONS). The admin
 * crons-reader consults this for `registered`/`nextRun` instead of constructing
 * its own registry — a second registry would collide on croner's global job
 * names and make the real scheduler fail to start.
 */
export function getCronRegistry(): CronRegistry | undefined {
  return registry;
}
