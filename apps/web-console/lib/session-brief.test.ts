import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySessionBrief,
  briefStreamSegments,
  parseSessionBrief,
  readSessionBrief,
  rowsForSessionBrief,
  SESSION_BRIEF_CHANGED_EVENT,
  SESSION_BRIEF_OPEN_KEY,
  SESSION_BRIEF_STORAGE_KEY,
  readBriefOpen,
  writeBriefOpen,
  visibleBriefParts,
  type BriefFeedRow,
  type BriefMessage,
  type BriefSlot
} from './session-brief.ts';

const DUMP = 'SECRET_DUMP_9f3a tool payload that should not be laid out';

const messages: BriefMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: '帮我查一下' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'tool_call', content: DUMP },
      { type: 'text', text: '查到了' }
    ]
  },
  { role: 'tool', parts: [{ type: 'tool_result', content: DUMP }] },
  { role: 'system', parts: [{ type: 'text', text: `system trace ${DUMP}` }] },
  {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: DUMP },
      { type: 'text', text: '结论在这里' }
    ]
  }
];

const fullSlots: BriefSlot[] = [
  { key: 'user', kind: 'message', messageIndex: 0 },
  { key: 'answer', kind: 'message', messageIndex: 1 },
  { key: 'tool', kind: 'message', messageIndex: 2 },
  { key: 'stats', kind: 'stats' },
  { key: 'system', kind: 'message', messageIndex: 3 },
  { key: 'child', kind: 'child-task', messageIndex: 1 },
  { key: 'conclusion', kind: 'message', messageIndex: 4 }
];
function rowKeys(rows: Array<BriefFeedRow<BriefSlot>>): string[] {
  return rows.map((row) => (row.type === 'slot' ? row.slot.key : row.key));
}

test('关掉后工具、推理、系统流水和统计仍各占一行 [AC:session-brief#AC-1] [AC:session-brief#AC-6]', () => {
  assert.equal(parseSessionBrief('0'), false);
  const rows = rowsForSessionBrief(false, fullSlots, messages);
  assert.deepEqual(rowKeys(rows), fullSlots.map((slot) => slot.key));
  assert.equal(rows.some((row) => row.type === 'note'), false);
  const tool = rows[2];
  const stats = rows[3];
  assert.equal(tool?.type === 'slot' && tool.slot.key, 'tool');
  assert.equal(stats?.type === 'slot' && stats.slot.kind, 'stats');
});

test('没保存过时默认只看关键信息 [AC:session-brief#AC-7]', () => {
  assert.equal(parseSessionBrief(null), true);
  assert.equal(parseSessionBrief(undefined), true);
  assert.equal(parseSessionBrief(''), true);
  assert.equal(parseSessionBrief('1'), true);
  const rows = rowsForSessionBrief(parseSessionBrief(null), fullSlots, messages);
  const shown = rows.flatMap((row) => (row.type === 'slot' ? [row.slot.key] : []));
  assert.deepEqual(shown, ['user', 'answer', 'conclusion']);
  assert.equal(rows.some((row) => row.type === 'note'), true);
});

test('打开后只留正文，过程不再铺开 [AC:session-brief#AC-2]', () => {
  const rows = rowsForSessionBrief(true, fullSlots, messages);
  const shown = rows.flatMap((row) => (row.type === 'slot' ? [row.slot.key] : []));
  assert.deepEqual(shown, ['user', 'answer', 'conclusion']);
  assert.equal(rows.some((row) => row.type === 'slot' && (row.slot.kind === 'stats' || row.slot.kind === 'child-task')), false);
  assert.equal(JSON.stringify(rows).includes(DUMP), false);
  assert.deepEqual(visibleBriefParts(messages[1]?.parts), [{ type: 'text', text: '查到了' }]);
  assert.deepEqual(visibleBriefParts(messages[4]?.parts), [{ type: 'text', text: '结论在这里' }]);
  assert.equal(visibleBriefParts(messages[2]?.parts).length, 0);
});

