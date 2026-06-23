/**
 * `explore` workflow — Phase 5: the Socratic idea-shaping loop + the durable REPLY
 * GATE, as explicit `run()` control flow (mirrors src/workflows/build.ts).
 *
 * Discoverable as `src/workflows/explore.ts` (filename = workflow name), invoked via
 * `flue run explore --payload '{"runId":..,"owner":..,"repo":..,"issue":..}'` and
 * RE-invoked (idempotently, same app runId) by `resumeExplore(runId, reply)` when the
 * human answers a clarifying question in the thread.
 *
 * Phase sequence (ported from ~/work/lastlight/workflows/explore.yaml):
 *   read/research → socratic ask-loop( ask → [REPLY GATE] → fold reply ; max 8 rounds,
 *                   break on READY ) → synthesize → publish
 *
 * THE DURABILITY MODEL (spec/06, design/phase-5): same as build — Flue does NOT
 * checkpoint workflow run(), so the gate is 100% application-owned. The difference from
 * build's APPROVE/REJECT gate: explore's REPLY GATE resumes with the human's ANSWER
 * TEXT, accumulated into `scratch.socratic.qa`. run() writes `pendingGate='reply:<n>'`
 * + posts the question + RETURNS; `resumeExplore(runId, reply)` folds the answer into
 * the Socratic transcript and RE-INVOKES; phasesDone + the socraticIter cursor land
 * execution back in the SAME Socratic round. A per-run restart breaker (≤3) caps loops.
 *
 * WEB TOOLS ARE GATED TO THE RESEARCH PHASES (design phase-5 §DRIFT): the read / ask /
 * synthesize agents opt into webTools(); the deterministic publish does NOT (it's
 * application code, not an agent). The reply-gate question post + the spec publish are
 * DETERMINISTIC (bound ref + token, NOT model tools). All user-authored text (the
 * issue, the triggering comment, every human reply) is UNTRUSTED-wrapped in the prompts.
 *
 * TESTABILITY: `run` defers to `runExplore(ctx, store, deps)` with an injectable
 * `store` (a real ExploreRunStore on temp sqlite) + a `deps` seam (phase runner, gate
 * poster, publisher). Tests pass fakes so the whole ask→gate→reply→research→synthesize→
 * publish loop runs with NO live model, NO live web, NO live GitHub.
 *
 * Beta.2 form: `export async function run(ctx)` (NO defineWorkflow; flue-reference §0).
 */
import type { FlueContext } from "@flue/runtime";
import {
  ExploreRunStore,
  MAX_RESTART_RESUMES,
  MAX_SOCRATIC_ROUNDS,
  type ExploreRun,
  type ReplyGate,
} from "../explore-run-store.ts";
import {
  type ExploreInput,
  type ExploreResult,
  type ExploreDeps,
  defaultExploreDeps,
} from "../agent-lib/explore-phases.ts";
import { closeBuildWorkspace } from "../agent-lib/build-sandbox.ts";

export type { ExploreInput, ExploreResult } from "../agent-lib/explore-phases.ts";

/** Read the run-store path lazily so each process (+ test) can point at its own db. */
const storePath = () =>
  process.env.LASTLIGHT_EXPLORE_RUNSTORE ?? "./.data/explore-run-store.db";

/** Derive the seed identity from the workflow input. */
function seedFrom(input: ExploreInput) {
  return {
    owner: input.owner,
    repo: input.repo,
    issue: input.issue ?? 0,
    triggerId: input.triggerId ?? `${input.owner}/${input.repo}#${input.issue ?? 0}`,
  };
}

/** A reply gate carries the Socratic round it parked at. */
function replyGate(round: number): ReplyGate {
  return `reply:${round}`;
}

/**
 * The testable core. Drives the full Socratic loop over an injected ExploreRunStore +
 * ExploreDeps. Production wraps this in `run()` with the default store + real deps;
 * tests pass a temp-sqlite store + fake phase bodies.
 */
