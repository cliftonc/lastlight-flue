/**
 * The explore (research) agents.
 *
 * NOT discovered agents: these are `create*Agent(...)` FACTORIES (no default export)
 * used by the `explore` workflow's phases, so they live in `src/agent-lib/` — Flue
 * discovers every IMMEDIATE file in `src/agents/` as an addressable agent
 * (flue-reference §0 / PROGRESS DISCOVERY RULE), so a non-default-export there would
 * be a phantom agent.
 *
 * Phase 5 (design/phase-5-workflows-chat.md → "explore — generic_loop + reply gate" +
 * ~/work/lastlight/workflows/explore.yaml). explore is the Socratic idea-shaping loop:
 *   read  → research the codebase, write a context doc, output a baseline
 *   ask   → pose ONE high-stakes clarifying question (reply-gate pauses; human answers)
 *   …loop… (ask/answer accumulate in scratch.socratic.qa until READY or the round cap)
 *   synth → write a detailed spec to a file
 *   (publish is DETERMINISTIC — not an agent; see src/explore-publish.ts)
 *
 * WEB TOOLS ARE GATED TO THE RESEARCH PHASES (design phase-5 §DRIFT, spec/09): the
 * read / ask / synthesize agents opt into `webTools()` (web_search + web_fetch) so the
 * agent can reach external docs while shaping the spec. The publish step does NOT get
 * them (it is deterministic application code, not an agent at all). The provider key is
 * closed over inside the tools — never model-selectable (see src/tools/web.ts).
 *
 * SANDBOX (required for read / synthesize, optional for ask): the explorer clones the
 * repo and reads it; the WORKFLOW owns the container lifetime (withBuildSandbox —
 * caller-owns-lifetime) and hands `docker(container)` here. This factory is a pure
 * mapper from (ref, octokit, sandbox?) → CreatedAgent; it creates/removes nothing.
 *
 * ⚠ EGRESS DEFERRED: the container runs with full network + no SSRF floor. The web
 * tools carry their OWN host-side SSRF guard (src/tools/web.ts). Do NOT run untrusted
 * input through the container itself.
 */
import { defineAgentProfile } from "@flue/runtime";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";
import building from "../skills/building/SKILL.md" with { type: "skill" };

export const description =
  "Socratic idea-shaping: reads a repo, asks clarifying questions in a reply-gated loop, then synthesizes a detailed spec.";

/** The task key resolveModel/resolveThinking read for the research/ask phases. */
export const EXPLORE_TASK_KEY = "explore" as const;
/** Synthesis uses the architect model (reference explore.yaml synthesize phase). */
export const SYNTHESIZE_TASK_KEY = "architect" as const;

/** The working directory the repo is pre-cloned into (matches docker.ts WORKSPACE). */
export const EXPLORE_CWD = "/workspace" as const;

/** The explore research phases that opt into the gated web tools. */
export type ResearchPhase = "read" | "ask" | "synthesize";

/** The subagent-profile name the explore coordinator delegates read/ask phases to. */
export const EXPLORE_PROFILE_NAME = "explore" as const;
/** The subagent-profile name the explore coordinator delegates the synthesize phase to. */
export const SYNTHESIZE_PROFILE_NAME = "synthesize" as const;

/**
 * The explore research SUBAGENT PROFILE (read / ask phases) on the `explore`
 * coordinator (beta.3). NO tools (per-run READ GitHub tools + the GATED web tools are
 * injected per `session.task(_, { tools })` — the gating boundary stays on the call,
 * never global) and NO sandbox/cwd (inherited from the coordinator harness — the shared
 * `/workspace` checkout). Model + thinkingLevel from the `explore` task key.
 */
export const exploreProfile = defineAgentProfile({
  name: EXPLORE_PROFILE_NAME,
  description,
  model: resolveModel(EXPLORE_TASK_KEY),
  thinkingLevel: resolveThinking(EXPLORE_TASK_KEY),
  instructions: loadPersona(),
  skills: [building],
});

/**
 * The synthesize SUBAGENT PROFILE on the `explore` coordinator (beta.3): reads the
 * context doc + the full Q&A transcript and writes the spec. Same shape as
 * `exploreProfile` but uses the architect model (reference explore.yaml synthesize
 * phase). Tools injected per-call; sandbox/cwd inherited from the coordinator.
 */
export const synthesizeProfile = defineAgentProfile({
  name: SYNTHESIZE_PROFILE_NAME,
  description: "Synthesizes the explore context + Q&A transcript into a detailed spec (the synthesize phase).",
  model: resolveModel(SYNTHESIZE_TASK_KEY),
  thinkingLevel: resolveThinking(SYNTHESIZE_TASK_KEY),
  instructions: loadPersona(),
  skills: [building],
});
