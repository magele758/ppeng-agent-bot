import { describe, it, expect, vi } from 'vitest';
import { applyClaimedInbox, claimAndApplyInbox } from './apply-claimed-inbox.js';
import type { ApplyClaimedInboxStore, ClaimedInboxItem } from './apply-claimed-inbox.js';
import type { MessagePart, MessageRole, SessionMessage } from '../types.js';

function fakeMessage(
  sessionId: string,
  role: MessageRole,
  parts: MessagePart[],
  opts?: { key?: string }
): SessionMessage {
  return {
    id: 'msg',
    sessionId,
    role,
    parts,
    createdAt: '2026-01-01T00:00:00.000Z',
    key: opts?.key
  };
}

function recordingStore(overrides: Partial<ApplyClaimedInboxStore> = {}): {
  store: ApplyClaimedInboxStore;
  hides: Array<{ sessionId: string; key: string; opts?: { expectedWriterRunId?: string } }>;
  appends: Array<{
    sessionId: string;
    role: MessageRole;
    parts: MessagePart[];
    opts?: { key?: string; expectedWriterRunId?: string };
  }>;
  claims: Array<{ sessionId: string; target: string }>;
} {
  const hides: Array<{ sessionId: string; key: string; opts?: { expectedWriterRunId?: string } }> = [];
  const appends: Array<{
    sessionId: string;
    role: MessageRole;
    parts: MessagePart[];
    opts?: { key?: string; expectedWriterRunId?: string };
  }> = [];
  const claims: Array<{ sessionId: string; target: string }> = [];

  const store: ApplyClaimedInboxStore = {
    hideByKey(sessionId, key, opts) {
      hides.push({ sessionId, key, opts });
      return 1;
    },
    appendMessage(sessionId, role, parts, opts) {
      appends.push({ sessionId, role, parts, opts });
      return fakeMessage(sessionId, role, parts, opts);
    },
    ...overrides
  };

  if (overrides.claimInbox) {
    const inner = overrides.claimInbox;
    store.claimInbox = (sessionId, target) => {
      claims.push({ sessionId, target });
      return inner(sessionId, target);
    };
  }

  return { store, hides, appends, claims };
}

const item = (partial: Partial<ClaimedInboxItem> & { text: string }): ClaimedInboxItem => ({
  role: 'user',
  ...partial
});

describe('applyClaimedInbox', () => {
  it('hides by key then appends role+text', () => {
    const { store, hides, appends } = recordingStore();
    applyClaimedInbox(store, 's1', [item({ key: 'steer:note', text: 'one' })]);

    expect(hides).toEqual([{ sessionId: 's1', key: 'steer:note', opts: undefined }]);
    expect(appends).toEqual([
      {
        sessionId: 's1',
        role: 'user',
        parts: [{ type: 'text', text: 'one' }],
        opts: { key: 'steer:note', expectedWriterRunId: undefined }
      }
    ]);
  });

  it('skips hide when item has no key', () => {
    const { store, hides, appends } = recordingStore();
    applyClaimedInbox(store, 's1', [item({ text: 'plain', role: 'system' })]);

    expect(hides).toEqual([]);
    expect(appends[0]).toMatchObject({
      role: 'system',
      parts: [{ type: 'text', text: 'plain' }],
      opts: { expectedWriterRunId: undefined }
    });
  });

  it('skips hide when hideByKey is missing', () => {
    const { store, hides, appends } = recordingStore({ hideByKey: undefined });
    applyClaimedInbox(store, 's1', [item({ key: 'k', text: 'later' })]);

    expect(hides).toEqual([]);
    expect(appends).toHaveLength(1);
    expect(appends[0]?.opts).toEqual({ key: 'k', expectedWriterRunId: undefined });
  });

  it('forwards expectedWriterRunId to hide and append', () => {
    const { store, hides, appends } = recordingStore();
    applyClaimedInbox(store, 's1', [item({ key: 'k', text: 'two' })], {
      expectedWriterRunId: 'run_a'
    });

    expect(hides[0]?.opts).toEqual({ expectedWriterRunId: 'run_a' });
    expect(appends[0]?.opts).toEqual({ key: 'k', expectedWriterRunId: 'run_a' });
  });

  it('applies items in order', () => {
    const { store, appends } = recordingStore();
    applyClaimedInbox(store, 's1', [
      item({ text: 'first' }),
      item({ text: 'second', role: 'system' })
    ]);
    expect(appends.map((a) => a.parts[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' }
    ]);
  });
});

describe('claimAndApplyInbox', () => {
  it('returns [] when claimInbox is missing', () => {
    const hideByKey = vi.fn();
    const appendMessage = vi.fn();
    const items = claimAndApplyInbox(
      { hideByKey, appendMessage },
      's1',
      'next-step'
    );
    expect(items).toEqual([]);
    expect(hideByKey).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('returns [] and does not append when claim is empty', () => {
    const { store, hides, appends, claims } = recordingStore({
      claimInbox: () => []
    });
    const items = claimAndApplyInbox(store, 's1', 'next-run', {
      expectedWriterRunId: 'run_b'
    });
    expect(items).toEqual([]);
    expect(claims).toEqual([{ sessionId: 's1', target: 'next-run' }]);
    expect(hides).toEqual([]);
    expect(appends).toEqual([]);
  });

  it('claims then applies each item', () => {
    const claimed: ClaimedInboxItem[] = [
      item({ key: 'k', text: 'claimed' }),
      item({ text: 'also', role: 'system' })
    ];
    const { store, hides, appends, claims } = recordingStore({
      claimInbox: () => claimed
    });
    const items = claimAndApplyInbox(store, 's1', 'next-step', {
      expectedWriterRunId: 'run_c'
    });
    expect(items).toBe(claimed);
    expect(claims).toEqual([{ sessionId: 's1', target: 'next-step' }]);
    expect(hides).toEqual([{ sessionId: 's1', key: 'k', opts: { expectedWriterRunId: 'run_c' } }]);
    expect(appends).toHaveLength(2);
    expect(appends[0]?.opts).toEqual({ key: 'k', expectedWriterRunId: 'run_c' });
    expect(appends[1]?.opts).toEqual({ expectedWriterRunId: 'run_c' });
  });
});

it('retains dragged context when an inbox message lands [AC:composer-drag-context#AC-3]', () => {
  const { store, appends } = recordingStore();
  const contextParts = [{ type: 'text' as const, text: 'fenced unique file sentence', contextSources: [{ kind: 'file' as const, name: 'note.txt', text: 'unique file sentence' }] }];
  applyClaimedInbox(store, 's1', [{ role: 'user', text: 'read it', contextParts }]);
  expect(appends[0]?.parts).toEqual([{ type: 'text', text: 'read it' }, ...contextParts]);
});

it('retains quote pointer while applying a claimed inbox message [AC:bot-reply-quote#AC-5]',()=>{
 const {store,appends}=recordingStore();const replyTo={messageId:'original',excerpt:'short'};
 applyClaimedInbox(store,'s1',[{role:'user',text:'quoted',replyTo}]);
 expect(appends[0]?.opts).toMatchObject({replyTo});
});
