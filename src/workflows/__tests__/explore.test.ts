import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExplore } from "../explore.ts";
import { ExploreRunStore } from "../../explore-run-store.ts";
import { resumeExplore, recoverOrphanExploreRuns } from "../../resume-explore.ts";
import {
  type ExploreInput,
  type ExploreRunCtx,
  type ExploreDeps,
  type ExploreResult,
  isReadyMarker,
} from "../../agent-lib/explore-phases.ts";
import { NULL_REPORTER } from "../../notify/state.ts";
import type { NotifierState, ProgressReporter } from "../../notify/types.ts";

// Phase 5 — explore Socratic-loop CONTROL FLOW tests (offline; NO live model / web /
// GitHub). Mirrors build.test.ts: a real ExploreRunStore on a TEMP sqlite db + a fake
// ExploreDeps that RECORDS every phase / question-post / publish, so we can assert:
// the reply gate pauses + persists `pending` + returns; a reply resume folds the answer
// into scratch.socratic.qa and continues; the Socratic loop is bounded by max rounds;
// publish is deterministic; every phase runs EXACTLY ONCE across re-invokes; the
// restart breaker caps at 3; and the GOLDEN phase-sequence order.

let dir: string;
let store: ExploreRunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explore-phase5-"));
  store = new ExploreRunStore(join(dir, "explore.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const INPUT: Omit<ExploreInput, "resumedGate"> = {
  runId: "cliftonc/repo#7",
  owner: "cliftonc",
  repo: "repo",
  issue: 7,
  issueTitle: "Add a rate limiter",
  issueBody: "We need to throttle the API.",
};

function ctx(input: ExploreInput): ExploreRunCtx {
  // Control-flow tests use the top-level ExploreDeps fake (runPhase ignores the
  // harness), so a stub harness is sufficient here.
  return {
    harness: { name: "default" } as unknown as ExploreRunCtx["harness"],
    input,
    log: { info() {}, warn() {}, error() {} },
  };
}

/**
 * A fake ExploreDeps recording the ordered list of phases + question posts + publishes.
 * `askOutputs` maps an ask round → the canned text it returns (default: a question, no
 * READY → the loop pauses). The fake also captures the `run` snapshot at each ask so a
 * test can assert the accumulated Socratic Q&A was visible to the agent.
 */
function recordingDeps(opts: {
  askOutputs?: Record<number, string>;
  readText?: string;
  synthText?: string;
} = {}) {
  const phases: string[] = [];
  const questionPosts: { round: number; question: string }[] = [];
  const publishes: string[] = [];
  const qaSeenAtAsk: Record<number, string> = {};
  let commentId = 8000;

  const deps: ExploreDeps = {
    async runPhase(_c, run, phase) {
      phases.push(phase);
      if (phase === "read") return { text: opts.readText ?? "Baseline: we know X; unclear Y." };
      if (phase === "synthesize") return { text: opts.synthText ?? "# Rate limiter spec\n\nProposed design…" };
      // ask:<round>
      const round = Number(phase.split(":")[1] ?? 0);
      qaSeenAtAsk[round] = run.socratic.qa;
      return { text: opts.askOutputs?.[round] ?? `Round ${round}: token bucket or sliding window?` };
    },
    isReady: isReadyMarker,
    async postQuestion(_c, _run, round, question) {
      questionPosts.push({ round, question });
      return { commentId: commentId++ };
    },
    async publish(_c, run) {
      publishes.push(run.id);
      return { specUrl: `https://gh/${run.owner}/${run.repo}/issues/${run.issue}#spec` };
    },
  };
  return { deps, phases, questionPosts, publishes, qaSeenAtAsk };
}

describe("explore — reply gate: pause / persist / return", () => {
  it("the read phase runs, then the first ask pauses at reply:0 with the question posted", async () => {
    const t = recordingDeps();
    const res = await runExplore(ctx({ ...INPUT }), store, t.deps);

    expect(res.status).toBe("paused");
    expect(res.gate).toBe("reply:0");
    // read + ask:0 ran; nothing past the gate.
    expect(t.phases).toEqual(["read", "ask:0"]);
    expect(t.questionPosts).toEqual([{ round: 0, question: "Round 0: token bucket or sliding window?" }]);
    expect(t.publishes).toEqual([]);

    const rec = store.get(INPUT.runId)!;
    expect(rec.pendingGate).toBe("reply:0");
    expect(rec.status).toBe("paused");
    expect(rec.phasesDone).toMatchObject({ read: true, "ask:0": true });
    expect(rec.phasesDone.synthesize).toBeUndefined();
    // The baseline from the read phase was recorded for the ask/synthesize phases.
    expect(rec.scratch.baseline).toContain("Baseline");
    // The question was appended to the Socratic transcript.
    expect(rec.socratic.qa).toContain("Round 0: token bucket or sliding window?");
  });

  it("a bare re-invoke (no reply) re-pauses idempotently — does NOT re-run read/ask or re-post", async () => {
    const t = recordingDeps();
    await runExplore(ctx({ ...INPUT }), store, t.deps); // pause
    const res = await runExplore(ctx({ ...INPUT }), store, t.deps); // bare re-invoke

    expect(res.status).toBe("paused");
    expect(res.gate).toBe("reply:0");
    expect(t.phases).toEqual(["read", "ask:0"]); // ran once total
    expect(t.questionPosts).toHaveLength(1); // posted once total
  });

  it("the posted gate-comment id is recorded in the run record", async () => {
    const t = recordingDeps();
    await runExplore(ctx({ ...INPUT }), store, t.deps);
    expect(store.get(INPUT.runId)!.scratch["gateComment:reply:0"]).toBe("8000");
  });
});

describe("explore — reply resume: fold the answer + continue", () => {
  it("a reply accumulates into scratch.socratic.qa and continues to the next round", async () => {
    // ask:0 asks, ask:1 is READY → loop ends, synthesize + publish run.
    const t = recordingDeps({
      askOutputs: { 0: "Round 0: token bucket or sliding window?", 1: "Got it — moving to draft.\nREADY" },
    });
    await runExplore(ctx({ ...INPUT }), store, t.deps); // pause @ reply:0

    const res = await resumeExplore(INPUT.runId, "Use a token bucket.", {
      storePath: join(dir, "explore.db"),
      reinvoke: (input) => runExplore(ctx(input), store, t.deps),
    });

    expect(res.status).toBe("complete");
    expect(res.specUrl).toContain("#spec");
    // read → ask:0 → ask:1(READY) → synthesize. publish ran once.
    expect(t.phases).toEqual(["read", "ask:0", "ask:1", "synthesize"]);
    expect(t.publishes).toEqual([INPUT.runId]);

    // The human's answer was folded in BEFORE ask:1 ran → ask:1 saw it.
    expect(t.qaSeenAtAsk[1]).toContain("Use a token bucket.");

    const rec = store.get(INPUT.runId)!;
    expect(rec.status).toBe("complete");
    expect(rec.pendingGate).toBeNull();
    expect(rec.socratic.qa).toContain("Q: Round 0: token bucket or sliding window?");
    expect(rec.socratic.qa).toContain("A: Use a token bucket.");
    expect(rec.socratic.ready).toBe(true);
  });

  it("a multi-round Q&A accumulates across two reply-gate pauses, then synthesizes", async () => {
    const t = recordingDeps({
      askOutputs: {
        0: "Q0: which endpoints?",
        1: "Q1: per-user or global?",
        2: "Enough — drafting now.\nREADY",
      },
    });
    const o = { storePath: join(dir, "explore.db"), reinvoke: (i: ExploreInput) => runExplore(ctx(i), store, t.deps) };

    await runExplore(ctx({ ...INPUT }), store, t.deps); // pause @ reply:0
    expect(store.get(INPUT.runId)!.pendingGate).toBe("reply:0");

    const r1 = await resumeExplore(INPUT.runId, "All write endpoints.", o); // pause @ reply:1
    expect(r1.status).toBe("paused");
    expect(r1.gate).toBe("reply:1");

    const r2 = await resumeExplore(INPUT.runId, "Per-user.", o); // READY → complete
    expect(r2.status).toBe("complete");

    expect(t.phases).toEqual(["read", "ask:0", "ask:1", "ask:2", "synthesize"]);
    const qa = store.get(INPUT.runId)!.socratic.qa;
    expect(qa).toContain("A: All write endpoints.");
    expect(qa).toContain("A: Per-user.");
    expect(qa).toContain("Q: Q1: per-user or global?");
  });

  it("a duplicate reply against a resolved run is a no-op (idempotent)", async () => {
    const t = recordingDeps({ askOutputs: { 0: "Q0?", 1: "done\nREADY" } });
    const o = { storePath: join(dir, "explore.db"), reinvoke: (i: ExploreInput) => runExplore(ctx(i), store, t.deps) };
    await runExplore(ctx({ ...INPUT }), store, t.deps);
    await resumeExplore(INPUT.runId, "answer", o); // completes
    const dup = await resumeExplore(INPUT.runId, "answer again", o); // no-op
    expect(dup.status).toBe("complete");
    expect(t.publishes).toEqual([INPUT.runId]); // published once
  });
});

describe("explore — Socratic loop bound (max rounds → proceeds)", () => {
  it("if the ask never says READY, the loop pauses each round up to the cap then proceeds", async () => {
    // No round ever outputs READY → it pauses every round. We drive 8 rounds of reply,
    // after which the loop hits MAX_SOCRATIC_ROUNDS (8) and proceeds to synthesize.
    const t = recordingDeps(); // default ask = a question, never READY
    const o = { storePath: join(dir, "explore.db"), reinvoke: (i: ExploreInput) => runExplore(ctx(i), store, t.deps) };

    let res = await runExplore(ctx({ ...INPUT }), store, t.deps); // pause @ reply:0
    for (let round = 0; round < 8 && res.status === "paused"; round++) {
      res = await resumeExplore(INPUT.runId, `answer ${round}`, o);
    }

    // The loop is bounded: it did NOT pause forever — it completed at the cap.
    expect(res.status).toBe("complete");
    // ask ran for rounds 0..7 (8 rounds), then synthesize.
    const asks = t.phases.filter((p) => p.startsWith("ask:"));
    expect(asks).toEqual(["ask:0", "ask:1", "ask:2", "ask:3", "ask:4", "ask:5", "ask:6", "ask:7"]);
    expect(t.phases).toContain("synthesize");
    expect(t.publishes).toEqual([INPUT.runId]);
    expect(store.get(INPUT.runId)!.socratic.ready).toBe(true);
  });

  it("an immediate READY on the first ask skips the gate entirely", async () => {
    const t = recordingDeps({ askOutputs: { 0: "I have enough already.\nREADY" } });
    const res = await runExplore(ctx({ ...INPUT }), store, t.deps);
    expect(res.status).toBe("complete");
    expect(t.questionPosts).toEqual([]); // never paused — no question posted
    expect(t.phases).toEqual(["read", "ask:0", "synthesize"]);
  });
});

describe("explore — GOLDEN phase-sequence order", () => {
  it("read → ask:0 → ask:1(READY) → synthesize, resumed run = same order as inline", async () => {
    const t = recordingDeps({ askOutputs: { 0: "Q?", 1: "ok\nREADY" } });
    await runExplore(ctx({ ...INPUT }), store, t.deps);
    await resumeExplore(INPUT.runId, "ans", {
      storePath: join(dir, "explore.db"),
      reinvoke: (i) => runExplore(ctx(i), store, t.deps),
    });
    expect(t.phases).toEqual(["read", "ask:0", "ask:1", "synthesize"]);
  });
});

describe("explore — per-phase idempotency across many re-invokes", () => {
  it("duplicate resumes never re-run read / ask / synthesize / publish", async () => {
    const t = recordingDeps({ askOutputs: { 0: "Q?", 1: "ok\nREADY" } });
    const o = { storePath: join(dir, "explore.db"), reinvoke: (i: ExploreInput) => runExplore(ctx(i), store, t.deps) };
    await runExplore(ctx({ ...INPUT }), store, t.deps); // pause
    await resumeExplore(INPUT.runId, "ans", o); // completes
    await resumeExplore(INPUT.runId, "ans2", o); // dup
    await resumeExplore(INPUT.runId, "ans3", o); // dup

    const count = (p: string) => t.phases.filter((x) => x === p).length;
    expect(count("read")).toBe(1);
    expect(count("ask:0")).toBe(1);
    expect(count("ask:1")).toBe(1);
    expect(count("synthesize")).toBe(1);
    expect(t.publishes).toEqual([INPUT.runId]); // published once
  });
});

describe("explore — restart-count breaker caps at 3", () => {
  it("the 4th reply re-invoke terminalizes the run as failed", async () => {
    // Model a crash-loop: re-park at the gate before each reply attempt so the run
    // never settles. Every resumed re-invoke bumps restart_count; once it exceeds the
    // cap (3), runExplore terminalizes the run and refuses to proceed.
    const t = recordingDeps(); // never READY
    await runExplore(ctx({ ...INPUT }), store, t.deps); // pause, restart=0

    const statuses: string[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      // Re-park at reply:0 so each attempt is a resumed pause.
      store.setPending(INPUT.runId, "reply:0");
      const res = await runExplore(
        ctx({ ...INPUT, resumedGate: "reply:0" }),
        store,
        t.deps,
      );
      statuses.push(res.status);
    }

    // Attempts 1-3 proceed (re-pause); attempt 4 (restart_count 4 > 3) fails.
    expect(statuses.slice(0, 3).every((s) => s === "paused")).toBe(true);
    expect(statuses[3]).toBe("failed");
    const rec = store.get(INPUT.runId)!;
    expect(rec.restartCount).toBe(4);
    expect(rec.status).toBe("failed");
    expect(rec.failReason).toContain("restart-breaker");
  });
});

describe("explore — boot orphan recovery", () => {
  it("recoverOrphanExploreRuns re-invokes active (not paused) runs", async () => {
    store.getOrCreate("active-run", { owner: "o", repo: "r", issue: 1, triggerId: "t1" });
    store.getOrCreate("paused-run", { owner: "o", repo: "r", issue: 2, triggerId: "t2" });
    store.setPending("paused-run", "reply:0");

    const reinvoked: string[] = [];
    const recovered = await recoverOrphanExploreRuns({
      storePath: join(dir, "explore.db"),
      reinvoke: async (input) => {
        reinvoked.push(input.runId);
      },
    });
    expect(recovered).toEqual(["active-run"]);
    expect(reinvoked).toEqual(["active-run"]);
  });
});

describe("explore — Phase 8 progress reporter wiring", () => {
  function recordingReporter() {
    const calls: string[] = [];
    const reporter: ProgressReporter = {
      async start() { calls.push("start"); },
      async step(key, status) { calls.push(`step:${key}:${status}`); },
      async insertStep(s) { calls.push(`insert:${s.key}:${s.status}`); },
      async note() { calls.push("note"); },
      async noteTerminal() { calls.push("noteTerminal"); },
    };
    return { reporter, calls };
  }

  it("drives read→ask→synthesize→publish on a READY-first run, pinging on completion", async () => {
    // ask:0 returns READY → no reply gate → straight through to publish.
    const t = recordingDeps({ askOutputs: { 0: "Enough signal.\nREADY" } });
    const r = recordingReporter();
    const res = await runExplore(ctx({ ...INPUT }), store, {
      ...t.deps,
      makeReporter: async () => r.reporter,
    });
    expect(res.status).toBe("complete");
    expect(r.calls).toEqual([
      "step:read:running",
      "step:read:done",
      "insert:ask:0:running",
      // A READY round asked nothing → honest "skipped", never a misleading "done".
      "step:ask:0:skipped",
      "step:synthesize:running",
      "step:synthesize:done",
      "step:publish:running",
      "step:publish:done",
      "noteTerminal",
    ]);
  });

  it("marks the ask round awaiting + pings on a reply-gate pause", async () => {
    const t = recordingDeps(); // ask:0 poses a question → pause @ reply:0
    const r = recordingReporter();
    const res = await runExplore(ctx({ ...INPUT }), store, {
      ...t.deps,
      makeReporter: async () => r.reporter,
    });
    expect(res.status).toBe("paused");
    expect(r.calls).toEqual([
      "step:read:running",
      "step:read:done",
      "insert:ask:0:running",
      "step:ask:0:awaiting",
      "noteTerminal",
    ]);
  });

  it("persists the NotifierState handles to scratch so a resume re-attaches the surface", async () => {
    const t = recordingDeps();
    const makeReporter = async (
      _c: ExploreRunCtx,
      _r: unknown,
      save: (patch: NotifierState) => void,
    ): Promise<ProgressReporter> => {
      save({ githubCommentId: 7373 });
      return NULL_REPORTER;
    };
    await runExplore(ctx({ ...INPUT }), store, { ...t.deps, makeReporter });
    expect(store.get(INPUT.runId)!.scratch["notifier:githubCommentId"]).toBe("7373");
  });
});

describe("explore — reject-equivalent: no reply path leaves the run terminal-safe", () => {
  it("resumeExplore on an unknown run reports failed without throwing", async () => {
    const res = await resumeExplore("nope", "x", { storePath: join(dir, "explore.db") });
    expect(res.status).toBe("failed");
    expect(res.reason).toContain("unknown runId");
  });
});
