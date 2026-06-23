import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Phase 5 — the application-owned EXPLORE run record (the reply-gate contract).
//
// explore is the Socratic research loop: read/research → ask clarifying questions
// (a REPLY GATE: the human answers in the thread) → research → synthesize → publish.
// Like the build cycle (src/build-run-store.ts) Flue does NOT checkpoint workflow
// run(), so this APP-OWNED record (raw sqlite) is what makes a re-invoke skip the
// already-completed, side-effecting phases AND carry the accumulated Socratic Q&A
// across reply-gate pauses.
//
// It mirrors BuildRunStore's shape (phasesDone cursor / pendingGate / restart_count /
// scratch POINTERS) with two explore-specific additions:
//   - `socraticIter`: the Socratic loop cursor (which question round we're on), so a
//     resume re-enters the SAME round instead of restarting the conversation.
//   - the Q&A is accumulated in `scratch.socratic.qa` — a growing transcript of
//     question/answer turns. This is the ONE place a small bounded blob is allowed to
//     live in the record (the conversation IS the durable state the reply-gate exists
//     to preserve); everything else (the context doc, the spec) stays a POINTER per
//     spec/10's split rule (the agent writes those to files on disk / the branch).
//
// Two ids stay DISTINCT (design/phase-4 + spec/06): the APP `runId` (a stable
// caller-owned key carried in the workflow input — the reply contract) vs Flue's
// per-invocation runId. This table is keyed on the app runId.

/** The breaker cap (spec/06): a run resumed > this many times terminalizes. */
export const MAX_RESTART_RESUMES = 3;

/** Hard cap on Socratic rounds (reference explore.yaml `max_iterations: 8`). */
export const MAX_SOCRATIC_ROUNDS = 8;

/** The reply gate name carries the Socratic round it parked at. */
export type ReplyGate = `reply:${number}`;

export type ExploreStatus = 'active' | 'paused' | 'complete' | 'failed';

/** The accumulated Socratic state surfaced into the prompt's `scratch.socratic.*`. */
export interface SocraticScratch {
  /** Growing question/answer transcript across reply-gate pauses. */
  qa: string;
  /** Set true once the ask phase signals READY (or the round cap is hit). */
  ready: boolean;
}

/** The de-serialized explore run record (JSON columns parsed). */
export interface ExploreRun {
  id: string; // = app runId (the reply contract / idempotency key)
  owner: string;
  repo: string;
  /** The originating issue number (0 / absent for a Slack-originated run). */
  issue: number;
  /** A stable trigger id (e.g. `slack:team:chan:thread`) for non-GitHub origins. */
  triggerId: string;
  /** Idempotency keys: a phase present here is DONE → shouldRunPhase skips it. */
  phasesDone: Record<string, true>;
  /** POINTERS only (file paths) PLUS the bounded socratic blob (see module note). */
  scratch: Record<string, string>;
  /**
   * The CHANNEL conversation key (issue/thread) this reply gate is parked on — the
   * SAME `conversationKey` a channel computes from an event (Phase 6 gate
   * correlation). Recorded at the reply-gate pause so a channel reply on that
   * conversation resolves THIS run via `findPausedRunByConversation`. Distinct from
   * `triggerId` (the legacy `owner/repo#issue` key the channels also pass): both are
   * indexed so either correlation path resolves the same paused run. Null on a run
   * with no channel conversation. (Optional in the interface so existing run-literal
   * fixtures stay valid; the hydrate path always populates it.)
   */
  conversationKey?: string | null;
  /** The accumulated Socratic Q&A + ready flag (folded into the prompt context). */
  socratic: SocraticScratch;
  /** The Socratic loop cursor — which question round the loop is on. */
  socraticIter: number;
  /** The reply gate the run is parked at, or null. */
  pendingGate: ReplyGate | null;
  /** Breaker counter (capped at MAX_RESTART_RESUMES). */
  restartCount: number;
  status: ExploreStatus;
  /** Why the run failed (breaker), for the audit trail. */
  failReason: string | null;
}

/** The raw on-disk row shape (JSON columns un-parsed). */
interface ExploreRunRow {
  id: string;
  owner: string;
  repo: string;
  issue: number;
  trigger_id: string;
  phases_done: string;
  scratch: string;
  conversation_key: string | null;
  socratic: string;
  socratic_iter: number;
  pending_gate: string | null;
  restart_count: number;
  status: ExploreStatus;
  fail_reason: string | null;
}