test('只有工具过程时收成一行，点开仍是这一段 [AC:session-brief#AC-3] [AC:session-brief#AC-8]', () => {
  const processMessages: BriefMessage[] = [
    { role: 'tool', parts: [{ type: 'tool_result', content: DUMP }] },
    { role: 'assistant', parts: [{ type: 'tool_call', content: DUMP }] },
    { role: 'assistant', parts: [{ type: 'reasoning', text: DUMP }] }
  ];
  const slots: BriefSlot[] = processMessages.map((_, index) => ({ key: `p${index}`, kind: 'message', messageIndex: index }));
  const rows = rowsForSessionBrief(true, slots, processMessages);
  assert.equal(rows.length, 1);
  const note = rows[0];
  assert.equal(note?.type, 'note');
  assert.equal(note?.type === 'note' && note.count, 3);
  assert.deepEqual(note?.type === 'note' ? note.slots.map((slot) => slot.key) : [], ['p0', 'p1', 'p2']);
  assert.equal(JSON.stringify(rows).includes(DUMP), false);
});

test('没处理的确认仍留在原处 [AC:session-brief#AC-4]', () => {
  const slots: BriefSlot[] = [
    { key: 'tool', kind: 'message', messageIndex: 2 },
    { key: 'ask', kind: 'approval' },
    { key: 'stats', kind: 'stats' }
  ];
  const rows = rowsForSessionBrief(true, slots, messages);
  assert.deepEqual(
    rows.map((row) => (row.type === 'note' ? `note:${row.count}` : row.slot.key)),
    ['note:1', 'ask', 'note:1']
  );
  const approval = rows[1];
  assert.equal(approval?.type === 'slot' && approval.slot.kind, 'approval');
});

test('选择记在浏览器里，展示不改写对话记录 [AC:session-brief#AC-5]', () => {
  const store = new Map<string, string>();
  const events: string[] = [];
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0
    },
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    }
  } as Window & typeof globalThis;
  try {
    const before = messages.map((message) => message.parts?.map((part) => part.content ?? part.text));
    assert.equal(applySessionBrief(true), true);
    assert.equal(store.get(SESSION_BRIEF_STORAGE_KEY), '1');
    assert.equal(readSessionBrief(), true);
    assert.equal(applySessionBrief(false), true);
    assert.equal(readSessionBrief(), false);
    rowsForSessionBrief(true, fullSlots, messages);
    visibleBriefParts(messages[1]?.parts);
    assert.deepEqual(
      messages.map((message) => message.parts?.map((part) => part.content ?? part.text)),
      before
    );
    assert.deepEqual(events, [SESSION_BRIEF_CHANGED_EVENT, SESSION_BRIEF_CHANGED_EVENT]);
  } finally {
    globalThis.window = previous;
  }
});

test('流式过程也收起，回答仍在 [AC:session-brief#AC-2]', () => {
  const onlyTools = briefStreamSegments([
    { kind: 'tool', args: DUMP },
    { kind: 'reasoning', text: DUMP }
  ]);
  assert.equal(onlyTools.segments.length, 0);
  assert.equal(onlyTools.hidden.length, 2);
  assert.equal(onlyTools.hidden[0]?.kind, 'tool');
  const mixed = briefStreamSegments([
    { kind: 'tool', args: DUMP },
    { kind: 'text', raw: '查到了' }
  ]);
  assert.deepEqual(mixed.segments, [{ kind: 'text', raw: '查到了' }]);
  assert.equal(mixed.hidden.length, 1);
  assert.equal(mixed.hidden[0]?.kind, 'tool');
});

test('刷新后已点开的过程仍展开，没点开的仍收起 [AC:session-brief#AC-9]', () => {
  const store = new Map<string, string>();
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0
    },
    dispatchEvent: () => true
  } as Window & typeof globalThis;
  try {
    assert.equal(readBriefOpen('brief:m:a'), false);
    assert.equal(writeBriefOpen('brief:m:a', true), true);
    assert.equal(readBriefOpen('brief:m:a'), true);
    assert.equal(readBriefOpen('brief:m:b'), false);
    assert.equal(writeBriefOpen('brief:m:a', false), true);
    assert.equal(readBriefOpen('brief:m:a'), false);
    assert.equal(store.has(SESSION_BRIEF_STORAGE_KEY), false);
    assert.equal(JSON.parse(store.get(SESSION_BRIEF_OPEN_KEY) ?? '[]').includes('SECRET_DUMP_9f3a'), false);
  } finally {
    globalThis.window = previous;
  }
});
