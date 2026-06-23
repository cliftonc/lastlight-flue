import { describe, it, expect } from 'vitest';
import { createDefaultChatSessionReader } from './chat-session-reader.ts';
import type { ThreadLister } from './session-reader.ts';
import type { MessagingThread } from '../threads-store.ts';

// Phase 7 · SSE slice — the chat-session reader lists chat THREADS (blob-free)
// and reads each transcript from the chat-agent event stream. Fully offline:
// a fake thread lister + a fake EventStreamStore connector.

const thread = (over: Partial<MessagingThread> = {}): MessagingThread => ({
  instanceId: 'slack:v1:T1:C2:100.1',
  channel: 'slack',
  repo: null,
  meta: {},
  title: null,
  createdAt: '2026-06-23T09:00:00.000Z',
  lastActivityAt: '2026-06-23T09:30:00.000Z',
  messageCount: 4,
  ...over,
});

const fakeLister = (threads: MessagingThread[]): ThreadLister => ({
  listThreads: () => ({ threads, nextCursor: null }),
});

const fakeStores = (events: Array<{ data: unknown; offset: string }> = []) => ({
  eventStreamStore: {
    async readEvents() {
      return { events, nextOffset: '0_1', upToDate: true };
    },
    async getStreamMeta() {
      return events.length ? { nextOffset: '0_1' } : null;
    },
  },
});

describe('createDefaultChatSessionReader.listSessions', () => {
  it('lists chat threads as kind:chat sessions, newest activity first', async () => {
    const reader = createDefaultChatSessionReader({
      threadLister: fakeLister([
        thread({ instanceId: 'a', lastActivityAt: '2026-06-23T08:00:00.000Z' }),
        thread({ instanceId: 'b', lastActivityAt: '2026-06-23T10:00:00.000Z' }),
      ]),
      connect: async () => fakeStores() as never,
    });
    const { sessions } = await reader.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(['b', 'a']);
    expect(sessions.every((s) => s.kind === 'chat')).toBe(true);
  });

  it('degrades to an empty list when no threadLister wired', async () => {
    const reader = createDefaultChatSessionReader({
      connect: async () => fakeStores() as never,
    });
    const { sessions } = await reader.listSessions();
    expect(sessions).toEqual([]);
  });

  it('is NON-FATAL: a throwing threadLister yields an empty list', async () => {
    const reader = createDefaultChatSessionReader({
      threadLister: () => {
        throw new Error('threads-store down');
      },
      connect: async () => fakeStores() as never,
    });
    const { sessions } = await reader.listSessions();
    expect(sessions).toEqual([]);
  });
});

describe('createDefaultChatSessionReader.exists', () => {
  it('true when the chat-agent stream has events', async () => {
    const reader = createDefaultChatSessionReader({
      connect: async () => fakeStores([{ data: {}, offset: '0_1' }]) as never,
    });
    expect(await reader.exists('slack:v1:T1:C2:100.1')).toBe(true);
  });

  it('falls back to the thread list when the stream is empty', async () => {
    const reader = createDefaultChatSessionReader({
      threadLister: fakeLister([thread({ instanceId: 'known' })]),
      connect: async () => fakeStores() as never,
    });
    expect(await reader.exists('known')).toBe(true);
    expect(await reader.exists('unknown')).toBe(false);
  });
});

describe('createDefaultChatSessionReader.readTranscript', () => {
  it('reads the chat-agent stream path and maps events to messages', async () => {
    let readPath = '';
    const reader = createDefaultChatSessionReader({
      connect: async () =>
        ({
          eventStreamStore: {
            async readEvents(path: string) {
              readPath = path;
              return {
                events: [
                  {
                    data: {
                      type: 'message_end',
                      message: { role: 'user', content: 'hi' },
                    },
                    offset: '0_1',
                  },
                ],
                nextOffset: '0_1',
                upToDate: true,
              };
            },
            async getStreamMeta() {
              return null;
            },
          },
        }) as never,
    });
    const t = await reader.readTranscript('thread-7');
    expect(readPath).toBe('agents/chat/thread-7');
    expect(t.events).toHaveLength(1);
  });
});
