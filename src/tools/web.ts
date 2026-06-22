/**
 * Web research tools (`web_search` + `web_fetch`) as bound Flue `defineTool`
 * factories, GATED behind a provider key and opted into per agent/phase.
 *
 * WHY THESE EXIST (design/phase-5-workflows-chat.md §DRIFT, spec/09, flue-reference
 * §4/§6): Flue/Pi exposes NO first-class `web_search`/`web_fetch` agent tool. Last
 * Light gated web search per phase by forwarding whichever provider key was present
 * (Tavily › Exa › Brave) into the sandbox so agentic-pi's built-in tool could run.
 * Here we reimplement that as bound `defineTool`s: the provider HTTP call is made
 * from TRUSTED tool code (not the model picking a key/provider), and the tools are
 * attached ONLY to agents/phases that opt in (the explorer agent, later) — NEVER
 * added globally to every agent.
 *
 * SECURITY MODEL (non-negotiable):
 *   - The provider API key + provider choice are CLOSED OVER at construction time.
 *     They are NEVER model-selectable `parameters`. The model supplies only a
 *     search query (+ optional result count) or a URL to fetch. Keys are never
 *     logged or returned.
 *   - `web_fetch` runs on the NODE SERVER (host side), NOT inside the sandbox, so
 *     the (deferred) sandbox egress floor does NOT cover it. It therefore carries
 *     its OWN, non-negotiable SSRF guard: it rejects non-http(s) schemes and any
 *     URL whose host — OR its DNS-RESOLVED address — falls in a private / loopback
 *     / link-local / unique-local / cloud-metadata range (127/8, 10/8, 172.16/12,
 *     192.168/16, 169.254.0.0/16 incl. 169.254.169.254, ::1, fc00::/7, fe80::/10,
 *     …). Resolving the host before fetching defeats DNS-rebinding-to-private.
 *   - No provider key configured → the tool's `execute` returns a clear
 *     "unavailable" string, never throws/crashes.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import { INTERNAL_HOSTNAMES, isPrivateOrInternalIp } from "../engine/egress-allowlist.ts";

// ---------------------------------------------------------------------------
// Provider configuration (closed over; never model-selectable).
// ---------------------------------------------------------------------------

export type WebSearchProvider = "tavily" | "exa" | "brave";

/** Provider precedence: same as Last Light. Tavily primary; Exa/Brave optional. */
const PROVIDER_ORDER: WebSearchProvider[] = ["tavily", "exa", "brave"];

interface ProviderKeys {
  tavily?: string;
  exa?: string;
  brave?: string;
}

/** Read provider keys from the environment (Tavily primary; others optional). */
function readProviderKeysFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderKeys {
  return {
    tavily: env.TAVILY_API_KEY?.trim() || undefined,
    // Accept the common aliases used by each provider's own SDK/docs.
    exa: (env.EXA_API_KEY || env.EXASEARCH_API_KEY)?.trim() || undefined,
    brave: (env.BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY)?.trim() || undefined,
  };
}

/**
 * Pick the first configured provider in precedence order, returning its key.
 * `undefined` → no provider key configured (graceful-unavailable path).
 */
function selectProvider(keys: ProviderKeys): { provider: WebSearchProvider; key: string } | undefined {
  for (const provider of PROVIDER_ORDER) {
    const key = keys[provider];
    if (key) return { provider, key };
  }
  return undefined;
}

export interface WebToolsOptions {
  /** Override provider keys (tests). Defaults to reading from `process.env`. */
  keys?: ProviderKeys;
  /** Injectable fetch (tests mock the provider HTTP). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable DNS resolver returning the resolved IP literal for a hostname.
   * Lets the SSRF resolved-IP check be tested without real DNS. Defaults to
   * `node:dns/promises` lookup.
   */
  resolveHost?: (hostname: string) => Promise<string>;
  /** Max characters returned by web_fetch before truncation. Default 20000. */
  maxFetchChars?: number;
}

