import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { SUBAGENT_DENIED_TOOLS } from '../dist/runtime/subagent-policy.js';
import { decideSteerAdmission } from '../dist/session/steer-ack.js';
import { settleRuns } from './helpers/settle.js';

/** Tools a delegated child must not receive. */
const DENIED = [
  'memory_set',
  'memory_delete',
  'handoff_state',
  'save_user_info',
  'send_message',
  'message_agent',
  'cron_create',
  'ask_user'
];

class ScriptedAdapter {
  constructor(handler) {
    this.name = 'scripted';
    this.handler = handler;
  }
  async runTurn(input) {
    return this.handler(input);
  }
  async summarizeMessages() {
    return 'summary';
  }
}

function runtimeWith(adapter) {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'sub-deleg-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'sub-deleg-state-')),
    modelAdapter: adapter
  });
}

function toolStub(name) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    async execute() {
      return { ok: true, content: name };
    }
  };
}

function agentStub() {
  return { id: 'general', name: 'General', role: 'general', instructions: '', capabilities: [] };
}

function namesOf(tools) {
  return tools.map((tool) => tool.name);
}

test('delegated child starts without the parent transcript and returns a summary only [AC:subagent-delegation#AC-1]', async () => {
  const box = { parentId: '' };
  const childViews = [];
  const runtime = runtimeWith(
    new ScriptedAdapter((input) => {
      if (input.sessionId !== box.parentId) {
        childViews.push({
          tools: namesOf(input.tools ?? []),
          text: JSON.stringify(input.messages)
        });
        const sawTool = input.messages.some((message) =>
          message.parts.some((part) => part.type === 'tool_result')
        );
        if (!sawTool) {
          return {
            stopReason: 'tool_use',
            assistantParts: [
              {
                type: 'tool_call',
                toolCallId: 'child-read',
                name: 'read_file',
                input: { path: 'child-trace.txt' }
              }
            ]
          };
        }
        return {
          stopReason: 'end',
          assistantParts: [{ type: 'text', text: 'child-final-summary' }]
        };
      }
      const spawned = input.messages.some((message) =>
        message.parts.some((part) => part.type === 'tool_result' && part.name === 'spawn_subagent')
      );
      if (!spawned) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'spawn-1',
              name: 'spawn_subagent',
              input: {
                prompt: 'delegated task only',
                allowed_tools: ['read_file', 'memory_get', ...DENIED]
              }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent done' }] };
    })
  );
  writeFileSync(join(runtime.repoRoot, 'child-trace.txt'), 'CHILD_TRACE_SECRET');
  const session = runtime.createChatSession({
    title: 'parent',
    message: 'PARENT_ONLY_SECRET please delegate this'
  });
  box.parentId = session.id;
  await runtime.runSession(session.id);

  assert.ok(childViews.length > 0, 'child ran');
  for (const view of childViews) {
    assert.equal(view.text.includes('PARENT_ONLY_SECRET'), false);
    assert.match(view.text, /delegated task only/);
  }
  const child = runtime.listSessions().find((item) => item.mode === 'subagent' && item.parentSessionId === session.id);
  assert.ok(child);
  const childTranscript = JSON.stringify(runtime.getSessionMessages(child.id));
  assert.equal(childTranscript.includes('PARENT_ONLY_SECRET'), false);
  assert.match(childTranscript, /delegated task only/);
  assert.match(childTranscript, /CHILD_TRACE_SECRET/);

  const parentResult = runtime
    .getSessionMessages(session.id)
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool_result' && part.name === 'spawn_subagent');
  assert.ok(parentResult);
  assert.match(parentResult.content, /child-final-summary/);
  assert.equal(parentResult.content.includes('CHILD_TRACE_SECRET'), false);
  assert.equal(parentResult.content.includes('PARENT_ONLY_SECRET'), false);
  await runtime.destroy();
});

