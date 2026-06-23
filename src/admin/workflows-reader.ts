import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getRuntimeConfig,
  loadConfig,
  type LastLightConfig,
  type RouteConfig,
} from '../config.ts';
import { CRON_DEFS } from '../crons.ts';

// ── Last Light on Flue · admin workflows-reader seam (workflows browser) ──────
//
// The data layer backing the dashboard's "Workflows browser" — the `/admin/api/
// workflows*` + `/admin/api/skills/:name` routes (operator-auth gated). Modeled
// on `stats-reader.ts` / `runs-reader.ts`: an INJECTABLE `WorkflowsReader` the
// routes mount over; the default (`createDefaultWorkflowsReader`) wires the real
// Flue-shaped discovery, and tests inject a fake so the whole surface runs
// OFFLINE (no fs scan, no sqlite, no Flue runtime).
//
// KEY DIFFERENCE FROM THE REFERENCE (this is a MECHANICAL PORT of the response
// SHAPES, sourced from Flue):
//   In the reference (~/work/lastlight) workflows are YAML files with a rich,
//   DECLARATIVE schema (kind/description/phases/loops/gates). In FLUE a workflow
//   is a TypeScript MODULE in `src/workflows/<name>.ts` (filename = workflow
//   name) discovered by @flue/cli's `discoverModules` — a plain `export async
//   function run(ctx)`, with NO declarative phase/kind/description metadata at
//   all (verified: @flue/runtime ships no list-workflows / phase-metadata API;
//   the CLI scans `src/workflows/*.{ts,js,mts,mjs}` at build time).
//
//   So this reader derives every field it CAN from sources that genuinely exist
//   in Flue, and returns an HONEST DEFAULT for the rest rather than fabricating:
//     • name          → the discovered module basename (the Flue identity).
//     • triggers /
//       triggerKinds  → REAL, derived from `config.routes` (github/slack/mention/
//                       internal) + `CRON_DEFS` (cron), exactly mirroring the
//                       reference `src/workflows/triggers.ts` mapping.
//     • enabled       → REAL kill switch: a persisted per-workflow override,
//                       defaulting to `!config.disabled.workflows.includes(name)`.
//     • yaml          → the workflow module's `.ts` SOURCE TEXT (the best
//                       available "raw definition" — the frontend just displays
//                       it as text; there is no YAML).
//     • prompt/skill  → REAL files (`src/prompts/<path>`, `src/skills/<name>/
//                       SKILL.md`) — Flue's prompts/skills live on disk.
//     • kind          → defaults to the workflow NAME (no Flue `kind` field).
//     • description   → undefined (no Flue description field).
//     • phases        → [] (Flue workflows have NO declarative phases). The
//                       frontend renders an empty pipeline rather than a wrong one.
//   Curated overrides for kind/description/phases MAY be supplied via the
//   optional `metadata` map without inventing data per-workflow.

// ── Frontend contract (dashboard/src/api.ts) — match EXACTLY ──────────────────

/** Mirrors `WorkflowPhaseDefinition` in dashboard/src/api.ts. */
export interface WorkflowPhaseDefinition {
  name: string;
  label: string;
  type: 'context' | 'agent';
  hasLoop?: boolean;
  approvalGate?: string;
}

/** Mirrors `WorkflowDefinition` (GET /workflows/:name). */
export interface WorkflowDefinition {
  name: string;
  kind: string;
  description?: string;
  phases: WorkflowPhaseDefinition[];
}

/** Mirrors `WorkflowFullPhase`. Loosely typed — the dashboard treats most fields
 *  as opaque metadata. */
export interface WorkflowFullPhase {
  name: string;
  label?: string;
  type: 'context' | 'agent';
  prompt?: string;
  skill?: string;
  model?: string;
  approval_gate?: string;
  approval_gate_message?: string;
  messages?: Record<string, string>;
  loop?: Record<string, unknown>;
  generic_loop?: Record<string, unknown>;
  on_output?: Record<string, unknown>;
  on_success?: { set_phase?: string };
  depends_on?: string[];
  trigger_rule?: string;
  output_var?: string;
}

