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
import { createAgent } from "@flue/runtime";
import type { SandboxFactory } from "@flue/runtime";
import type { Octokit } from "octokit";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
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

/**
 * Build the build-internal reviewer agent (also re-used for the recheck phase,
 * re-prompted with re-reviewer.md) bound to a repo ref + read-scoped Octokit + the
 * build sandbox. `ref`/`octokit` are closed over the read-tool factories (the model
 * cannot widen scope); `cwd: /workspace` points the agent's bash/file tools at the
 * pre-cloned checkout so it can diff + read the committed changes.
 */
export function createBuildReviewerAgent(
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
) {
  return createAgent(() => ({
    model: resolveModel(REVIEW_TASK_KEY),
    thinkingLevel: resolveThinking(REVIEW_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [prReview, building, codeReview],
    sandbox,
    cwd: BUILD_REVIEWER_CWD,
  }));
}

/**
 * Build the fix agent bound to a repo ref + read-scoped Octokit + the build
 * sandbox. Mirrors the executor: persona, the `building` skill (the install/test
 * gate), READ-ONLY GitHub tools (code lands via the sandbox git CLI, not a write
 * tool), sandbox + cwd /workspace. Resolves the `fix` task key (falls back to the
 * default model when no explicit fix entry is configured).
 */
export function createFixAgent(
  ref: RepoRef,
  octokit: Octokit,
  sandbox: SandboxFactory,
) {
  return createAgent(() => ({
    model: resolveModel(FIX_TASK_KEY),
    thinkingLevel: resolveThinking(FIX_TASK_KEY),
    instructions: loadPersona(),
    tools: githubReadTools(ref, octokit),
    skills: [building],
    sandbox,
    cwd: BUILD_REVIEWER_CWD,
  }));
}
