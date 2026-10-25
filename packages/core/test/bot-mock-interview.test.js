import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { prepareGoalIntake } from '../dist/bots/goals/runtime-host.js';
import { requestHumanRun } from '../dist/session/human-continuation.js';
import { INTERVIEW_BOT_NAME, INTERVIEW_BOT_PERSONA } from '../dist/bots/bot-facade.js';

const BRIEF = '岗位：后端工程师。简历：做过订单服务，用过消息队列。考察范围：系统设计。请开始模拟面试。';
const ANSWER = '我把下单和扣库存拆成两个消息，先落订单再异步扣库存。';
const SCORE = '请结束面试并给出评分和改进建议。';

function runtime(t, turns) {
  const dir = mkdtempSync(join(tmpdir(), 'mock-interview-'));
  const queue = [...turns];
  const seen = [];
  const rt = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'mock-interview',
      async runTurn(input) {
        seen.push(input);
        const next = queue.shift();
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: next ?? '没有下一题。' }] };
      },
      async completeText() { return '{"intents":[]}'; },
      async summarizeMessages() { return ''; }
    }
  });
  t.after(async () => { await rt.destroy(); rmSync(dir, { recursive: true, force: true }); });
  return { rt, seen };
}

function interviewer(rt) {
  const bot = rt.listBots().find((item) => item.name === INTERVIEW_BOT_NAME);
  assert.ok(bot, 'roster includes 模拟面试官');
  const sessionId = rt.openBot(bot.id).sessionId;
  return { bot, sessionId };
}

test('the roster already has an interviewer that quizzes from the supplied brief without opening a goal [AC:bot-mock-interview#AC-1]', async (t) => {
  const { rt, seen } = runtime(t, ['请用一两句话讲讲订单服务里消息队列是怎么用的。']);
  const before = rt.listBots().filter((bot) => bot.name === INTERVIEW_BOT_NAME);
  assert.equal(before.length, 1);
  const { bot, sessionId } = interviewer(rt);
  rt.sendUserMessage(sessionId, BRIEF, { autoRun: true });
  await rt.runHumanSession(sessionId);
  const goals = new BotGoalService(rt.store, Date.now, sessionId).list(bot.id);
  assert.deepEqual(goals, []);
  const reply = rt.getLatestAssistantText(sessionId) ?? '';
  assert.match(reply, /消息队列|订单/);
  const prompt = `${seen.at(-1)?.systemPrompt ?? ''}\n${seen.at(-1)?.agent?.instructions ?? ''}`;
  assert.match(prompt, /一次只问一道题/);
  assert.match(prompt, /不要编造|没有依据/);
});

test('ending the interview returns a score and improvement advice grounded in the answers [AC:bot-mock-interview#AC-2]', async (t) => {
  const { rt, seen } = runtime(t, [
    '第一题：订单服务为什么用消息队列？',
    '收到。下一题先停在这里。',
    '评分：7/10。依据你刚才说的「先落订单再异步扣库存」。改进建议：补上扣库存失败后的补偿。'
  ]);
  const { sessionId } = interviewer(rt);
  rt.sendUserMessage(sessionId, BRIEF, { autoRun: true });
  await rt.runHumanSession(sessionId);
  rt.sendUserMessage(sessionId, ANSWER, { autoRun: true });
  await rt.runHumanSession(sessionId);
  rt.sendUserMessage(sessionId, SCORE, { autoRun: true });
  await rt.runHumanSession(sessionId);
  const reply = rt.getLatestAssistantText(sessionId) ?? '';
  assert.match(reply, /评分/);
  assert.match(reply, /改进建议/);
  assert.match(reply, /先落订单再异步扣库存/);
  const asked = seen.at(-1)?.messages?.some((message) =>
    message.role === 'user' && message.parts?.some((part) => part.type === 'text' && part.text?.includes(ANSWER))
  );
  assert.equal(asked, true);
});

test('a brief with no role, resume, or scope is not turned into invented questions [AC:bot-mock-interview#AC-3]', async (t) => {
  const { rt } = runtime(t, ['还不能出题。请先补充岗位、简历要点或考察范围。你没有提供过的经历我不会编。']);
  const { sessionId } = interviewer(rt);
  rt.sendUserMessage(sessionId, '开始模拟面试，随便出几道难题。', { autoRun: true });
  await rt.runHumanSession(sessionId);
  const reply = rt.getLatestAssistantText(sessionId) ?? '';
  assert.match(reply, /岗位|简历|考察范围/);
  assert.match(reply, /不会编|没有依据/);
  const agent = rt.listAgents().find((item) => item.name === INTERVIEW_BOT_NAME);
  assert.match(agent?.instructions ?? '', /没有依据/);
  assert.match(INTERVIEW_BOT_PERSONA, /一次只问一道题/);
});

test('reopening after another chat or a restart keeps the same interviewer and the earlier interview [AC:bot-mock-interview#AC-4]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-interview-restart-'));
  const adapter = {
    name: 'mock-interview-restart',
    async runTurn() { return { stopReason: 'end', assistantParts: [{ type: 'text', text: '第一题先问到这里。' }] }; },
    async completeText() { return '{"intents":[]}'; },
    async summarizeMessages() { return ''; }
  };
  const first = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: adapter });
  let id = '';
  let sessionId = '';
  try {
    const bot = first.listBots().find((item) => item.name === INTERVIEW_BOT_NAME);
    assert.ok(bot);
    id = bot.id;
    sessionId = first.openBot(id).sessionId;
    first.sendUserMessage(sessionId, BRIEF, { autoRun: true });
    await first.runHumanSession(sessionId);
    const other = first.createChatSession({ title: '另一场', agentId: 'general' });
    first.sendUserMessage(other.id, '这是另一场对话');
    assert.equal(first.listBots().filter((item) => item.name === INTERVIEW_BOT_NAME).length, 1);
  } finally {
    await first.destroy();
  }
  const second = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: adapter });
  t.after(async () => { await second.destroy(); rmSync(dir, { recursive: true, force: true }); });
  const again = second.listBots().filter((item) => item.name === INTERVIEW_BOT_NAME || item.name.startsWith(`${INTERVIEW_BOT_NAME}（内置）`));
  assert.equal(again.length, 1);
  assert.equal(again[0].id, id);
  const reopened = second.openBot(id).sessionId;
  assert.equal(reopened, sessionId);
  const transcript = second.store.foldMessages(reopened).map((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n');
  assert.match(transcript, /后端工程师/);
  assert.match(transcript, /第一题先问到这里/);
});

test('intake keeps an interview request in the current chat [AC:bot-mock-interview#AC-1]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-interview-intake-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({
    title: '面试',
    mode: 'chat',
    agentId: 'general',
    metadata: { botId: 'b', canonicalBotChat: true }
  });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: BRIEF }]);
  requestHumanRun(store, session.id);
  await prepareGoalIntake({ store, isRunning: () => false, cancel() {}, async run() {}, capabilities: () => ({ registeredTools: [], enabledStrategies: ['direct'] }) }, store.getSession(session.id));
  assert.deepEqual(new BotGoalService(store, Date.now, session.id).list('b'), []);
});