/** Mirrors `WorkflowFullDefinition` (GET /workflows/:name/full). */
export interface WorkflowFullDefinition {
  name: string;
  kind: string;
  description?: string;
  trigger?: string;
  variables?: Record<string, string>;
  phases: WorkflowFullPhase[];
}

/** Mirrors `TriggerKind` / `TriggerInfo` in dashboard/src/api.ts. */
export type TriggerKind = 'cron' | 'github' | 'slack' | 'mention' | 'internal';

export type TriggerInfo =
  | { kind: 'cron'; name: string; schedule: string }
  | { kind: 'github'; event: string; description: string }
  | { kind: 'slack'; command: string; description: string }
  | { kind: 'mention'; description: string }
  | { kind: 'internal'; description: string };

/** Mirrors `WorkflowSummary` (GET /workflows). */
export interface WorkflowSummary {
  name: string;
  kind: string;
  description?: string;
  trigger?: string;
  phaseCount: number;
  hasDag: boolean;
  triggerKinds: TriggerKind[];
  enabled: boolean;
}

// ── The reader seam ───────────────────────────────────────────────────────────

/**
 * One discovered workflow's intrinsic definition — the Flue-derived view of a
 * `src/workflows/<name>.ts` module. This is the SOURCE the route adapters
 * project into the dashboard's `WorkflowSummary` / `WorkflowDefinition` /
 * `WorkflowFullDefinition` shapes.
 */
export interface WorkflowRecord {
  /** Module basename (Flue identity). */
  name: string;
  /** No Flue `kind`; defaults to `name` (or a curated override). */
  kind: string;
  /** No Flue description; undefined unless curated. */
  description?: string;
  /** Reference YAML had a top-level `trigger` slug; no Flue equivalent → undefined. */
  trigger?: string;
  /** No Flue declarative phases → [] unless curated. */
  phases: WorkflowFullPhase[];
  /** No Flue `variables` block → undefined. */
  variables?: Record<string, string>;
}

/**
 * The injectable seam the workflows-browser routes mount over. Every method
 * mirrors a route's data need; the default wires the real Flue discovery, tests
 * inject a fake. Synchronous (the underlying sources are fs/config/sqlite — all
 * in-process), matching the route handlers' synchronous reference shape.
 */
export interface WorkflowsReader {
  /** Discovered workflow records, in discovery order. */
  list(): WorkflowRecord[];
  /** One workflow by name, or null when not discovered. */
  get(name: string): WorkflowRecord | null;
  /** Trigger sources for a workflow (cron + route-derived). */
  triggers(name: string): TriggerInfo[];
  /** Current kill-switch state (persisted override, default from config). */
  isEnabled(name: string): boolean;
  /** Flip the kill switch; returns the new state. */
  setEnabled(name: string, enabled: boolean): boolean;
  /** Raw "definition" text for the yaml view — the module `.ts` SOURCE. */
  rawSource(name: string): string;
  /** A prompt template's text (path under prompts/). */
  loadPrompt(promptPath: string): string;
  /** A skill's SKILL.md text. */
  loadSkill(name: string): string;
}

// ── Pure route adapters (WorkflowRecord → dashboard shapes) ───────────────────

/** Compact the full phases into the dashboard's `WorkflowPhaseDefinition`. */
function toPhaseDefinition(p: WorkflowFullPhase): WorkflowPhaseDefinition {
  return {
    name: p.name,
    label: p.label ?? p.name,
    type: p.type,
    hasLoop: !!p.loop || !!p.generic_loop,
    approvalGate: p.approval_gate,
  };
}

/** Build the `{ workflow }` body for GET /workflows/:name. */
export function toWorkflowDefinition(rec: WorkflowRecord): WorkflowDefinition {
  return {
    name: rec.name,
    kind: rec.kind,
    description: rec.description,
    phases: rec.phases.map(toPhaseDefinition),
  };
}

/** Build the `{ workflow }` body for GET /workflows/:name/full. */
export function toWorkflowFullDefinition(rec: WorkflowRecord): WorkflowFullDefinition {
  return {
    name: rec.name,
    kind: rec.kind,
    description: rec.description,
    trigger: rec.trigger,
    variables: rec.variables,
    phases: rec.phases,
  };
}

