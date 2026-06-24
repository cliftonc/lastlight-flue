import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "@flue/runtime";
import {
  webSearch,
  webFetch,
  webTools,
  guardFetchUrl,
  hasWebSearchProvider,
  type WebToolsOptions,
} from "./web.ts";

// All tests here are OFFLINE: the provider HTTP and DNS resolver are mocked /
// injected. No live web call is made by `pnpm test`.

/** Build a mocked fetch returning the given JSON body with status 200. */
function jsonFetch(body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]) as unknown as Headers,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  })) as unknown as typeof fetch;
}

/** Collect the declared input-property keys from a tool's valibot object schema. */
function propertyKeys(schema: unknown): string[] {
  const obj = schema as { entries?: Record<string, unknown> };
  return Object.keys(obj.entries ?? {});
}

describe("web_search", () => {
  it("sends the model query to Tavily (primary) and formats results", async () => {
    const fetchImpl = jsonFetch({
      results: [
        { title: "Result A", url: "https://a.example/x", content: "snippet a" },
        { title: "Result B", url: "https://b.example/y", content: "snippet b" },
      ],
    });
    const tool = webSearch({ keys: { tavily: "tvly-secret" }, fetchImpl });

    const out = await tool.run({ input: { query: "what is flue" } });

    // Provider HTTP was called with the model query + Tavily endpoint.
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("https://api.tavily.com/search");
    const sentBody = JSON.parse((call[1] as { body: string }).body);
    expect(sentBody.query).toBe("what is flue");

    // Results are formatted with title/url/snippet.
    expect(out).toContain("Result A");
    expect(out).toContain("https://a.example/x");
    expect(out).toContain("snippet a");
    expect(out).toContain("Result B");
  });

  it("uses Tavily over Exa/Brave when all keys present (precedence)", async () => {
    const fetchImpl = jsonFetch({ results: [] });
    const tool = webSearch({ keys: { tavily: "t", exa: "e", brave: "b" }, fetchImpl });
    await tool.run({ input: { query: "q" } });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain("api.tavily.com");
  });

  it("falls back to Exa when only Exa key is configured", async () => {
    const fetchImpl = jsonFetch({ results: [{ title: "E", url: "https://e/x", text: "et" }] });
    const tool = webSearch({ keys: { exa: "exa-key" }, fetchImpl });
    const out = await tool.run({ input: { query: "q" } });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain("api.exa.ai");
    expect(out).toContain("https://e/x");
  });

  it("falls back to Brave when only Brave key is configured", async () => {
    const fetchImpl = jsonFetch({ web: { results: [{ title: "B", url: "https://b/x", description: "bd" }] } });
    const tool = webSearch({ keys: { brave: "brave-key" }, fetchImpl });
    const out = await tool.run({ input: { query: "q" } });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(call[0])).toContain("api.search.brave.com");
    expect(out).toContain("https://b/x");
  });

  it("returns a graceful unavailable message when no provider key is configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const tool = webSearch({ keys: {}, fetchImpl });
    const out = await tool.run({ input: { query: "q" } });
    expect(out).toMatch(/unavailable/i);
    expect(out).toMatch(/no provider key/i);
    // Did NOT crash and did NOT call the provider.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("does NOT expose the API key or provider as a model parameter (security)", () => {
    const tool = webSearch({ keys: { tavily: "secret-key" } });
    const keys = propertyKeys(tool.input);
    expect(keys).toEqual(expect.arrayContaining(["query"]));
    // No key/provider/token/auth fields are model-selectable.
    for (const k of keys) {
      expect(k).not.toMatch(/key|token|provider|auth|secret/i);
    }
    // The valibot input declares ONLY query (+ optional count) — no key/provider entry.
    expect(keys.sort()).toEqual(["count", "query"]);
  });

  it("never includes the key in the output string", async () => {
    const fetchImpl = jsonFetch({ results: [{ title: "T", url: "https://x", content: "c" }] });
    const tool = webSearch({ keys: { tavily: "tvly-SUPERSECRET" }, fetchImpl });
    const out = await tool.run({ input: { query: "q" } });
    expect(out).not.toContain("tvly-SUPERSECRET");
  });
});

