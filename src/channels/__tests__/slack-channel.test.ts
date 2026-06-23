import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SlackEvent, SlackThreadRef } from "@flue/slack";

const key = (ref: SlackThreadRef) => `slack:${ref.teamId}:${ref.channelId}:${ref.threadTs}`;

function ev(over: Record<string, unknown> = {}): SlackEvent {
  return { type: "app_mention", user: "U_ALICE", text: "<@U_BOT> hello", channel: "C9", ts: "100.1", ...over } as unknown as SlackEvent;
}

describe("slack channel — graceful missing-secret construction", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET; // simulate the secret being UNSET
    vi.resetModules();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = prev;
  });

  it("importing the channel with SLACK_SIGNING_SECRET unset does NOT throw (placeholder used)", async () => {
    // Live Slack is INACTIVE until the real secret is set; construction must still
    // succeed so the server boots + `flue build` passes (offline placeholder).
    const mod = await import("../slack.ts");
    expect(mod.channel).toBeDefined();
    expect(mod.channel.routes.length).toBeGreaterThan(0);
    // routes published: /channels/slack/events + /channels/slack/commands.
    const paths = mod.channel.routes.map((r) => r.path);
    expect(paths.some((p) => p.includes("events"))).toBe(true);
    expect(paths.some((p) => p.includes("commands"))).toBe(true);
  });
});

describe("slack channel — handleEvent pipeline (offline, no side effects)", () => {
  beforeEach(() => vi.resetModules());

  function harness() {
    const dispatchChat = vi.fn(async (_id: string, _input: Record<string, unknown>) => {});
    const invokeWorkflow = vi.fn(async (_wf: string, _payload: Record<string, unknown>) => {});
    return {
      dispatchChat,
      invokeWorkflow,
      dispatch: { dispatchChat, invokeWorkflow },
      // router with no LLM: classify/screen injected.
      router: { run: async () => { throw new Error("no LLM"); }, classify: async () => ({ intent: "chat" as const }), screen: async () => ({ flagged: false }) },
      allowedUsers: ["U_ALICE"],
    };
  }

  it("a DM/mention from an allowlisted user → dispatches the chat agent on the thread key", async () => {
    const { handleEvent } = await import("../slack.ts");
    const { SlackEventDedupe } = await import("../../agent-lib/slack-screener.ts");
    const h = harness();
    const res = await handleEvent(ev(), "T1", "Ev1", key, {
      allowedUsers: h.allowedUsers,
      dedupe: new SlackEventDedupe(),
      router: h.router,
      dispatch: h.dispatch,
    });
    expect(res).toEqual({ status: "chat" });
    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
    expect(h.dispatchChat).toHaveBeenCalledWith("slack:T1:C9:100.1", expect.objectContaining({ text: "hello", source: "slack" }));
    // NO trigger_id / response_url ever in the dispatched chat input.
    expect(JSON.stringify(h.dispatchChat.mock.calls[0]![1])).not.toMatch(/trigger_id|response_url/);
  });

  it("a non-allowlisted user is dropped (filtered, no dispatch)", async () => {
    const { handleEvent } = await import("../slack.ts");
    const { SlackEventDedupe } = await import("../../agent-lib/slack-screener.ts");
    const h = harness();
    const res = await handleEvent(ev({ user: "U_EVE" }), "T1", "Ev2", key, {
      allowedUsers: h.allowedUsers,
      dedupe: new SlackEventDedupe(),
      router: h.router,
      dispatch: h.dispatch,
    });
    expect(res.status).toBe("filtered");
    expect(h.dispatchChat).not.toHaveBeenCalled();
  });

  it("a bot message is dropped (no self-loop)", async () => {
    const { handleEvent } = await import("../slack.ts");
    const { SlackEventDedupe } = await import("../../agent-lib/slack-screener.ts");
    const h = harness();
    const res = await handleEvent(ev({ bot_id: "B1" }), "T1", "Ev3", key, {
      allowedUsers: [],
      dedupe: new SlackEventDedupe(),
      router: h.router,
      dispatch: h.dispatch,
    });
    expect(res.status).toBe("filtered");
    expect(h.dispatchChat).not.toHaveBeenCalled();
  });

  it("DEDUPE: a retry with the same event_id is processed once", async () => {
    const { handleEvent } = await import("../slack.ts");
    const { SlackEventDedupe } = await import("../../agent-lib/slack-screener.ts");
    const h = harness();
    const dedupe = new SlackEventDedupe();
    const args = ["T1", "same-ev", key] as const;
    const first = await handleEvent(ev(), ...args, { allowedUsers: h.allowedUsers, dedupe, router: h.router, dispatch: h.dispatch });
    const second = await handleEvent(ev(), ...args, { allowedUsers: h.allowedUsers, dedupe, router: h.router, dispatch: h.dispatch });
    expect(first.status).toBe("chat");
    expect(second.status).toBe("duplicate");
    expect(h.dispatchChat).toHaveBeenCalledTimes(1);
  });

  it("a clear explore command diverts to the explore workflow via the invoker seam", async () => {
    const { handleEvent } = await import("../slack.ts");
    const { SlackEventDedupe } = await import("../../agent-lib/slack-screener.ts");
    const h = harness();
    const res = await handleEvent(ev({ text: "<@U_BOT> explore this idea" }), "T1", "Ev9", key, {
      allowedUsers: h.allowedUsers,
      dedupe: new SlackEventDedupe(),
      router: { ...h.router, classify: async () => ({ intent: "explore" }) },
      dispatch: h.dispatch,
    });
    expect(res).toEqual({ status: "accepted", workflow: "explore" });
    expect(h.invokeWorkflow).toHaveBeenCalledWith("explore", expect.objectContaining({ triggerId: "slack:T1:C9:100.1" }));
  });
});