export async function runExplore(
  ctx: FlueContext<ExploreInput>,
  store: ExploreRunStore,
  deps: ExploreDeps = defaultExploreDeps(),
): Promise<ExploreResult> {
  const input = ctx.payload;
  const id = input.runId;
  let run = store.getOrCreate(id, seedFrom(input));

  // Already-terminal: a duplicate signal against a finished run is a no-op.
  if (run.status === "complete") return { status: "complete", specUrl: run.scratch.specUrl };
  if (run.status === "failed") return { status: "failed", reason: run.failReason ?? undefined };

  // ── BREAKER vs the reply gate (a key explore distinction from build) ──────────
  // build's breaker bumps on EVERY resumedGate. explore's reply gate is DIFFERENT: a
  // human reply is an EXPECTED re-invoke (up to MAX_SOCRATIC_ROUNDS rounds), NOT a
  // crash — so a normal reply (`triggerType:'resume'`) must NOT consume the crash
  // budget, or a long Socratic conversation would falsely trip the breaker. The
  // breaker bumps ONLY on a CRASH re-invoke (boot orphan recovery, `triggerType:'boot'`
  // — or an unmarked re-invoke, conservatively treated as a crash). The Socratic loop
  // is independently bounded by MAX_SOCRATIC_ROUNDS below. Either way we clear the
  // pending marker so the loop re-enters past the gate.
  if (input.resumedGate) {
    const isCrashReentry = input.triggerType === "boot" || input.triggerType === undefined;
    if (isCrashReentry) {
      const attempts = store.bumpRestart(id);
      if (attempts > MAX_RESTART_RESUMES) {
        store.fail(id, `restart-breaker: resumed ${attempts}x (cap ${MAX_RESTART_RESUMES})`);
        return { status: "failed", reason: "restart-breaker" };
      }
    }
    store.clearPending(id);
  }
  run = store.get(id)!;

  // ── read / research (skipped if done) ────────────────────────────────────────
  // The explorer clones the repo, reads it, writes a context doc to a file (the
  // durable cross-phase handoff — spec/10 split rule), and returns a BASELINE summary
  // which we record as scratch context for the ask/synthesize phases.
  if (store.shouldRunPhase(run, "read")) {
    const r = await deps.runPhase(ctx, run, "read");
    store.markPhaseDone(id, "read", { baseline: clip(r.text) });
    run = store.get(id)!;
  }

  // ── socratic ask-loop (reply gate) — capped at MAX_SOCRATIC_ROUNDS ────────────
  // Each round: the ask agent poses ONE high-stakes clarifying question (or outputs
  // READY when it has enough signal). On READY (or the round cap) we advance to
  // synthesize. Otherwise we PAUSE: post the question, write pendingGate='reply:<n>',
  // and RETURN — `resumeExplore` folds the human's answer into scratch.socratic.qa and
  // re-invokes, landing back here at the SAME round (socraticIter cursor).
  for (let round = run.socraticIter; round < MAX_SOCRATIC_ROUNDS; round++) {
    const askPhase = `ask:${round}`;

    // If we already asked this round and parked, a resume re-enters here with the
    // reply folded in. We only run the ask agent if this round's question hasn't been
    // posed yet (idempotency-keyed) — otherwise we recover the question text.
    let questionText: string;
    if (store.shouldRunPhase(run, askPhase)) {
      const a = await deps.runPhase(ctx, run, askPhase);
      questionText = a.text;
      const ready = deps.isReady(a.text);
      // Record this round's question into the Socratic transcript so the next ask sees
      // it (and the synthesize phase has the full Q&A). READY rounds carry no question.
      if (!ready) store.appendSocraticTurn(id, { question: questionText });
      store.markPhaseDone(id, askPhase, { [`question:${round}`]: clip(questionText) });
      if (ready) store.setSocraticReady(id, true);
      run = store.get(id)!;
      if (ready) break;
    } else {
      questionText = run.scratch[`question:${round}`] ?? "";
      if (run.socratic.ready) break;
    }

    // GATE: pause for the human's reply, unless THIS invoke was resumed past exactly
    // this round's gate (the reply has just been folded in by resumeExplore).
    const gate = replyGate(round);
    if (input.resumedGate !== gate) {
      if (run.pendingGate !== gate) {
        store.setSocraticIter(id, round);
        // Record the channel conversation key so a channel reply on this thread
        // resolves THIS run via findPausedRunByConversation (Phase 6). When the run
        // was triggered from a channel, `triggerId` IS the conversation key (the
        // channels pass `triggerId: ev.conversationKey`); fall back to it.
        store.setConversationKey(id, input.conversationKey ?? run.triggerId);
        store.setPending(id, gate);
        const posted = await deps.postQuestion(ctx, run, round, questionText);
        if (posted?.commentId !== undefined) {
          store.recordScratch(id, { [`gateComment:${gate}`]: String(posted.commentId) });
        }
      }
      return { status: "paused", gate };
    }

    // Resumed past this gate: the reply is already in scratch.socratic.qa. Advance the
    // cursor so the NEXT round's ask agent runs (and a re-invoke skips this round).
    store.setSocraticIter(id, round + 1);
    run = store.get(id)!;
  }
  // Whether we broke on READY or fell off the round cap, the loop is settled — mark it
  // ready so synthesize proceeds (the cap is a bound, not a failure).
  if (!run.socratic.ready) {
    store.setSocraticReady(id, true);
    run = store.get(id)!;
  }

  // ── synthesize (skipped if done) ──────────────────────────────────────────────
  // The synthesize agent reads the context doc + the full Q&A transcript and writes a
  // detailed spec to a file. We record the spec text (clipped) so publish can recover
  // it deterministically even after a crash.
  if (store.shouldRunPhase(run, "synthesize")) {
    const s = await deps.runPhase(ctx, run, "synthesize");
    store.markPhaseDone(id, "synthesize", { spec: clip(s.text, 60_000) });
    run = store.get(id)!;
  }

  // ── publish (deterministic — workflow code, NOT a model tool) ─────────────────
  // Idempotent at TWO layers: shouldRunPhase('publish') skips it on a re-invoke that
  // already published, and the publisher itself dedup-guards (a bot comment marker /
  // the recorded URL) so even a re-invoke that lost the flag won't double-publish.
  if (store.shouldRunPhase(run, "publish")) {
    const pub = await deps.publish(ctx, run);
    const pubScratch: Record<string, string> = {};
    if (pub.specUrl) pubScratch.specUrl = pub.specUrl;
    store.markPhaseDone(id, "publish", pubScratch);
    store.complete(id);
    return { status: "complete", specUrl: pub.specUrl, deduped: pub.deduped };
  }

  store.complete(id);
  return { status: "complete", specUrl: run.scratch.specUrl };
}

/** Clip a blob so the run record stays bounded (spec/10 — never store unbounded text). */
function clip(text: string, max = 8_000): string {
  const t = text ?? "";
  return t.length > max ? `${t.slice(0, max)}\n…[clipped ${t.length - max} chars]` : t;
}

/** Flue workflow entry — discovered as the `explore` workflow. */
export async function run(ctx: FlueContext<ExploreInput>): Promise<ExploreResult> {
  const store = new ExploreRunStore(storePath());
  try {
    return await runExplore(ctx, store);
  } finally {
    store.close();
    // Tear down the shared per-run workspace (keyed by the explore run id, the
    // same key the phases pass as taskId to withBuildSandbox). Best-effort.
    await closeBuildWorkspace(ctx.payload.runId, ctx.log);
  }
}

// Re-export the run record type so resume-explore can reference it without a cycle.
export type { ExploreRun };
