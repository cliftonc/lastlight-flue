/**
 * The read-only CHAT agent — a DISCOVERED Flue agent (default export
 * `createAgent`), addressable at `POST /agents/chat/:id` (`route` export) and
 * dispatchable via `dispatch(chat, { id, input })`. The per-thread `id` IS the
 * durable session key (spec/11-chat.md; design/phase-5-workflows-chat.md → "Chat
 * agent").
 *
 * WHY THIS FILE IS THIN: Flue discovers every IMMEDIATE file in `src/agents/` as
 * an addressable agent and INLINES its module-eval into `dist/server.mjs`
 * (flue-reference §0 / PROGRESS DISCOVERY RULE) — so this file is just the
 * discovered shell. The persona suffix, thread-id parsing, and the pure config
 * builder live in the NON-discovered `src/agent-lib/chat.ts` (unit-tested there);
 * the read-token mint lives in `src/agent-lib/chat-token.ts`. The hello.ts shape
 * is mirrored: `description` + `route` exports + a `createAgent` default export.
 *
 * THE AGENT INSTANCE == THE THREAD. `createAgent(({ id }) => …)` receives the
 * per-thread `id`; we parse a repo from it (the support-assistant "tools scoped
 * to the id" pattern, kept READ-ONLY) and bind the GET-only `github_*` tools to
 * that repo. Flue persists this thread's session (messages + compacted context)
 * durably per `id` (src/db.ts sqlite), so a multi-turn thread continues across a
 * process restart — replacing the reference's manual `messaging_sessions` +
 * 50-message rehydrate.
 *
 * READ-ONLY INVARIANT (spec/11): the config carries ONLY `githubReadTools` and NO
 * `sandbox` — chat physically cannot edit/commit/comment/label or run bash. It
 * ANSWERS; the chat skill REDIRECTS action requests to the `build`/triage/review
 * workflow triggers. The token minted here is the `read` profile (the narrowest
 * GitHub App scope — contents/issues/PRs/metadata READ), so even the bound
 * Octokit cannot write.
 *
 * RISK #5 (turn latency): sandbox-less + GET-only tools → no per-turn container
 * provision/clone; a turn costs the LLM call + read GETs (the same order as the
 * reference's lighter `completeSimple` path).
 * RISK #6 (per-thread serialization): a FLUE GUARANTEE, not implemented here —
 * Flue's durable per-instance ORDERED submission queue processes two
 * near-simultaneous messages on the same `id` in accepted order (flue-reference
 * §0; spec/11). Different threads (`id`s) run in parallel. We rely on it.
 */
import { createAgent, type AgentRouteHandler } from "@flue/runtime";
import { buildChatAgentConfig } from "../agent-lib/chat.ts";
import { mintReadOctokitFor } from "../agent-lib/chat-token.ts";
import chatSkill from "../skills/chat/SKILL.md" with { type: "skill" };

export const description =
  "Read-only conversational assistant for messaging threads: answers questions about repos/issues/PRs via GET-only GitHub tools, redirects action requests to workflows. No sandbox, no writes; durable per-thread session.";

/**
 * Open route for now (mirrors hello.ts) — direct HTTP access is unauthenticated
 * in dev. Chat is normally driven via `dispatch()` from the verified Slack
 * channel (Phase 6), which is where principal/thread auth belongs.
 *
 * TODO(phase-6/channels): gate this — verify the caller may access the thread
 * named by `:id` (the support-assistant route pattern: authenticate the
 * principal, 401 if absent, `c.notFound()` if the principal can't access this
 * thread). The channel-layer signature verification + allowed-users gate land
 * with the Slack/GitHub channels.
 */
export const route: AgentRouteHandler = async (_c, next) => next();

/**
 * The discovered chat agent. The initializer is ASYNC (Flue allows
 * `AgentRuntimeConfig | Promise<AgentRuntimeConfig>`) so we can mint a read-scoped
 * installation token for the thread's repo before binding the read tools.
 *
 * `mintReadOctokitFor` returns `undefined` when there is no GitHub App configured
 * (or no repo in the id) — in that case the chat agent has no github tools but
 * still converses; it is never given write tools or a sandbox.
 */
export default createAgent<{ text?: string }>(async ({ id }) => {
  // Pre-mint the read Octokit for the thread's repo (async), then hand
  // buildChatAgentConfig a SYNC lookup returning that pre-built client.
  const bound = await mintReadOctokitFor(id);
  return buildChatAgentConfig({
    id,
    chatSkill,
    octokitFor: (repo) => (bound && bound.owner === repo.owner && bound.repo === repo.repo ? bound.octokit : undefined),
  });
});
