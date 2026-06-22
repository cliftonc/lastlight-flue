import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Phase 4 — the application-owned BUILD run record (the resume contract).
//
// This is the real build run-record: it grows the Phase-0 spike's `run-store.ts`
// (id / step-done / pending_gate / restart_count / status) into the build cycle's
// durable cursor. It stays APP-OWNED (raw sqlite, NOT Flue's RunStore) because Flue
// does NOT checkpoint workflow run() — a re-invocation runs run() from the top, and
// this record is what lets it skip already-completed, side-effecting phases.
//
// Two ids are kept DISTINCT (see design/phase-4 + spec/06): the APP `runId` (a
// stable caller-owned key carried in the workflow input — the resume contract) vs
// Flue's per-invocation runId. This table is keyed on the app runId.
//
// Per spec/10 the SPLIT RULE holds: `scratch` holds POINTERS (file paths on the
// branch / handoff folder), never inlined blobs — unbounded text never lands in
// this frequently-listed row.

/** The breaker cap (spec/06): a run resumed > this many times terminalizes. */
export const MAX_RESTART_RESUMES = 3;

/** Gate names (positive-enable). The reviewer gate carries a cycle suffix. */
export type GateName = 'post_architect' | `post_reviewer:${number}`;

export type BuildStatus = 'active' | 'paused' | 'complete' | 'failed';

/** The de-serialized build run record (JSON columns parsed). */
export interface BuildRun {
  id: string; // = app runId (the resume contract / idempotency key)
  owner: string;
  repo: string;
  issue: number;
  branch: string;
  taskId: string;
  /** Idempotency keys: a phase present here is DONE → shouldRunPhase skips it. */
  phasesDone: Record<string, true>;
  /** POINTERS only (file paths), never blobs — preserves spec/10's split rule. */
  scratch: Record<string, string>;
  /** The gate the run is parked at, or null. */
  pendingGate: GateName | null;
  /** Reviewer fix/recheck loop iteration cursor. */
  reviewerCycle: number;
  /** Breaker counter (capped at MAX_RESTART_RESUMES). */
  restartCount: number;
  status: BuildStatus;
  /** Why the run failed (breaker / reject / guardrails), for the audit trail. */
  failReason: string | null;
}

/** The raw on-disk row shape (JSON columns un-parsed). */
interface BuildRunRow {
  id: string;
  owner: string;
  repo: string;
  issue: number;
  branch: string;
  task_id: string;
  phases_done: string;
  scratch: string;
  pending_gate: string | null;
  reviewer_cycle: number;
  restart_count: number;
  status: BuildStatus;
  fail_reason: string | null;
}

/** The fields needed to first create a run (the workflow input identity). */
export interface BuildRunSeed {
  owner: string;
  repo: string;
  issue: number;
  branch: string;
  taskId: string;
}

export class BuildRunStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL keeps a reader from blocking the writer across quick process restarts.
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Additive-only schema (spec/10): never drop/narrow a column.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS build_runs (
        id             TEXT PRIMARY KEY,
        owner          TEXT NOT NULL DEFAULT '',
        repo           TEXT NOT NULL DEFAULT '',
        issue          INTEGER NOT NULL DEFAULT 0,
        branch         TEXT NOT NULL DEFAULT '',
        task_id        TEXT NOT NULL DEFAULT '',
        phases_done    TEXT NOT NULL DEFAULT '{}',
        scratch        TEXT NOT NULL DEFAULT '{}',
        pending_gate   TEXT,
        reviewer_cycle INTEGER NOT NULL DEFAULT 0,
        restart_count  INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active',
        fail_reason    TEXT
      );
    `);
  }

  private hydrate(row: BuildRunRow): BuildRun {
    return {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      issue: row.issue,
      branch: row.branch,
      taskId: row.task_id,
      phasesDone: JSON.parse(row.phases_done) as Record<string, true>,
      scratch: JSON.parse(row.scratch) as Record<string, string>,
      pendingGate: row.pending_gate as GateName | null,
      reviewerCycle: row.reviewer_cycle,
      restartCount: row.restart_count,
      status: row.status,
      failReason: row.fail_reason,
    };
  }

  /** First-writer-wins create (idempotent on the app runId); returns the record. */
  getOrCreate(id: string, seed: BuildRunSeed): BuildRun {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO build_runs (id, owner, repo, issue, branch, task_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, seed.owner, seed.repo, seed.issue, seed.branch, seed.taskId);
    return this.get(id)!;
  }

  get(id: string): BuildRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM build_runs WHERE id = ?')
      .get(id) as BuildRunRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** Resume cursor: a phase already in phasesDone is skipped on re-invoke. */
  shouldRunPhase(run: BuildRun, phase: string): boolean {
    return !run.phasesDone[phase];
  }

  /**
   * Mark a phase done, atomically with its scratch pointer. Re-reads the current
   * row so concurrent fields aren't clobbered (last-completed-phase wins).
   */
  markPhaseDone(id: string, phase: string, scratch?: Record<string, string>): void {
    const cur = this.get(id);
    if (!cur) return;
    const phasesDone = { ...cur.phasesDone, [phase]: true as const };
    const merged = scratch ? { ...cur.scratch, ...scratch } : cur.scratch;
    this.db
      .prepare('UPDATE build_runs SET phases_done = ?, scratch = ? WHERE id = ?')
      .run(JSON.stringify(phasesDone), JSON.stringify(merged), id);
  }

  /** Suspend at a gate: record the pending gate + mark paused. Idempotent. */
  setPending(id: string, gate: GateName): void {
    this.db
      .prepare("UPDATE build_runs SET pending_gate = ?, status = 'paused' WHERE id = ?")
      .run(gate, id);
  }

  /** Clear the pending marker on resume (status → active). Does NOT bump restart. */
  clearPending(id: string): void {
    this.db
      .prepare("UPDATE build_runs SET pending_gate = NULL, status = 'active' WHERE id = ?")
      .run(id);
  }

  setCycle(id: string, cycle: number): void {
    this.db.prepare('UPDATE build_runs SET reviewer_cycle = ? WHERE id = ?').run(cycle, id);
  }

  /**
   * Breaker: increment restart_count and return the NEW value. Each (re-)invoke
   * (resume signal or boot recovery) calls this; the caller fails the run when the
   * value exceeds MAX_RESTART_RESUMES (spec/06 — cap crash loops).
   */
  bumpRestart(id: string): number {
    this.db
      .prepare('UPDATE build_runs SET restart_count = restart_count + 1 WHERE id = ?')
      .run(id);
    return this.get(id)!.restartCount;
  }

  complete(id: string): void {
    this.db.prepare("UPDATE build_runs SET status = 'complete' WHERE id = ?").run(id);
  }

  fail(id: string, reason: string): void {
    this.db
      .prepare("UPDATE build_runs SET status = 'failed', fail_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  /** Active (non-paused) runs to re-invoke on boot. Paused runs await a human. */
  listActive(): BuildRun[] {
    const rows = this.db
      .prepare("SELECT * FROM build_runs WHERE status = 'active'")
      .all() as unknown as BuildRunRow[];
    return rows.map((r) => this.hydrate(r));
  }

  close(): void {
    if (this.closed) return; // idempotent — double-close is a no-op
    this.closed = true;
    this.db.close();
  }
}
