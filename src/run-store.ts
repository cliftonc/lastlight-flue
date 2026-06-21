import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Phase 0 · Spike 3 — the application-owned run record.
//
// Flue workflows are NOT resumable: a re-invocation runs `run()` again as a fresh
// invocation (new Flue runId), so the workflow-level approval gate must be owned
// by the application. This raw-SQLite table is that durable cursor — it survives a
// process restart (it's on disk) and lets a re-invoked workflow reproduce
// `shouldRunPhase` and skip already-completed, side-effecting steps (idempotency).
//
// Keep the APP runId (a stable key the caller controls, e.g. issue/PR/thread) it
// distinct from Flue's per-invocation runId. Phase 4 grows this into the real
// run/approvals/stats store; here it carries just the spike's gate cursor.

export interface RunRecord {
  id: string;
  step1_done: number; // 0 | 1
  step2_done: number; // 0 | 1
  pending_gate: string | null;
  restart_count: number;
  status: string; // 'active' | 'pending' | 'done' | 'failed'
}

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL keeps a reader from blocking the writer across quick process restarts.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        step1_done    INTEGER NOT NULL DEFAULT 0,
        step2_done    INTEGER NOT NULL DEFAULT 0,
        pending_gate  TEXT,
        restart_count INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'active'
      );
    `);
  }

  getOrCreate(id: string): RunRecord {
    this.db.prepare('INSERT OR IGNORE INTO runs (id) VALUES (?)').run(id);
    return this.get(id)!;
  }

  get(id: string): RunRecord | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
  }

  markStep1(id: string): void {
    this.db.prepare('UPDATE runs SET step1_done = 1 WHERE id = ?').run(id);
  }

  markStep2(id: string): void {
    this.db.prepare('UPDATE runs SET step2_done = 1 WHERE id = ?').run(id);
  }

  /** Suspend at a gate: record the pending gate and mark the run pending. */
  setPending(id: string, gate: string): void {
    this.db
      .prepare("UPDATE runs SET pending_gate = ?, status = 'pending' WHERE id = ?")
      .run(gate, id);
  }

  /**
   * Resume past a gate. Clears the pending marker and increments restart_count —
   * the Phase-4 breaker caps this (≤3) to stop a wedged run from looping forever.
   */
  clearPending(id: string): void {
    this.db
      .prepare(
        "UPDATE runs SET pending_gate = NULL, status = 'active', restart_count = restart_count + 1 WHERE id = ?",
      )
      .run(id);
  }

  setStatus(id: string, status: string): void {
    this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
  }

  close(): void {
    this.db.close();
  }
}
