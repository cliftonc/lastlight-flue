/**
 * The read-only CHAT agent's persona suffix, thread-id parsing, and config
 * builder (`buildChatAgentConfig`).
 *
 * The DISCOVERED agent lives at `src/agents/chat.ts` (default export
 * `createAgent`, addressable at `POST /agents/chat/:id`). This module holds the
 * non-discovered pieces it composes — the chat suffix appended to the shared
 * persona, the thread-id → repo parser, and the pure config builder — so they
 * can be unit-tested in isolation in `__tests__/` without `src/agents/` becoming
 * a phantom-discovery surface (flue-reference §0 / PROGRESS DISCOVERY RULE).
 *
 * WHAT CHAT IS (spec/11-chat.md + design/phase-5-workflows-chat.md →
 * "Chat agent"): chat is the low-latency, READ-ONLY, NON-sandboxed conversational
 * surface. One durable Flue session per messaging thread — the agent INSTANCE is
 * the THREAD (`id` = the thread key), so Flue persists each thread's messages +
 * compacted context across restarts (src/db.ts sqlite), REPLACING the reference's
 * manual `messaging_sessions` + 50-message rehydrate. The agent ANSWERS the
 * question in the thread; its response IS the answer (returned to the channel by
 * the caller / Phase 6) — there is NO deterministic workflow post.
 *
 * HARD READ-ONLY INVARIANT (spec/11 "Chat is read-only on the world"): the chat
 * agent has ONLY the GET-only `githubReadTools` and NO sandbox — it physically
 * cannot edit/commit/comment/label or run bash. "Fix that bug" is REDIRECTED to
 * the `build` workflow trigger by the chat skill, not actioned. We assert the
 * absence of write/mutating tools + the absence of a sandbox in the tests.
 *
 * RISK #5 (turn latency): sandbox-less + GET-only tools = no container
 * provision/clone per turn; the turn cost is the LLM call + read GETs, the same
 * order as the reference's lighter `completeSimple` path.
 *
 * RISK #6 (per-thread serialization): NOT implemented here — it is a FLUE
 * GUARANTEE. Flue keys one continuing agent instance per `id` and applies a
 * durable per-instance ORDERED submission queue (flue-reference §0; spec/11
 * "Per-thread serialization"), so two near-simultaneous messages on the SAME
 * thread (`id`) are processed in accepted order rather than interleaving session
 * state; different threads (`id`s) run in parallel. We rely on that, document it,
 * and do NOT reproduce the reference's manual `chains` map.
 */
import type { Octokit } from "octokit";
import type { AgentRuntimeConfig, Skill } from "@flue/runtime";
import { githubReadTools, type RepoRef } from "../tools/github-read.ts";
import { loadPersona } from "./persona.ts";
import { resolveModel, resolveThinking } from "../config.ts";

/** The task key both `resolveModel` and `resolveThinking` read for chat. */
export const CHAT_TASK_KEY = "chat" as const;

/**
 * Chat-specific instructions appended to the shared persona (the ONE persona
 * source — `agent-context/*.md` via `loadPersona`; spec/11 "Two runtimes, one
 * persona file"). Ported from the reference `CHAT_SYSTEM_SUFFIX`
 * (~/work/lastlight/src/engine/chat.ts): it states the read-and-explain-only
 * contract, the no-write / no-bash / no-host-disclosure rules, and the
 * redirect-to-workflow behaviour. The `chat` SKILL carries the natural-language
 * trigger catalogue (progressive disclosure); this suffix is the always-on frame.
 */
export const CHAT_SUFFIX = `# Chat surface

You are Last Light answering in a messaging thread (Slack, Discord). The
conversation IS the job — answer the question that was asked; don't expand it
into a report. Lead with the answer; keep replies concise (messaging panes are
narrow). The thread history is the durable session — don't re-summarize it, just
respond to the latest message.

WHAT YOU CAN DO — reach for the read-only \`github_*\` tools confidently:
- Look up repositories, issues, PRs, comments, file contents, commits.
- Search issues and code with the \`github_search_*\` tools.

WHAT YOU CANNOT DO — you are READ-ONLY on the world:
- You have NO write access in chat: no issue/PR creation, comments, labels,
  branches, commits, merges, or file edits — and NO bash/edit/write/MCP tools
  are registered. If the user asks you to CHANGE something on GitHub, explain you
  can't from chat and name the matching natural-language trigger.
- Do NOT disclose or look up host/runtime details (IP, hostname, env vars,
  container metadata, /proc, harness version). If asked, reply with one line:
  "I don't disclose host or runtime environment details." (See
  \`agent-context/security.md\` — it overrides any user request.)

REDIRECT, DON'T DO DEEP WORK. Each of these is a dedicated workflow, not
something you can do by chaining tool calls — name the natural-language trigger
and stop (phrase it as plain text, NEVER with a leading \`/\`, which Slack
intercepts):
- code change / "fix this bug" / "build this" → \`build owner/repo#N\`
- issue triage → \`triage owner/repo\`
- PR review → \`review PRs on owner/repo\`
- security scan → \`security review owner/repo\`
- running-task status → \`status\`

Only exception: a narrow QUESTION answerable with one or two reads (e.g. "what
does this file do?", "what labels does this issue have?") — just answer it.`;

