/**
 * The build-internal REVIEWER + FIX agents (the reviewer-loop phase bodies).
 *
 * NOT discovered agents: these are `createXAgent(ref, octokit, sandbox)` FACTORIES
 * (no default export) used by the `build` workflow's reviewer loop, so they live in
 * `src/agent-lib/` — Flue discovers every IMMEDIATE file in `src/agents/` as an
 * addressable agent, so a non-default-export helper there would be mis-discovered
 * (see PROGRESS / flue-reference §0).
 *
 * Phase 4 (design/phase-4-build-gate.md), the reviewer loop:
 *   reviewer:N → [post_reviewer gate] → fix:N → recheck:N (max_cycles=2; break on APPROVED)
 *
 * DIFFERENCE FROM the Phase-3 `pr-review` reviewer (src/agent-lib/reviewer.ts):
 * that reviewer reviews an OPEN GitHub PR and the workflow posts a formal review;
 * THIS reviewer reviews the EXECUTOR's COMMITTED CHANGES in the pre-cloned
 * /workspace checkout (`git diff main...HEAD`) and emits a `VERDICT:` marker —
 * there is NO GitHub post (an internal build review, not a PR review). The verdict
 * drives the durable loop; the post_reviewer gate surfaces it to the human. Config
 * MIRRORS the Phase-3 reviewer (same `review` task key, persona, pr-review +
 * building + code-review skills) but the sandbox is REQUIRED (it inspects the
 * checkout) rather than additive.
 *
 * The FIX agent mirrors the executor: persona + the `building` skill, READ-ONLY
 * GitHub tools (it lands code via the sandbox git CLI, not a write tool), sandbox +
 * cwd /workspace. It reads `.lastlight/issue-<N>/reviewer-verdict.md`, addresses the
 * reviewer notes, runs the test gate, and COMMITS in-sandbox via the git CLI. It
 * does NOT push: the workflow pushes the branch deterministically over the
 * repo-write token after the session (the mockable push seam, shared with the
 * executor). The RE-REVIEWER is the SAME reviewer agent re-prompted with re-reviewer.md.
 *
 * SANDBOX (required): the WORKFLOW (`build.ts` → `withBuildSandbox`) owns the
 * container lifetime — it creates the container, pre-clones the repo at the working
 * branch (carrying the architect plan + the executor's committed changes), passes
 * `docker(container)` here, and `remove()`s it in a `finally`. These factories are
 * pure mappers from (ref, octokit, sandbox) → CreatedAgent; they create/remove nothing.
 *
 * ⚠ EGRESS DEFERRED: the container runs with full network + no SSRF floor. Do NOT
 * run untrusted input through it. See PROGRESS.md / spec/09.
 */
import { defineAgent, defineAgentProfile } from "@flue/runtime";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import { dockerSandbox } from "../sandboxes/docker.ts";
import prReview from "../skills/pr-review/SKILL.md" with { type: "skill" };
import building from "../skills/building/SKILL.md" with { type: "skill" };
import codeReview from "../skills/code-review/SKILL.md" with { type: "skill" };

export const description =
  "Reviews the executor's committed changes in the build checkout and emits a VERDICT marker (the reviewer-loop phase).";

/** The task key both `resolveModel` and `resolveThinking` read for the review. */
export const REVIEW_TASK_KEY = "review" as const;

/** The task key both `resolveModel` and `resolveThinking` read for the fix. */
export const FIX_TASK_KEY = "fix" as const;

/** The working directory the repo is pre-cloned into (matches docker.ts WORKSPACE). */
export const BUILD_REVIEWER_CWD = "/workspace" as const;

/** The subagent-profile name the build coordinator delegates reviewer:N / recheck:N to. */
export const BUILD_REVIEWER_PROFILE_NAME = "build-reviewer" as const;

/** The subagent-profile name the build coordinator delegates fix:N to. */
export const BUILD_FIX_PROFILE_NAME = "build-fix" as const;

/**
 * The build-internal reviewer SUBAGENT PROFILE on the `build` coordinator (beta.3),
 * re-used for the recheck phase (re-prompted with re-reviewer.md). NO tools (per-run
 * READ tools injected per `session.task(_, { tools })`) and NO sandbox/cwd (inherited
 * from the coordinator harness — the shared `/workspace` checkout it diffs/reads).
 * Model + thinkingLevel from the `review` task key.
 */
export const buildReviewerProfile = defineAgentProfile({
  name: BUILD_REVIEWER_PROFILE_NAME,
  description,
  model: resolveModel(REVIEW_TASK_KEY),
  thinkingLevel: resolveThinking(REVIEW_TASK_KEY),
  instructions: loadPersona(),
  skills: [prReview, building, codeReview],
});

/**
 * The build-internal fix SUBAGENT PROFILE on the `build` coordinator (beta.3). Mirrors
 * the executor: persona + the `building` skill, NO tools (per-run READ tools injected
 * per call; code lands via the sandbox git CLI, not a write tool), NO sandbox/cwd
 * (inherited from the coordinator harness). Model + thinkingLevel from the `fix` task
 * key (falls back to the default model when no explicit fix entry is configured).
 */
export const buildFixProfile = defineAgentProfile({
  name: BUILD_FIX_PROFILE_NAME,
  description: "Addresses reviewer notes in the build checkout and commits the fix (the fix:N phase).",
  model: resolveModel(FIX_TASK_KEY),
  thinkingLevel: resolveThinking(FIX_TASK_KEY),
  instructions: loadPersona(),
  skills: [building],
});

/**
 * The standalone FIX agent for the single-phase `pr-fix` workflow (beta.3 static
 * `defineAgent`). Unlike the build reviewer-loop fix (a subagent profile inside the
 * `build` coordinator), pr-fix binds this directly: `sandbox: dockerSandbox()` gives
 * the harness a fresh container; `cwd: /workspace` points its bash/file tools at the
 * PR-head checkout the workflow clones in. It commits in-sandbox via the git CLI; the
 * workflow reads HEAD + pushes deterministically. Per-run READ tools are injected
 * per-call via `session.prompt(_, { tools })`.
 */
export const fixAgent = defineAgent(() => ({
  model: resolveModel(FIX_TASK_KEY),
  thinkingLevel: resolveThinking(FIX_TASK_KEY),
  instructions: loadPersona(),
  skills: [building],
  sandbox: dockerSandbox(),
  cwd: BUILD_REVIEWER_CWD,
}));