/** Order the distinct trigger kinds the dashboard badges (reference order). */
export function triggerKindsOf(triggers: TriggerInfo[]): TriggerKind[] {
  const seen = new Set<TriggerKind>();
  for (const t of triggers) seen.add(t.kind);
  const order: TriggerKind[] = ['cron', 'github', 'mention', 'slack', 'internal'];
  return order.filter((k) => seen.has(k));
}

/** Build one `WorkflowSummary` row (GET /workflows). Pure over the reader. */
export function toWorkflowSummary(
  reader: WorkflowsReader,
  rec: WorkflowRecord,
): WorkflowSummary {
  return {
    name: rec.name,
    kind: rec.kind,
    description: rec.description,
    trigger: rec.trigger,
    phaseCount: rec.phases.length,
    hasDag: rec.phases.some(
      (p) => Array.isArray(p.depends_on) && p.depends_on.length > 0,
    ),
    triggerKinds: triggerKindsOf(reader.triggers(rec.name)),
    enabled: reader.isEnabled(rec.name),
  };
}

/** Build the full `{ workflows }` list body (sorted by name, reference order). */
export function buildWorkflowsList(reader: WorkflowsReader): WorkflowSummary[] {
  const rows = reader.list().map((rec) => toWorkflowSummary(reader, rec));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

// ── Route-derived triggers (mirror of reference src/workflows/triggers.ts) ────
//
// Sourced from `config.routes` (github/slack maps) + `CRON_DEFS`. The reference
// remaps the build alias (`github-orchestrator` → `build`); Flue's build module
// is named `build`, so the github route value `github-orchestrator` is normalized
// here the same way.

function addTrigger(
  map: Map<string, TriggerInfo[]>,
  name: string | undefined,
  info: TriggerInfo,
): void {
  if (!name) return;
  const effective = name === 'github-orchestrator' ? 'build' : name;
  map.set(effective, [...(map.get(effective) ?? []), info]);
}

/** Build the route-derived trigger map keyed by workflow name. */
export function routeTriggers(routes: RouteConfig): Map<string, TriggerInfo[]> {
  const g = routes.github;
  const s = routes.slack;
  const map = new Map<string, TriggerInfo[]>();
  addTrigger(map, g.issue_opened, { kind: 'github', event: 'issue.opened', description: 'An issue is opened' });
  addTrigger(map, g.issue_reopened, { kind: 'github', event: 'issue.reopened', description: 'An issue is reopened' });
  addTrigger(map, g.pr_opened, { kind: 'github', event: 'pr.opened', description: 'A PR is opened' });
  addTrigger(map, g.pr_synchronize, { kind: 'github', event: 'pr.synchronize', description: 'A PR is updated' });
  addTrigger(map, g.pr_reopened, { kind: 'github', event: 'pr.reopened', description: 'A PR is reopened' });
  addTrigger(map, g.pr_fix, { kind: 'mention', description: '`@last-light build …` on a PR comment (maintainers only)' });
  addTrigger(map, g.pr_comment, { kind: 'mention', description: '`@last-light <message>` on a PR comment / review' });
  addTrigger(map, g.issue_build, { kind: 'mention', description: '`@last-light build …` on an issue comment (maintainers only)' });
  addTrigger(map, g.issue_explore, { kind: 'mention', description: '`@last-light explore …` on an issue comment' });
  addTrigger(map, g.issue_comment, { kind: 'mention', description: '`@last-light <message>` on an issue comment' });
  addTrigger(map, g.security_feedback, { kind: 'internal', description: 'Chained from `security-review` when issues are found' });
  addTrigger(map, s.build, { kind: 'slack', command: 'build', description: 'Slack: `build <repo>#<n>`' });
  addTrigger(map, s.triage, { kind: 'slack', command: 'triage', description: 'Slack: `triage <repo>`' });
  addTrigger(map, s.review, { kind: 'slack', command: 'review', description: 'Slack: `review <repo>`' });
  addTrigger(map, s.security, { kind: 'slack', command: 'security', description: 'Slack: `security <repo>`' });
  addTrigger(map, s.explore, { kind: 'slack', command: 'explore', description: 'Slack: `explore <repo>#<n>`' });
  return map;
}

/** Cron + route triggers for a workflow (reference `getWorkflowTriggers` shape). */
export function workflowTriggers(
  name: string,
  routes: RouteConfig,
): TriggerInfo[] {
  const cron: TriggerInfo[] = CRON_DEFS.filter((c) => c.workflow === name).map(
    (c) => ({ kind: 'cron' as const, name: c.name, schedule: c.schedule }),
  );
  return [...cron, ...(routeTriggers(routes).get(name) ?? [])];
}

// ── Discovery (mirror of @flue/cli's discoverModules for `workflow`) ──────────

/** Resolve the `src/` source root (where `workflows/`, `prompts/`, `skills/` live). */
function defaultSourceRoot(): string {
  // The built server BUNDLES this module into `dist/server.mjs`, so an
  // import.meta-relative '..' resolves to `dist/`, NOT `src/` — discovery would
  // scan a non-existent `<root>/workflows` and find zero workflows. The node
  // server runs from the repo root (cwd) where `src/` lives (same cwd-relative
  // convention as `./.data/`), so prefer `<cwd>/src` when it holds a workflows
  // dir, with an env override, and fall back to the import.meta path for the
  // UNBUNDLED case (vitest/tsx, where this file really is at src/admin/…).
  if (process.env.LASTLIGHT_SRC_ROOT) return resolve(process.env.LASTLIGHT_SRC_ROOT);
  const cwdSrc = resolve(process.cwd(), 'src');
  if (existsSync(join(cwdSrc, 'workflows'))) return cwdSrc;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Discover workflow basenames exactly like @flue/cli: scan `src/workflows/` for
 * `*.{ts,js,mts,mjs}` files, drop `.d.ts`/`.d.mts`, drop `.test.*` (colocated
 * tests are NOT workflows — the build scanner sees a clean dir; we filter them
 * here defensively), and use the basename as the workflow name. Subdirectories
 * (e.g. `__tests__/`) are ignored (only regular files are taken).
 */
export function discoverWorkflowNames(workflowsDir: string): string[] {
  if (!existsSync(workflowsDir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(workflowsDir)) {
    if (/\.d\.(ts|mts)$/.test(file)) continue;
    if (/\.test\.(ts|js|mts|mjs)$/.test(file)) continue;
    if (!/\.(ts|js|mts|mjs)$/.test(file)) continue;
    const full = join(workflowsDir, file);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    names.push(file.replace(/\.(ts|js|mts|mjs)$/, ''));
  }
  return names;
}

// ── Persisted per-workflow kill switch (sqlite override store) ────────────────
//
// Flue has no workflow-enable concept; this is the application-owned override the
// reference kept in its `workflow_overrides` table. A tiny sqlite table keyed by
// name; absence ⇒ the config default (`!disabled.workflows.includes(name)`).

/** The override-store seam (so the default reader can be wired to sqlite while
 *  tests use an in-memory map). */
export interface WorkflowOverrideStore {
  /** The stored override for a name, or undefined when none persisted. */
  get(name: string): boolean | undefined;
  /** Persist an override. */
  set(name: string, enabled: boolean): void;
}

/** A file-backed sqlite override store (default). */
export function createSqliteOverrideStore(dbPath: string): WorkflowOverrideStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS workflow_overrides (
       name TEXT PRIMARY KEY,
       enabled INTEGER NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  const selectStmt = db.prepare('SELECT enabled FROM workflow_overrides WHERE name = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO workflow_overrides (name, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  );
  return {
    get(name) {
      const row = selectStmt.get(name) as { enabled?: number } | undefined;
      if (!row || row.enabled === undefined) return undefined;
      return row.enabled === 1;
    },
    set(name, enabled) {
      upsertStmt.run(name, enabled ? 1 : 0, new Date().toISOString());
    },
  };
}

// ── Defaults: the live Flue-backed reader ─────────────────────────────────────

export interface DefaultWorkflowsReaderOptions {
  /** Source root containing `workflows/`, `prompts/`, `skills/`. Defaults to `src/`. */
  sourceRoot?: string;
  /** Resolved config (routes/disabled). Defaults to the runtime config / loadConfig(). */
  config?: LastLightConfig;
  /** Kill-switch override store. Defaults to a sqlite table under the state dir. */
  overrideStore?: WorkflowOverrideStore;
  /**
   * Curated per-workflow metadata overrides (kind/description/phases/trigger/
   * variables). Flue carries none of these declaratively, so they are empty by
   * default; supply this only to enrich specific workflows without fabricating.
   */
  metadata?: Record<string, Partial<WorkflowRecord>>;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * The production workflows reader. Discovers workflows from `src/workflows/`
 * (Flue's convention), derives triggers from config + crons, persists the kill
 * switch in sqlite, and reads prompt/skill files from disk. kind/description/
 * phases default honestly (name / undefined / []) unless a curated `metadata`
 * entry enriches them.
 */
export function createDefaultWorkflowsReader(
  opts: DefaultWorkflowsReaderOptions = {},
): WorkflowsReader {
  const sourceRoot = opts.sourceRoot ?? defaultSourceRoot();
  const workflowsDir = join(sourceRoot, 'workflows');
  const promptsRoot = join(sourceRoot, 'prompts');
  const skillsRoot = join(sourceRoot, 'skills');
  const config = opts.config ?? getRuntimeConfig() ?? loadConfig();
  const metadata = opts.metadata ?? {};
  const overrideStore =
    opts.overrideStore ??
    createSqliteOverrideStore(
      process.env.LASTLIGHT_WORKFLOW_OVERRIDES ??
        join(config.stateDir, 'workflow-overrides.db'),
    );

  const toRecord = (name: string): WorkflowRecord => {
    const m = metadata[name] ?? {};
    return {
      name,
      kind: m.kind ?? name,
      description: m.description,
      trigger: m.trigger,
      phases: m.phases ?? [],
      variables: m.variables,
    };
  };

  const defaultEnabled = (name: string): boolean =>
    !config.disabled.workflows.includes(name);

  const ensureName = (name: string): void => {
    if (!NAME_RE.test(name)) throw new Error(`invalid workflow name: ${name}`);
  };

  const sourcePathFor = (name: string): string | undefined => {
    for (const ext of ['ts', 'js', 'mts', 'mjs']) {
      const candidate = join(workflowsDir, `${name}.${ext}`);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return undefined;
  };

  return {
    list() {
      return discoverWorkflowNames(workflowsDir).map(toRecord);
    },
    get(name) {
      ensureName(name);
      return sourcePathFor(name) ? toRecord(name) : null;
    },
    triggers(name) {
      return workflowTriggers(name, config.routes);
    },
    isEnabled(name) {
      return overrideStore.get(name) ?? defaultEnabled(name);
    },
    setEnabled(name, enabled) {
      overrideStore.set(name, enabled);
      return enabled;
    },
    rawSource(name) {
      ensureName(name);
      const path = sourcePathFor(name);
      if (!path) throw new Error(`workflow source not found: ${name}`);
      return readFileSync(path, 'utf-8');
    },
    loadPrompt(promptPath) {
      // Restrict to the prompts/ subtree (reference loader semantics): no
      // absolute paths, no `..` escapes. The route already validates the
      // `prompts/` prefix; we re-validate here as the file-access floor.
      if (
        !promptPath ||
        promptPath.startsWith('/') ||
        promptPath.includes('..') ||
        promptPath.includes('\0')
      ) {
        throw new Error(`invalid prompt path: ${promptPath}`);
      }
      // Accept either `prompts/foo.md` (reference form) or a bare `foo.md`.
      const rel = promptPath.startsWith('prompts/')
        ? promptPath.slice('prompts/'.length)
        : promptPath;
      const filePath = resolve(promptsRoot, rel);
      if (filePath !== promptsRoot && !filePath.startsWith(promptsRoot + '/')) {
        throw new Error(`prompt path escapes prompts directory: ${promptPath}`);
      }
      return readFileSync(filePath, 'utf-8');
    },
    loadSkill(name) {
      ensureName(name);
      if (config.disabled.skills.includes(name)) {
        throw new Error(`skill is disabled: ${name}`);
      }
      const filePath = join(skillsRoot, name, 'SKILL.md');
      if (filePath !== join(skillsRoot, basename(name), 'SKILL.md')) {
        throw new Error(`skill path escapes skill directory: ${name}`);
      }
      return readFileSync(filePath, 'utf-8');
    },
  };
}