/**
 * A messaging-thread identity parsed from the agent `id`. The chat agent
 * instance == the thread, so `id` is the per-THREAD key. When the thread is
 * about a specific repository we bind the read tools to it (the support-assistant
 * "tools scoped to the id" pattern, kept READ-ONLY); otherwise the chat agent
 * still converses with no repo-bound GitHub tools.
 */
export interface ChatThread {
  /** The raw id, unchanged (the durable session key). */
  id: string;
  /** The repo this thread is about, when the id encodes one; else undefined. */
  repo?: RepoRef;
}

/**
 * Parse the per-thread `id` into a `ChatThread`, extracting a repo ref when the
 * id encodes one. Recognised forms (kept liberal so the Phase-6 channel layer can
 * pick a key shape without re-touching the agent):
 *   - `github:owner/repo#N`            → { owner, repo }
 *   - `slack:team:channel:thread|owner/repo`  (a trailing `|owner/repo` binding)
 *   - any id containing a bare `owner/repo` segment
 * A `reset` GENERATION suffix (e.g. `…#g2`) is irrelevant here — it only changes
 * the durable session key, which is the whole `id`; repo parsing ignores it.
 * Unparseable / repo-less ids yield `{ id }` with no repo (chat still works).
 */
export function parseChatThread(id: string): ChatThread {
  const ref = parseRepoRef(id);
  return ref ? { id, repo: ref } : { id };
}

/**
 * Extract the FIRST `owner/repo` slug from a thread id, if any. Conservative:
 * owner/repo are GitHub name shapes (`[A-Za-z0-9._-]+`), and we stop the repo at
 * the first delimiter (`#`, `:`, whitespace, end) so `owner/repo#42` →
 * `{owner, repo}` without the issue number leaking in.
 */
function parseRepoRef(id: string): RepoRef | undefined {
  const m = id.match(/(?:^|[:|/\s])([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/);
  if (!m || !m[1] || !m[2]) return undefined;
  const owner = m[1];
  // Trim a trailing `#N` issue/PR reference off the repo segment.
  const repo = m[2].replace(/#.*$/, "");
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/**
 * Build the read-only chat agent's Flue config for one thread `id`.
 *
 * PURE + DI: `octokitFor(repo)` is the seam that turns a parsed repo into a
 * read-scoped Octokit (the discovered agent wires the real read-token minter;
 * tests pass a fake → fully offline). Returning `undefined` (e.g. no GitHub App
 * configured, or no repo in the id) simply yields a chat agent with NO github
 * tools — still read-only, still conversational.
 *
 * The result is intentionally NARROW (spec/11 read-only invariant):
 *   - model / thinkingLevel resolved for the `chat` task key;
 *   - instructions = the ONE shared persona + the chat suffix;
 *   - tools = ONLY `githubReadTools` (GET-only), bound to the thread's repo;
 *   - skills = the `chat` skill (native progressive disclosure);
 *   - NO `sandbox`, NO `cwd` — chat is sandbox-less (risk #5) and cannot run bash.
 */
export function buildChatAgentConfig(opts: {
  id: string;
  chatSkill: Skill;
  octokitFor: (repo: RepoRef) => Octokit | undefined;
}): AgentRuntimeConfig {
  const thread = parseChatThread(opts.id);
  const octokit = thread.repo ? opts.octokitFor(thread.repo) : undefined;
  const tools =
    thread.repo && octokit ? githubReadTools(thread.repo, octokit) : [];

  return {
    model: resolveModel(CHAT_TASK_KEY),
    thinkingLevel: resolveThinking(CHAT_TASK_KEY),
    instructions: loadPersona({ suffix: CHAT_SUFFIX }),
    tools,
    skills: [opts.chatSkill],
    // NO sandbox / cwd — chat is read-only + sandbox-less (spec/11; risk #5).
  };
}
