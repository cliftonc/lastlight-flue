import { createAgent, type AgentRouteHandler } from '@flue/runtime';

// Phase 0 · Spike 1 — hello-world agent.
// Proves: Flue's Pi-backed agent runtime answers a turn on our OpenAI key, with
// the default model an `openai/*` specifier (no Anthropic key is present).
//
// Verified against installed @flue/runtime 1.0.0-beta.2: the export is
// `createAgent` (NOT `defineAgent`) and HTTP exposure requires a `route` export.
// See spec/flue-reference.md §0.

export const description = 'Phase 0 spike: minimal hello-world agent on our OpenAI key.';

// Open route — this is a throwaway local proof, so no auth gate. The real agents
// (Phase 2+) attach authentication here.
export const route: AgentRouteHandler = async (_c, next) => next();

// Built-in `openai` provider authenticates from `OPENAI_API_KEY` in env — no
// registerProvider() needed. Default model mirrors the reference app's
// `LASTLIGHT_MODEL` (openai/gpt-5.1).
const DEFAULT_MODEL = process.env.LASTLIGHT_MODEL ?? 'openai/gpt-5.1';

export default createAgent(() => ({
  model: DEFAULT_MODEL,
  instructions:
    'You are a terse hello-world agent. Reply to each message in a single short sentence.',
}));
