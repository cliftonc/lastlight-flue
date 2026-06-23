import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Last Light on Flue · cron override store (admin crons slice) ─────────────
//
// The app-owned persistence backing the operator's per-cron schedule/enabled
// OVERRIDES (the dashboard's "edit schedule" / "toggle" / "reset"). The flue
// cron registry (src/crons.ts) is built from the static CRON_DEFS + config; it
// has NO mutable per-cron override seam of its own, so this small raw-sqlite
// table (modeled on src/build-run-store.ts) is the durable home for an
// operator's runtime changes — exactly the role `db.{get,set,clear}CronOverride`
// plays in the reference (~/work/lastlight/src/admin/routes.ts).
//
// One row per overridden cron (keyed on name). A MISSING row = "no override"
// (the cron runs at its CRON_DEFS default schedule, enabled per config). A
// present row may carry a schedule override (nullable) and/or a flipped enabled
// bit. Append-only-ish: additive schema (spec/10 — never drop/narrow a column).

/** A persisted per-cron override row (de-serialized). */
export interface CronOverride {
  name: string;
  /** The overridden cron expression, or null when only `enabled` is overridden. */
  schedule: string | null;
  /** The operator-chosen enabled bit. */
  enabled: boolean;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  /** Who last wrote it (the reference stamps "admin"). */
  updatedBy: string | null;
}

/** The fields a write may set (partial — unset fields keep their prior value). */
export interface CronOverridePatch {
  schedule?: string | null;
  enabled?: boolean;
  updatedBy?: string | null;
}

interface CronOverrideRow {
  name: string;
  schedule: string | null;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
}

export class CronOverrideStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_overrides (
        name       TEXT PRIMARY KEY,
        schedule   TEXT,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT '',
        updated_by TEXT
      );
    `);
  }

  private hydrate(row: CronOverrideRow): CronOverride {
    return {
      name: row.name,
      schedule: row.schedule,
      enabled: row.enabled !== 0,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by ?? null,
    };
  }

  /** The override for one cron, or null when none is persisted. */
  get(name: string): CronOverride | null {
    const row = this.db
      .prepare('SELECT * FROM cron_overrides WHERE name = ?')
      .get(name) as CronOverrideRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** Every persisted override, keyed by cron name. */
  getAll(): Map<string, CronOverride> {
    const rows = this.db
      .prepare('SELECT * FROM cron_overrides')
      .all() as unknown as CronOverrideRow[];
    return new Map(rows.map((r) => [r.name, this.hydrate(r)]));
  }

  /**
   * Upsert an override. Unset patch fields keep their prior value (so a
   * schedule-only write doesn't clobber a prior enabled flip and vice-versa);
   * `enabled` defaults to true on first write (the cron's natural default).
   */
  set(name: string, patch: CronOverridePatch): CronOverride {
    const prev = this.get(name);
    const schedule = patch.schedule !== undefined ? patch.schedule : prev?.schedule ?? null;
    const enabled = patch.enabled !== undefined ? patch.enabled : prev?.enabled ?? true;
    const updatedBy = patch.updatedBy !== undefined ? patch.updatedBy : prev?.updatedBy ?? null;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO cron_overrides (name, schedule, enabled, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           schedule = excluded.schedule,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(name, schedule, enabled ? 1 : 0, updatedAt, updatedBy);
    return this.get(name)!;
  }

  /** Drop the override row (reset to the cron's CRON_DEFS default). */
  clear(name: string): void {
    this.db.prepare('DELETE FROM cron_overrides WHERE name = ?').run(name);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
