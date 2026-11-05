import { describe, expect, it } from 'vitest';
import type { AgentSpec, SessionMessage } from '../types.js';
import { runAutoCompact } from './auto-compact.js';
import { createMemorySurfaceStore, type MemorySurfaceStore } from './surface-store.js';

const agent: AgentSpec = {
  id: 'a',
  name: 'A',
  role: 'assistant',
  instructions: '',
  capabilities: []
};

const ORIGINAL = 'UNIQUE_ORIGINAL_BODY_991';
const CAPPED = 'CAPPED_SUMMARY';

function seed(): { store: MemorySurfaceStore; sessionId: string } {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 't', mode: 'chat', agentId: agent.id });
  const lines: Array<[SessionMessage['role'], string]> = [
    ['user', ORIGINAL],
    ['assistant', 'done with the old turn'],
    ['user', 'latest question'],
    ['assistant', 'still here']
  ];
  for (const [role, text] of lines) {
    store.appendMessage(session.id, role, [{ type: 'text', text }]);
  }
  return { store, sessionId: session.id };
}

function replacementText(store: MemorySurfaceStore, sessionId: string): string {
  const hit = store.foldMessages(sessionId).find((message) => message.key === 'compact-summary');
  const part = hit?.parts.find((item) => item.type === 'text');
  return part && part.type === 'text' ? part.text : '';
}

describe('auto-compact archive pointer', () => {
  it('puts the archive path in the same summary [AC:compact-archive-pointer#AC-1]', async () => {
    const { store, sessionId } = seed();
    const session = store.getSession(sessionId)!;
    const path = '.agent-state/transcripts/s/1700000000000.jsonl';
    const order: string[] = [];
    const result = await runAutoCompact({
      store: {
        foldMessages: (id) => store.foldMessages(id),
        appendMessage: (id, role, parts) => store.appendMessage(id, role, parts),
        appendReplacement: (id, input) => {
          order.push('replace');
          return store.appendReplacement(id, input);
        },
        updateSession: (id, patch) => store.updateSession(id, patch)
      },
      session,
      agent,
      tokenThreshold: 1,
      force: true,
      keepRecent: 2,
      summarize: async () => 'RAW_SUMMARY',
      capSummary: () => CAPPED,
      archive: async (messages) => {
        order.push('archive');
        expect(messages.some((message) => message.parts.some((part) => part.type === 'text' && part.text === ORIGINAL))).toBe(true);
        return path;
      }
    });

    const saved = store.getSession(sessionId)?.summary ?? '';
    const visible = replacementText(store, sessionId);
    expect(order).toEqual(['archive', 'replace']);
    expect(result.didCompact).toBe(true);
    expect(result.summary).toBe(saved);
    expect(visible).toBe(saved);
    expect(saved.startsWith(`${CAPPED}\n\n`)).toBe(true);
    expect(saved).toContain(path);
    expect(saved).toContain('Compacted original transcript:');
    expect(saved).toContain('Read this file with read_file only when the summary is missing specific code or an error.');
    expect(saved).not.toContain(ORIGINAL);
    expect(saved).not.toContain('RAW_SUMMARY');
  });

  it('leaves the summary unchanged when archive returns no path [AC:compact-archive-pointer#AC-2]', async () => {
    for (const archive of [undefined, async () => undefined, async () => '   ']) {
      const { store, sessionId } = seed();
      const session = store.getSession(sessionId)!;
      const result = await runAutoCompact({
        store,
        session,
        agent,
        tokenThreshold: 1,
        force: true,
        keepRecent: 2,
        summarize: async () => CAPPED,
        ...(archive ? { archive } : {})
      });
      const saved = store.getSession(sessionId)?.summary ?? '';
      expect(result.summary).toBe(CAPPED);
      expect(saved).toBe(CAPPED);
      expect(replacementText(store, sessionId)).toBe(CAPPED);
      expect(saved).not.toContain('Compacted original transcript:');
      expect(saved).not.toContain('read_file');
    }
  });

  it('does not replace history when the summary is empty', async () => {
    const { store, sessionId } = seed();
    const before = store.foldMessages(sessionId);
    let archived = false;
    const result = await runAutoCompact({
      store,
      session: store.getSession(sessionId)!,
      agent,
      tokenThreshold: 1,
      force: true,
      keepRecent: 2,
      summarize: async () => '   ',
      archive: async () => {
        archived = true;
        return '.agent-state/transcripts/s/1.jsonl';
      }
    });
    expect(result.didCompact).toBe(false);
    expect(result.skippedReason).toBe('empty_summary');
    expect(archived).toBe(false);
    expect(store.foldMessages(sessionId)).toEqual(before);
    expect(store.getSession(sessionId)?.summary).toBeUndefined();
  });
});