// ---------------------------------------------------------------------------
// Result shape + formatting.
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No web search results for: ${query}`;
  const lines = results.map(
    (r, i) =>
      `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}\n   ${(r.snippet || "").replace(/\s+/g, " ").trim()}`,
  );
  return `Web search results for: ${query}\n\n${lines.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Provider clients. Each returns normalized {title,url,snippet}[]. Keys are
// passed in (closed over by the factory), never read here from the model.
// ---------------------------------------------------------------------------

async function searchTavily(
  fetchImpl: typeof fetch,
  key: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const res = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function searchExa(
  fetchImpl: typeof fetch,
  key: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const res = await fetchImpl("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: 500 } } }),
    signal,
  });
  if (!res.ok) throw new Error(`Exa search failed: ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; text?: string; snippet?: string }>;
  };
  return (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.text ?? r.snippet ?? "",
  }));
}

async function searchBrave(
  fetchImpl: typeof fetch,
  key: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const res = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { accept: "application/json", "x-subscription-token": key },
    signal,
  });
  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

async function runProviderSearch(
  provider: WebSearchProvider,
  fetchImpl: typeof fetch,
  key: string,
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  switch (provider) {
    case "tavily":
      return searchTavily(fetchImpl, key, query, count, signal);
    case "exa":
      return searchExa(fetchImpl, key, query, count, signal);
    case "brave":
      return searchBrave(fetchImpl, key, query, count, signal);
  }
}

// ---------------------------------------------------------------------------
// web_search tool factory.
// ---------------------------------------------------------------------------

const DEFAULT_RESULT_COUNT = 5;
const MAX_RESULT_COUNT = 10;

/**
 * `web_search` — query the configured provider (Tavily › Exa › Brave by key
 * presence). The provider + key are closed over; the model supplies only a
 * `query` and optional `count`. No provider key → a clear unavailable message
 * (never a throw). Returns formatted title/url/snippet results.
 */
export function webSearch(opts: WebToolsOptions = {}): ToolDefinition {
  const keys = opts.keys ?? readProviderKeysFromEnv();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const selected = selectProvider(keys);

  return defineTool({
    name: "web_search",
    description:
      "Search the public web for up-to-date information. Returns a ranked list of titles, URLs, and snippets. Use web_fetch to read a result's full page.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "The search query." },
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULT_COUNT,
          description: `Number of results to return (default ${DEFAULT_RESULT_COUNT}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args, signal) {
      if (!selected) {
        return "web search unavailable (no provider key configured). Set TAVILY_API_KEY (or EXA_API_KEY / BRAVE_API_KEY) to enable it.";
      }
      const query = String((args as { query: string }).query);
      const rawCount = (args as { count?: number }).count;
      const count = Math.min(
        Math.max(typeof rawCount === "number" ? rawCount : DEFAULT_RESULT_COUNT, 1),
        MAX_RESULT_COUNT,
      );
      try {
        const results = await runProviderSearch(selected.provider, fetchImpl, selected.key, query, count, signal);
        return formatResults(query, results);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Never leak the key in an error path; provider client messages above
        // never include the key.
        return `web search failed (${selected.provider}): ${msg}`;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// SSRF guard for web_fetch.
// ---------------------------------------------------------------------------

export interface UrlGuardDeps {
  resolveHost: (hostname: string) => Promise<string>;
}

/**
 * Default host resolver: returns the first resolved IP literal for a hostname.
 * IP literals pass through unchanged (no DNS needed).
 */
async function defaultResolveHost(hostname: string): Promise<string> {
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) return hostname.replace(/^\[|\]$/g, "");
  const { address } = await dnsLookup(hostname);
  return address;
}

/**
 * Validate a model-supplied URL for `web_fetch`. Returns `{ ok: true, url }` for
 * a safe public http(s) URL, or `{ ok: false, reason }` describing why it was
 * refused. NON-NEGOTIABLE: rejects non-http(s) schemes and any host that is — or
 * resolves to — a private/loopback/link-local/metadata address (defeats
 * DNS-rebinding-to-private by checking the RESOLVED IP, not just the literal).
 */
export async function guardFetchUrl(
  raw: string,
  deps: UrlGuardDeps,
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme not allowed (${url.protocol}); only http and https are permitted` };
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return { ok: false, reason: "missing host" };

  // Block well-known internal hostnames by NAME (metadata.google.internal,
  // localhost) before any DNS, independent of what they resolve to.
  if (INTERNAL_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `host '${hostname}' is an internal/metadata endpoint` };
  }
  // If the host is an IP literal, check it directly.
  if (isIP(hostname)) {
    if (isPrivateOrInternalIp(hostname)) {
      return { ok: false, reason: `host IP ${hostname} is in a private/loopback/link-local/metadata range` };
    }
    return { ok: true, url };
  }
  // Hostname → resolve and check the RESOLVED IP (defeats DNS rebinding to a
  // private/metadata address).
  let resolved: string;
  try {
    resolved = await deps.resolveHost(hostname);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `could not resolve host '${hostname}': ${msg}` };
  }
  if (isPrivateOrInternalIp(resolved)) {
    return {
      ok: false,
      reason: `host '${hostname}' resolves to ${resolved}, a private/loopback/link-local/metadata address`,
    };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// web_fetch tool factory.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FETCH_CHARS = 20000;

/** Strip HTML to roughly readable text (cheap, dependency-free). */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `web_fetch` — fetch a model-supplied URL (host side) and return its text,
 * cleaned + truncated. Guarded by the SSRF floor in `guardFetchUrl`: blocked URLs
 * yield a clear refusal string, NEVER a host-internal request.
 */
export function webFetch(opts: WebToolsOptions = {}): ToolDefinition {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const maxChars = opts.maxFetchChars ?? DEFAULT_MAX_FETCH_CHARS;

  return defineTool({
    name: "web_fetch",
    description:
      "Fetch the text content of a public http(s) URL and return it (HTML cleaned to text, truncated). Refuses private/internal/metadata addresses.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, description: "The http(s) URL to fetch." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(args, signal) {
      const raw = String((args as { url: string }).url);
      const guard = await guardFetchUrl(raw, { resolveHost });
      if (!guard.ok) {
        return `web_fetch refused: ${guard.reason}. URL: ${raw}`;
      }
      try {
        const res = await fetchImpl(guard.url.toString(), {
          method: "GET",
          redirect: "error", // a redirect could escape the SSRF check; refuse it
          headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
          signal,
        });
        if (!res.ok) return `web_fetch failed: HTTP ${res.status} for ${guard.url.toString()}`;
        const contentType = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const text = /html/i.test(contentType) ? htmlToText(body) : body;
        const truncated =
          text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[...truncated ${text.length - maxChars} chars]` : text;
        return `Fetched ${guard.url.toString()} (${contentType || "unknown type"}):\n\n${truncated}`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `web_fetch failed for ${guard.url.toString()}: ${msg}`;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Combined factory: opt an agent into web tools via `tools: [...webTools()]`.
// ---------------------------------------------------------------------------

/**
 * Build the web research tool set (`web_search` + `web_fetch`). GATED: attach
 * ONLY to agents/phases that opt in (the explorer agent, later) — do NOT add to
 * every agent. With no provider key, `web_search` returns a graceful unavailable
 * message; `web_fetch` works regardless (it needs no provider key).
 */
export function webTools(opts: WebToolsOptions = {}): ToolDefinition[] {
  return [webSearch(opts), webFetch(opts)];
}

/** True if any web-search provider key is configured (Tavily › Exa › Brave). */
export function hasWebSearchProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  return selectProvider(readProviderKeysFromEnv(env)) !== undefined;
}