test('delegated child is not given memory writes, outbound IM, cron create, or clarify [AC:subagent-delegation#AC-2]', async () => {
  const box = { parentId: '' };
  const childToolLists = [];
  const runtime = runtimeWith(
    new ScriptedAdapter((input) => {
      if (input.sessionId !== box.parentId) {
        childToolLists.push(namesOf(input.tools ?? []));
        const sawTool = input.messages.some((message) =>
          message.parts.some((part) => part.type === 'tool_result')
        );
        if (!sawTool) {
          return {
            stopReason: 'tool_use',
            assistantParts: DENIED.map((name, index) => ({
              type: 'tool_call',
              toolCallId: `deny-${index}`,
              name,
              input:
                name === 'memory_set' || name === 'handoff_state'
                  ? { scope: 'scratch', key: 'leaked', value: 'should-not-stick', notes: 'should-not-stick' }
                  : name === 'send_message' || name === 'message_agent'
                    ? { toAgentId: 'other', target: 'other', content: 'outbound', body: 'outbound' }
                    : name === 'cron_create'
                      ? { name: 'sneaky', prompt: 'run', every_ms: 60000 }
                      : name === 'ask_user'
                        ? { question: 'which one?' }
                        : name === 'save_user_info'
                          ? { category: 'fact', content: 'secret fact' }
                          : { key: 'leaked' }
            }))
          };
        }
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'child-final-summary' }] };
      }
      const spawned = input.messages.some((message) =>
        message.parts.some((part) => part.type === 'tool_result' && part.name === 'spawn_subagent')
      );
      if (!spawned) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'spawn-1',
              name: 'spawn_subagent',
              input: {
                prompt: 'delegated task only',
                allowed_tools: ['read_file', 'memory_get', ...DENIED]
              }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent done' }] };
    })
  );
  const session = runtime.createChatSession({ title: 'parent', message: 'go' });
  box.parentId = session.id;
  await runtime.runSession(session.id);

  assert.ok(childToolLists.length > 0);
  for (const names of childToolLists) {
    for (const denied of DENIED) assert.equal(names.includes(denied), false, denied);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('memory_get'));
  }
  const child = runtime.listSessions().find((item) => item.mode === 'subagent' && item.parentSessionId === session.id);
  assert.ok(child);
  assert.equal(
    runtime.store.listSessionMemory(child.id, 'scratch').some((row) => row.key === 'leaked'),
    false
  );
  assert.equal(runtime.store.listMailbox('other', false).length, 0);
  assert.equal(
    runtime.store.listApprovals({ status: 'pending' }).some((approval) => approval.sessionId === child.id),
    false
  );
  assert.notEqual(child.status, 'waiting_approval');
  await runtime.destroy();
});

test('bot and plain parents keep their tools; a child loses the denylist even on an explicit allowlist [AC:subagent-delegation#AC-2]', () => {
  const catalog = ['read_file', 'memory_get', 'bash', ...DENIED].map(toolStub);
  const env = { RAW_AGENT_OPTIONAL_TOOL_GROUPS: '0', RAW_AGENT_CRON_TOOLS: '0' };
  const parent = filterToolsForSession({
    env,
    tools: catalog,
    agent: agentStub(),
    session: {
      id: 'parent',
      mode: 'chat',
      agentId: 'general',
      metadata: { canonicalBotChat: true, botId: 'bot-1' }
    }
  });
  for (const denied of DENIED) assert.ok(namesOf(parent.tools).includes(denied), denied);

  const plainChild = filterToolsForSession({
    env,
    tools: catalog,
    agent: agentStub(),
    session: {
      id: 'child',
      mode: 'subagent',
      agentId: 'general',
      metadata: { allowedTools: ['read_file', 'memory_get', ...DENIED] }
    }
  });
  const plainNames = namesOf(plainChild.tools);
  for (const denied of DENIED) assert.equal(plainNames.includes(denied), false, denied);
  assert.ok(plainNames.includes('read_file'));
  assert.ok(plainNames.includes('memory_get'));
  assert.equal(plainNames.includes('bash'), false);

  const botChild = filterToolsForSession({
    env,
    tools: catalog,
    agent: agentStub(),
    session: {
      id: 'bot-child',
      mode: 'subagent',
      agentId: 'general',
      metadata: {
        botId: 'bot-1',
        canonicalBotChat: true,
        allowedTools: ['read_file', 'memory_get', ...DENIED],
        taskRunMode: 'planner',
        taskRunModeBound: true
      }
    }
  });
  const botNames = namesOf(botChild.tools);
  for (const denied of DENIED) assert.equal(botNames.includes(denied), false, denied);
  assert.ok(botNames.includes('read_file') || botNames.includes('memory_get'));
  assert.deepEqual([...SUBAGENT_DENIED_TOOLS], DENIED);
});

