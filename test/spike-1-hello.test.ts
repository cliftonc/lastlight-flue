import { describe, it, expect } from 'vitest';

// Phase 0 · Spike 1 acceptance — hello-world agent answers a turn on our OpenAI key.
//
// This makes a REAL, paid model call, so it is gated on FLUE_SERVER_URL and
// skipped by default (keeps `pnpm test` free and green). To run it live:
//
//   pnpm exec flue dev --env secrets/.env --port 3583   # in one shell
//   FLUE_SERVER_URL=http://localhost:3583 pnpm test       # in another
//
// Empirically passed 2026-06-21 against openai/gpt-5.1 — see spec/flue-reference.md §0
// and PROGRESS.md for the recorded response.

const SERVER = process.env.FLUE_SERVER_URL;

describe.skipIf(!SERVER)('spike-1 hello agent (live)', () => {
  it('returns model text from the openai provider', async () => {
    const res = await fetch(`${SERVER}/agents/hello/spike-1-test?wait=result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Reply with a one-word greeting.' }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      result?: { text?: string; model?: { provider?: string; id?: string } };
    };
    expect(body.result?.text).toBeTruthy();
    // Default model is an openai/* specifier (no Anthropic key present).
    expect(body.result?.model?.provider).toBe('openai');
  });
});
