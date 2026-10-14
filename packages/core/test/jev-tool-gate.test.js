import test from 'node:test';
import assert from 'node:assert/strict';
import { applyJevToolGate, settledToolGateDecision } from '../dist/jev/apply.js';
import { writeJevSettings } from '../dist/jev/settings.js';

const bash = { toolCallId: 'bash-1', name: 'bash', input: { command: 'ls' } };
const read = { toolCallId: 'read-1', name: 'read_file', input: { path: 'a' } };

function store() {
  const kv = new Map();
  const approvals = new Map();
  const messages = [];
  const api = {
    getDaemonControl(key) {
      return kv.get(key);
    },
    setDaemonControl(key, value) {
      kv.set(key, value);
    },
    appendMessage(_sessionId, _role, parts) {
      messages.push(...parts);
    },
    createApproval(input) {
      const row = { id: `ap-${approvals.size + 1}`, status: 'pending', ...input };
      approvals.set(row.id, row);
      return row;
    },
    getApproval(id) {
      return approvals.get(id);
    },
    messages,
    approvals
  };
  writeJevSettings(api, {
    baseUrl: 'http://jev.test',
    apiKey: 'k',
    profile: 'full'
  });
  return api;
}

function askFetch() {
  return async () => ({
    ok: true,
    async json() {
      return { answers: { gate: { choice: 'ask', confidence: 0.91 } } };
    }
  });
}

test('settled tool gate ask follows an existing decision', () => {
  const settled = [
    { sessionId: 's1', status: 'approved', toolName: 'bash', args: { command: 'ls' } },
    { sessionId: 's1', status: 'rejected', toolName: 'bash', args: { command: 'rm' } },
    { sessionId: 's1', status: 'pending', toolName: 'bash', args: { command: 'pwd' } },
    { sessionId: 'other', status: 'approved', toolName: 'bash', args: { command: 'ls' } }
  ];
  assert.equal(settledToolGateDecision(bash, 's1', settled), 'proceed');
  assert.equal(
    settledToolGateDecision({ ...bash, input: { command: 'rm' } }, 's1', settled),
    'reject'
  );
  assert.equal(
    settledToolGateDecision({ ...bash, input: { command: 'pwd' } }, 's1', settled),
    'waiting'
  );
  assert.equal(
    settledToolGateDecision({ ...bash, input: { command: 'whoami' } }, 's1', settled),
    'create'
  );
  assert.equal(settledToolGateDecision(bash, 's2', settled), 'create');
  assert.equal(
    settledToolGateDecision(bash, 's1', [
      { sessionId: 's1', status: 'expired', toolName: 'bash', args: { command: 'ls' } }
    ]),
    'create'
  );
});

test('toolGate ask creates one approval when the wave has no settled decision', async () => {
  const saved = store();
  const original = globalThis.fetch;
  globalThis.fetch = askFetch();
  try {
    const decision = await applyJevToolGate(saved, 's1', [bash, read]);
    assert.equal(decision, 'waiting');
    assert.equal(saved.approvals.size, 1);
    const created = [...saved.approvals.values()][0];
    assert.equal(created.toolName, 'bash');
    assert.equal(saved.messages.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('toolGate ask on resume reuses an approved review', async () => {
  const saved = store();
  saved.approvals.set('ap-ok', {
    id: 'ap-ok',
    sessionId: 's1',
    status: 'approved',
    toolName: 'bash',
    args: { command: 'ls' }
  });
  const original = globalThis.fetch;
  globalThis.fetch = askFetch();
  try {
    const decision = await applyJevToolGate(saved, 's1', [bash, read], {
      settledApprovalIds: ['ap-ok']
    });
    assert.equal(decision, 'proceed');
    assert.equal(saved.approvals.size, 1);
    assert.equal(saved.messages.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('toolGate ask on resume records one rejection and leaves siblings open', async () => {
  const saved = store();
  saved.approvals.set('ap-no', {
    id: 'ap-no',
    sessionId: 's1',
    status: 'rejected',
    toolName: 'bash',
    args: { command: 'ls' }
  });
  const closed = [];
  const original = globalThis.fetch;
  globalThis.fetch = askFetch();
  try {
    const decision = await applyJevToolGate(saved, 's1', [bash, read], {
      settledApprovalIds: ['ap-no'],
      markClosed(ids) {
        closed.push(...ids);
      }
    });
    assert.equal(decision, 'proceed');
    assert.equal(saved.approvals.size, 1);
    assert.deepEqual(closed, ['bash-1']);
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0].toolCallId, 'bash-1');
    assert.equal(saved.messages[0].ok, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('toolGate ask on resume waits on a still-pending review without creating another', async () => {
  const saved = store();
  saved.approvals.set('ap-wait', {
    id: 'ap-wait',
    sessionId: 's1',
    status: 'pending',
    toolName: 'bash',
    args: { command: 'ls' }
  });
  const original = globalThis.fetch;
  globalThis.fetch = askFetch();
  try {
    const decision = await applyJevToolGate(saved, 's1', [bash], {
      settledApprovalIds: ['ap-wait']
    });
    assert.equal(decision, 'waiting');
    assert.equal(saved.approvals.size, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('toolGate deny still closes the whole wave', async () => {
  const saved = store();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { answers: { gate: { choice: 'deny', confidence: 0.95 } } };
    }
  });
  try {
    const decision = await applyJevToolGate(saved, 's1', [bash, read]);
    assert.equal(decision, 'skip');
    assert.equal(saved.approvals.size, 0);
    assert.equal(saved.messages.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('toolGate ignores a low-confidence ask and calls that are not risky', async () => {
  const saved = store();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { answers: { gate: { choice: 'ask', confidence: 0.2 } } };
    }
  });
  try {
    assert.equal(await applyJevToolGate(saved, 's1', [read]), 'proceed');
    assert.equal(await applyJevToolGate(saved, 's1', [bash]), 'proceed');
    assert.equal(saved.approvals.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('toolGate ask does not write a second result for a call the gate already closed', async () => {
  const saved = store();
  saved.approvals.set('ap-no', {
    id: 'ap-no',
    sessionId: 's1',
    status: 'rejected',
    toolName: 'bash',
    args: { command: 'ls' }
  });
  const original = globalThis.fetch;
  globalThis.fetch = askFetch();
  try {
    const decision = await applyJevToolGate(saved, 's1', [bash], {
      settledApprovalIds: ['ap-no'],
      alreadyClosedIds: ['bash-1']
    });
    assert.equal(decision, 'proceed');
    assert.equal(saved.messages.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