describe("web_fetch SSRF guard", () => {
  // A resolver that maps a couple of test hostnames to private IPs, otherwise a
  // public IP — lets us exercise the RESOLVED-IP check deterministically.
  const resolveHost = async (hostname: string): Promise<string> => {
    if (hostname === "rebind.evil.test") return "169.254.169.254";
    if (hostname === "internal.corp.test") return "10.1.2.3";
    if (hostname === "public.example.test") return "93.184.216.34";
    throw new Error(`unexpected host ${hostname}`);
  };
  const deps = { resolveHost };

  it("refuses the cloud metadata IP 169.254.169.254", async () => {
    const r = await guardFetchUrl("http://169.254.169.254/latest/meta-data/", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private|loopback|metadata|link-local/i);
  });

  it.each([
    ["http://127.0.0.1/x", "loopback v4"],
    ["http://10.0.0.5/x", "10/8"],
    ["http://192.168.1.1/x", "192.168/16"],
    ["http://172.16.5.5/x", "172.16/12"],
    ["http://[::1]/x", "loopback v6"],
  ])("refuses private IP literal %s (%s)", async (url) => {
    const r = await guardFetchUrl(url, deps);
    expect(r.ok).toBe(false);
  });

  it("refuses localhost (internal hostname) by name", async () => {
    const r = await guardFetchUrl("http://localhost:8080/admin", deps);
    expect(r.ok).toBe(false);
  });

  it("refuses metadata.google.internal by name", async () => {
    const r = await guardFetchUrl("http://metadata.google.internal/computeMetadata/v1/", deps);
    expect(r.ok).toBe(false);
  });

  it("refuses non-http(s) schemes (file://, gopher://)", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://host/x"]) {
      const r = await guardFetchUrl(url, deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/scheme/i);
    }
  });

  it("refuses a hostname that RESOLVES to a private IP (DNS-rebinding defense)", async () => {
    const r = await guardFetchUrl("https://internal.corp.test/secrets", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/resolves to 10\.1\.2\.3/);
  });

  it("refuses a hostname that RESOLVES to the metadata IP", async () => {
    const r = await guardFetchUrl("https://rebind.evil.test/", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/169\.254\.169\.254/);
  });

  it("ALLOWS a normal public URL whose host resolves to a public IP", async () => {
    const r = await guardFetchUrl("https://public.example.test/page", deps);
    expect(r.ok).toBe(true);
  });

  it("web_fetch tool returns a refusal string (no request) for a blocked URL", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const tool = webFetch({ fetchImpl, resolveHost });
    const out = await tool.run({ input: { url: "http://169.254.169.254/" } });
    expect(out).toMatch(/refused/i);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("web_fetch tool fetches and cleans a public URL", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
      async text() {
        return "<html><body><h1>Hi</h1><script>bad()</script><p>Body text</p></body></html>";
      },
    })) as unknown as typeof fetch;
    const tool = webFetch({ fetchImpl, resolveHost });
    const out = await tool.run({ input: { url: "https://public.example.test/page" } });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(out).toContain("Hi");
    expect(out).toContain("Body text");
    expect(out).not.toContain("bad()"); // script stripped
  });

  it("does NOT expose a resolver/host override as a model parameter", () => {
    const tool = webFetch();
    const keys = propertyKeys(tool.input);
    // The valibot input declares ONLY url — no resolver/host/fetch override is model-selectable.
    expect(keys).toEqual(["url"]);
  });
});

describe("webTools factory", () => {
  it("returns exactly web_search + web_fetch (gated set, opt-in)", () => {
    const tools: ToolDefinition[] = webTools({ keys: {} });
    expect(tools.map((t) => t.name).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("hasWebSearchProvider reflects key presence", () => {
    expect(hasWebSearchProvider({ TAVILY_API_KEY: "x" } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasWebSearchProvider({ EXA_API_KEY: "x" } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasWebSearchProvider({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

// GATED live smoke — one real Tavily search. SKIPPED by default; only runs with
// WEB_TOOLS_LIVE=1 and a real TAVILY_API_KEY. Do NOT run in CI / default test.
const LIVE = process.env.WEB_TOOLS_LIVE === "1" && !!process.env.TAVILY_API_KEY;
describe.skipIf(!LIVE)("web_search live smoke (gated)", () => {
  it("performs a real Tavily search", async () => {
    const opts: WebToolsOptions = { keys: { tavily: process.env.TAVILY_API_KEY! } };
    const tool = webSearch(opts);
    const out = await tool.run({ input: { query: "Flue framework withastro" } });
    expect(out).toMatch(/Web search results/i);
  }, 30000);
});