/** The fields needed to first create a run (the workflow input identity). */
export interface ExploreRunSeed {
  owner: string;
  repo: string;
  issue: number;
  triggerId: string;
}

const EMPTY_SOCRATIC: SocraticScratch = { qa: '', ready: false };

export class ExploreRunStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Additive-only schema (spec/10): never drop/narrow a column.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS explore_runs (
        id            TEXT PRIMARY KEY,
        owner         TEXT NOT NULL DEFAULT '',
        repo          TEXT NOT NULL DEFAULT '',
        issue         INTEGER NOT NULL DEFAULT 0,
        trigger_id    TEXT NOT NULL DEFAULT '',
        phases_done   TEXT NOT NULL DEFAULT '{}',
        scratch       TEXT NOT NULL DEFAULT '{}',
        conversation_key TEXT,
        socratic      TEXT NOT NULL DEFAULT '{"qa":"","ready":false}',
        socratic_iter INTEGER NOT NULL DEFAULT 0,
        pending_gate  TEXT,
        restart_count INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'active',
        fail_reason   TEXT
      );
    `);
    // MIGRATION-SAFE additive column (spec/10 — never drop/narrow): an existing db
    // created before the Phase-6 gate-correlation slice lacks `conversation_key`.
    // Add it idempotently; existing rows default to NULL. A fresh db (CREATE TABLE
    // already added it) is a clean no-op.
    this.ensureColumn('conversation_key', 'TEXT');
  }

  /** Add a column if it is missing — idempotent, migration-safe (additive only). */
  private ensureColumn(name: string, decl: string): void {
    const cols = this.db
      .prepare('PRAGMA table_info(explore_runs)')
      .all() as unknown as Array<{ name: string }>;
    if (cols.some((c) => c.name === name)) return;
    this.db.exec(`ALTER TABLE explore_runs ADD COLUMN ${name} ${decl};`);
  }

  private hydrate(row: ExploreRunRow): ExploreRun {
    return {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      issue: row.issue,
      triggerId: row.trigger_id,
      phasesDone: JSON.parse(row.phases_done) as Record<string, true>,
      scratch: JSON.parse(row.scratch) as Record<string, string>,
      conversationKey: row.conversation_key ?? null,
      socratic: { ...EMPTY_SOCRATIC, ...(JSON.parse(row.socratic) as Partial<SocraticScratch>) },
      socraticIter: row.socratic_iter,
      pendingGate: row.pending_gate as ReplyGate | null,
      restartCount: row.restart_count,
      status: row.status,
      failReason: row.fail_reason,
    };
  }

  /** First-writer-wins create (idempotent on the app runId); returns the record. */
  getOrCreate(id: string, seed: ExploreRunSeed): ExploreRun {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO explore_runs (id, owner, repo, issue, trigger_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, seed.owner, seed.repo, seed.issue, seed.triggerId);
    return this.get(id)!;
  }

  get(id: string): ExploreRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM explore_runs WHERE id = ?')
      .get(id) as ExploreRunRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** Resume cursor: a phase already in phasesDone is skipped on re-invoke. */
  shouldRunPhase(run: ExploreRun, phase: string): boolean {
    return !run.phasesDone[phase];
  }

  /** Mark a phase done, atomically with its scratch pointer. */
  markPhaseDone(id: string, phase: string, scratch?: Record<string, string>): void {
    const cur = this.get(id);
    if (!cur) return;
    const phasesDone = { ...cur.phasesDone, [phase]: true as const };
    const merged = scratch ? { ...cur.scratch, ...scratch } : cur.scratch;
    this.db
      .prepare('UPDATE explore_runs SET phases_done = ?, scratch = ? WHERE id = ?')
      .run(JSON.stringify(phasesDone), JSON.stringify(merged), id);
  }

  /** Merge scratch POINTERS without marking a phase done. */
  recordScratch(id: string, scratch: Record<string, string>): void {
    const cur = this.get(id);
    if (!cur) return;
    const merged = { ...cur.scratch, ...scratch };
    this.db.prepare('UPDATE explore_runs SET scratch = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }

  /**
   * Append a question→answer turn to the accumulated Socratic transcript. The
   * question is what the ask phase asked this round; the answer is the human's reply
   * folded in on resume. Re-reads the current row so the transcript only grows.
   */
  appendSocraticTurn(id: string, turn: { question?: string; answer?: string }): void {
    const cur = this.get(id);
    if (!cur) return;
    const parts: string[] = [cur.socratic.qa];
    if (turn.question) parts.push(`Q: ${turn.question.trim()}`);
    if (turn.answer) parts.push(`A: ${turn.answer.trim()}`);
    const qa = parts.filter(Boolean).join('\n\n').trim();
    const socratic: SocraticScratch = { qa, ready: cur.socratic.ready };
    this.db.prepare('UPDATE explore_runs SET socratic = ? WHERE id = ?').run(JSON.stringify(socratic), id);
  }

  /** Flag the Socratic loop as ready (enough signal — advance to synthesize). */
  setSocraticReady(id: string, ready: boolean): void {
    const cur = this.get(id);
    if (!cur) return;
    const socratic: SocraticScratch = { qa: cur.socratic.qa, ready };
    this.db.prepare('UPDATE explore_runs SET socratic = ? WHERE id = ?').run(JSON.stringify(socratic), id);
  }

  /** Advance (or set) the Socratic loop cursor. */
  setSocraticIter(id: string, iter: number): void {
    this.db.prepare('UPDATE explore_runs SET socratic_iter = ? WHERE id = ?').run(iter, id);
  }

  /**
   * Record the CHANNEL conversation key this reply gate is parked on (Phase 6 gate
   * correlation). Idempotent; null/empty is ignored. The key is the SAME string a
   * channel computes from an event, so a later reply on that conversation resolves
   * this run via `findPausedRunByConversation`.
   */
  setConversationKey(id: string, conversationKey: string | null | undefined): void {
    if (!conversationKey) return;
    this.db
      .prepare('UPDATE explore_runs SET conversation_key = ? WHERE id = ?')
      .run(conversationKey, id);
  }

  /**
   * Resolve the app runId of the explore run currently PAUSED awaiting a reply on
   * this conversation (Phase 6 gate correlation — the channel reply-gate lookup).
   * Matches EITHER the channel `conversation_key` OR the legacy `trigger_id` (the
   * channels historically passed `triggerId: ev.conversationKey`), so both
   * correlation paths resolve the same paused run. Returns undefined when none is
   * parked (a clean no-op). Only `paused` runs with a non-null `pending_gate` match —
   * a resolved/terminal run is never returned.
   */
  findPausedRunByConversation(conversationKey: string): string | undefined {
    if (!conversationKey) return undefined;
    const row = this.db
      .prepare(
        "SELECT id FROM explore_runs WHERE status = 'paused' AND pending_gate IS NOT NULL " +
          'AND (conversation_key = ? OR trigger_id = ?) ORDER BY rowid DESC LIMIT 1',
      )
      .get(conversationKey, conversationKey) as { id: string } | undefined;
    return row?.id;
  }

  /** Suspend at a reply gate: record the pending gate + mark paused. Idempotent. */
  setPending(id: string, gate: ReplyGate): void {
    this.db
      .prepare("UPDATE explore_runs SET pending_gate = ?, status = 'paused' WHERE id = ?")
      .run(gate, id);
  }

  /** Clear the pending marker on resume (status → active). Does NOT bump restart. */
  clearPending(id: string): void {
    this.db
      .prepare("UPDATE explore_runs SET pending_gate = NULL, status = 'active' WHERE id = ?")
      .run(id);
  }

  /**
   * Breaker: increment restart_count and return the NEW value. The caller fails the
   * run when the value exceeds MAX_RESTART_RESUMES (spec/06 — cap crash loops).
   */
  bumpRestart(id: string): number {
    this.db
      .prepare('UPDATE explore_runs SET restart_count = restart_count + 1 WHERE id = ?')
      .run(id);
    return this.get(id)!.restartCount;
  }

  complete(id: string): void {
    this.db.prepare("UPDATE explore_runs SET status = 'complete' WHERE id = ?").run(id);
  }

  fail(id: string, reason: string): void {
    this.db
      .prepare("UPDATE explore_runs SET status = 'failed', fail_reason = ? WHERE id = ?")
      .run(reason, id);
  }

  /** Active (non-paused) runs to re-invoke on boot. Paused runs await a human reply. */
  listActive(): ExploreRun[] {
    const rows = this.db
      .prepare("SELECT * FROM explore_runs WHERE status = 'active'")
      .all() as unknown as ExploreRunRow[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Paused runs parked at a reply gate — awaiting a human's answer in the thread. */
  listPaused(): ExploreRun[] {
    const rows = this.db
      .prepare("SELECT * FROM explore_runs WHERE status = 'paused'")
      .all() as unknown as ExploreRunRow[];
    return rows.map((r) => this.hydrate(r));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
