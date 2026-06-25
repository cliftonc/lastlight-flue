/**
 * The build PR-AUTHOR subagent profile.
 *
 * NOT a discovered agent (no default export): a subagent profile on the `build`
 * coordinator, used by the finalize step to AUTHOR the PR title + body. The PR itself
 * is still opened deterministically (workflow code, scoped token, bound ref); this
 * profile only writes prose. It carries NO tools (per-run READ tools are injected per
 * `session.task(_, { tools })`) and NO sandbox/cwd (inherited from the coordinator's
 * shared `/workspace` checkout). The persona (`loadPersona`, incl. security.md) anchors
 * untrusted-content handling; model + thinkingLevel come from the `pr` task key (falls
 * back to the configured default model — parity with the reference's `models.pr`).
 *
 * Mirrors `architect.ts` / `executor.ts`; lives in `src/agent-lib/` (NOT discovered).
 */
import { defineAgentProfile } from "@flue/runtime";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";

export const description =
  "Reads a completed build branch (handoff artifacts + diff) and writes the pull-request title and body for the deterministic open-PR step.";

/** The task key both `resolveModel` and `resolveThinking` read for this phase. */
export const PR_AUTHOR_TASK_KEY = "pr" as const;

/** The subagent-profile name the build coordinator delegates PR authoring to. */
export const PR_AUTHOR_PROFILE_NAME = "pr" as const;

/** The PR-author SUBAGENT PROFILE on the `build` coordinator (beta.3). */
export const prAuthorProfile = defineAgentProfile({
  name: PR_AUTHOR_PROFILE_NAME,
  description,
  model: resolveModel(PR_AUTHOR_TASK_KEY),
  thinkingLevel: resolveThinking(PR_AUTHOR_TASK_KEY),
  instructions: loadPersona(),
});