// Phase 7 final slice — the chat-dispatch path RECORDS a messaging thread (the
// grouping the sessions list reads). Exercises the PRODUCTION `defaultDispatchDeps`
// (NO injected `dispatch`) with `@flue/runtime`'s `dispatch` mocked (so no real
// runtime) and a FAKE thread recorder injected (test-inert seam) — proving the
// hook upserts on first sight and bumps on the next turn.
describe("slack channel — chat-dispatch records a messaging thread", () => {
  beforeEach(() => vi.resetModules());

  it("records the thread (channel/key derived) on dispatch, bumps on a second turn", async () => {
    const dispatched: Array<{ id: string }> = [];
    // Mock ONLY `dispatch` so the PRODUCTION chat path runs offline; keep the rest
    // of @flue/runtime (createAgent etc., used by the imported chat agent).
    vi.doMock("@flue/runtime", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@flue/runtime")>();
      return {
        ...actual,
        dispatch: vi.fn(async (_agent: unknown, opts: { id: string }) => {
          dispatched.push({ id: opts.id });
        }),
      };
    });
    const { handleEvent } = await import("../slack.ts");
    const { SlackEventDedupe } = await import("../../agent-lib/slack-screener.ts");
    const { setThreadRecorder } = await import("../../agent-lib/record-thread.ts");

    const recorded: string[] = [];
    const prev = setThreadRecorder({ record: (a) => recorded.push(a.instanceId) });
    try {
      const router = {
        run: async () => { throw new Error("no LLM"); },
        classify: async () => ({ intent: "chat" as const }),
        screen: async () => ({ flagged: false }),
      };
      const dedupe = new SlackEventDedupe();
      // First turn → dispatch + record (NO `dispatch` opt → production seam).
      await handleEvent(ev(), "T1", "Ev-A", key, { allowedUsers: ["U_ALICE"], dedupe, router });
      // Second turn on the SAME thread (new ts, but thread_ts anchors the thread).
      await handleEvent(ev({ ts: "100.2", thread_ts: "100.1" }), "T1", "Ev-B", key, { allowedUsers: ["U_ALICE"], dedupe, router });

      // Both turns dispatched the chat agent on the same thread key.
      expect(dispatched.map((d) => d.id)).toEqual(["slack:T1:C9:100.1", "slack:T1:C9:100.1"]);
      // And BOTH recorded the thread (the store upserts insert→bump on the key).
      expect(recorded).toEqual(["slack:T1:C9:100.1", "slack:T1:C9:100.1"]);
    } finally {
      setThreadRecorder(prev ?? null);
      vi.doUnmock("@flue/runtime");
    }
  });
});

describe("slack channel — handleCommand (/approve /reject → resume)", () => {
  beforeEach(() => vi.resetModules());

  it("/approve <runId> → resume(runId, 'approve') via the injected seam", async () => {
    const { handleCommand } = await import("../slack.ts");
    const resumeGate = vi.fn(async () => {});
    const res = await handleCommand("/approve", "run-7", "slack:T1:C9:C9", { resumeGate });
    expect(res).toEqual({ status: "resumed", reason: "approve" });
    expect(resumeGate).toHaveBeenCalledWith("run-7", "approve", undefined);
  });

  it("/reject <runId> → resume(runId, 'reject')", async () => {
    const { handleCommand } = await import("../slack.ts");
    const resumeGate = vi.fn(async () => {});
    const res = await handleCommand("/reject", "run-7", "slack:T1:C9:C9", { resumeGate });
    expect(res).toEqual({ status: "resumed", reason: "reject" });
    expect(resumeGate).toHaveBeenCalledWith("run-7", "reject", undefined);
  });

  it("an un-correlatable command is ignored (no resume, no crash)", async () => {
    const { handleCommand } = await import("../slack.ts");
    const resumeGate = vi.fn(async () => {});
    // No runId text + no paused run on the thread → ignored (gateLookup → null).
    const res = await handleCommand("/approve", "", "slack:T1:C9:C9", { resumeGate, gateLookup: async () => null });
    expect(res.status).toBe("ignored");
    expect(resumeGate).not.toHaveBeenCalled();
  });

  // Phase 6 — CONVERSATION→runId correlation: with no runId text, the thread
  // conversationKey resolves the paused build gate (mirrors GitHub).
  it("/approve with NO runId text resolves the paused gate via the conversationKey gateLookup", async () => {
    const { handleCommand } = await import("../slack.ts");
    const resumeGate = vi.fn(async () => {});
    const gateLookup = vi.fn(async (k: string) => (k === "slack:T1:C9:C9" ? "build-run-9" : null));
    const res = await handleCommand("/approve", "", "slack:T1:C9:C9", { resumeGate, gateLookup });
    expect(res).toEqual({ status: "resumed", reason: "approve" });
    expect(gateLookup).toHaveBeenCalledWith("slack:T1:C9:C9");
    expect(resumeGate).toHaveBeenCalledWith("build-run-9", "approve", undefined);
  });

  it("/reject with no paused run on the thread → ignored (clean no-op)", async () => {
    const { handleCommand } = await import("../slack.ts");
    const resumeGate = vi.fn(async () => {});
    const res = await handleCommand("/reject", "", "slack:T1:C9:C9", { resumeGate, gateLookup: async () => null });
    expect(res.status).toBe("ignored");
    expect(resumeGate).not.toHaveBeenCalled();
  });
});