test('restart marks an in-flight subagent unknown and does not replay it as success [AC:subagent-delegation#AC-3]', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sub-restart-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'sub-restart-state-'));
  const first = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'unused' }]
    }))
  });
  const parent = first.createChatSession({ title: 'parent', message: 'hi' });
  const runningChild = first.store.createSession({
    title: 'in flight',
    mode: 'subagent',
    agentId: 'general',
    parentSessionId: parent.id
  });
  first.store.updateSession(runningChild.id, { status: 'running' });
  const finishedChild = first.store.createSession({
    title: 'finished',
    mode: 'subagent',
    agentId: 'general',
    parentSessionId: parent.id
  });
  const runningChat = first.createChatSession({ title: 'chat', message: 'still going' });
  first.store.updateSession(runningChat.id, { status: 'running' });
  await first.destroy();

  let calls = 0;
  const second = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: new ScriptedAdapter(() => {
      calls += 1;
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'replayed-as-success' }] };
    })
  });
  const unknown = second.getSession(runningChild.id);
  assert.equal(unknown?.status, 'unknown');
  assert.notEqual(unknown?.status, 'completed');
  assert.notEqual(unknown?.status, 'idle');
  assert.equal(second.getSession(finishedChild.id)?.status, 'idle');
  assert.equal(second.getSession(runningChat.id)?.status, 'running');

  const replayed = await second.runSession(runningChild.id);
  assert.equal(replayed.status, 'unknown');
  assert.equal(calls, 0);
  const transcript = JSON.stringify(second.getSessionMessages(runningChild.id));
  assert.equal(transcript.includes('replayed-as-success'), false);
  assert.deepEqual(
    decideSteerAdmission({ text: 'keep going', session: replayed }),
    { admit: false, reason: 'session_ended' }
  );
  await second.destroy();
});

test('steering a subagent also starts clean and without the denied tools [AC:subagent-delegation#AC-1] [AC:subagent-delegation#AC-2]', async () => {
  const box = { parentId: '' };
  const childViews = [];
  const runtime = runtimeWith(
    new ScriptedAdapter((input) => {
      if (input.sessionId === box.parentId) {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent idle' }] };
      }
      childViews.push({
        tools: namesOf(input.tools ?? []),
        text: JSON.stringify(input.messages)
      });
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'steer-summary' }] };
    })
  );
  const session = runtime.createChatSession({
    title: 'parent',
    message: 'PARENT_ONLY_SECRET earlier turn'
  });
  box.parentId = session.id;
  runtime.enqueueSteer(session.id, 'steer delegated task', { steerMode: 'subagent' });
  await settleRuns(runtime);
  assert.ok(childViews.length > 0);
  for (const view of childViews) {
    assert.equal(view.text.includes('PARENT_ONLY_SECRET'), false);
    assert.match(view.text, /steer delegated task/);
    for (const denied of DENIED) assert.equal(view.tools.includes(denied), false, denied);
    assert.ok(view.tools.includes('memory_get'));
  }
  await runtime.destroy();
});
