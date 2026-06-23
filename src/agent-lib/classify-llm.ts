/**
 * Production single-shot LLM runner for the comment CLASSIFIER + injection SCREENER
 * (Phase 6 — the `classifier-LLM wiring` follow-up the GitHub + Slack channels left).
 *
 * The classifier/screener helpers (`github-classify.ts`) call a `PromptRunner`
 * seam — `(system, user) => Promise<string>` — and parse a deterministic
 * `INTENT:` / `INJECTION:` marker out of the raw text. Tests inject a FAKE runner
 * (a canned string, NO live model). PRODUCTION needs a real runner; this module is
 * it: a small, bounded, NO-TOOLS chat-completions call, mirroring the reference's
 * `src/engine/llm.ts` openai adapter.
 *
 * WHY a direct provider call (not `dispatch`/`session.prompt`): the classifier needs
 * a SYNCHRONOUS result text inside the channel webhook callback, with a hard latency
 * budget (GitHub 10s / Slack 3s). `dispatch()` is fire-and-forget (no reply) and a
 * standalone harness/session isn't available in the channel callback. A single
 * no-tools chat call is the reference shape: cheap, bounded (max_completion_tokens +
 * a per-call timeout), and provider-selected by the `resolveModel('classifier')`
 * specifier prefix. The model is config-resolved (the `classifier` task key, default
 * → the configured default `openai/*`); the comment text reaches the model as DATA
 * inside the classifier's own user prompt (the callers untrusted-WRAP it; spec/09).
 *
 * Lives in `src/agent-lib/` (NOT discovered). Imported by both channels' default
 * `PromptRunner`. The classifier/screener still fail SAFE if this throws (no API
 * key / upstream error): the classifier defaults to CHAT, the screener fails open.
 *
 * 🚨 NO live model in tests: this module is exercised offline with a stubbed
 * `fetch`; the channels' OTHER tests inject a fake `PromptRunner` and never reach
 * this code path. No network call happens in any test or in `flue build`.
 */
import { resolveModel } from "../config.ts";
import type { PromptRunner } from "./github-classify.ts";

/** The task key `resolveModel` reads for the classifier/screener model. */
export const CLASSIFIER_TASK_KEY = "classifier" as const;

interface ProviderAdapter {
  match: (model: string) => boolean;
  envKey: string;
  url: string;
  buildBody: (modelId: string, system: string, user: string, maxTokens: number) => unknown;
  headers: (apiKey: string) => Record<string, string>;
  extract: (data: unknown) => string;
}

/** Strip the `provider/` prefix → the upstream model id. */
function modelId(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

const OPENAI_LIKE = (extraHeaders: Record<string, string> = {}): Omit<ProviderAdapter, "match" | "envKey" | "url"> => ({
  buildBody: (id, system, user, maxTokens) => ({
    model: id,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }),
  headers: (apiKey) => ({ "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...extraHeaders }),
  extract: (data) =>
    (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "",
});

/** Provider adapters, matched by the `resolveModel` specifier prefix. */
const PROVIDERS: ProviderAdapter[] = [
  {
    match: (m) => m.startsWith("openai/") || m.startsWith("gpt-"),
    envKey: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/chat/completions",
    ...OPENAI_LIKE(),
  },
  {
    match: (m) => m.startsWith("anthropic/") || m.toLowerCase().startsWith("claude"),
    envKey: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/messages",
    buildBody: (id, system, user, maxTokens) => ({
      model: id,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
    headers: (apiKey) => ({
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    extract: (data) => {
      const content = (data as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
      return content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
    },
  },
];

function adapterFor(model: string): ProviderAdapter {
  // Default to the openai adapter (the configured default is openai/*; reference parity).
  return PROVIDERS.find((p) => p.match(model)) ?? PROVIDERS[0]!;
}

export interface ClassifyLlmOptions {
  /** Hard cap on output tokens — these calls are tiny (default 256). */
  maxTokens?: number;
  /** Per-call timeout (default 8s — well under the GitHub 10s / Slack 3s budget). */
  timeoutMs?: number;
  /** Injected fetch (tests stub this; production = global fetch). */
  fetchImpl?: typeof fetch;
  /** Injected model specifier (tests pin it; production = resolveModel(classifier)). */
  model?: string;
}

/**
 * Build the production `PromptRunner`: a single-shot, no-tools chat call to the
 * provider implied by `resolveModel('classifier')`. Throws on a missing API key or
 * a non-2xx upstream response — both classifier callers CATCH and default safely
 * (intent → chat; screener → unflagged), so a model outage degrades to chat, never
 * a crash. NO retry loop (the channel's latency budget is tight; one cheap attempt).
 */
export function createClassifierRunner(opts: ClassifyLlmOptions = {}): PromptRunner {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxTokens = opts.maxTokens ?? 256;
  const timeoutMs = opts.timeoutMs ?? 8_000;

  return async (system: string, user: string): Promise<string> => {
    const model = opts.model ?? resolveModel(CLASSIFIER_TASK_KEY);
    const adapter = adapterFor(model);
    const apiKey = process.env[adapter.envKey];
    if (!apiKey) {
      throw new Error(`classifier LLM: ${adapter.envKey} not set`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(adapter.url, {
        method: "POST",
        signal: ctrl.signal,
        headers: adapter.headers(apiKey),
        body: JSON.stringify(adapter.buildBody(modelId(model), system, user, maxTokens)),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`classifier LLM upstream ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      return adapter.extract(data);
    } finally {
      clearTimeout(timer);
    }
  };
}
