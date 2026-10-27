import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HeuristicModelAdapter, RawAgentRuntime, type ModelAdapter } from '@ppeng/agent-core';
import { composerHintHttpResult } from '../src/composer-hint.ts';

function text(value: string) {
  return [{ type: 'text' as const, text: value }];
}

async function withRuntime(adapter: ModelAdapter, run: (runtime: RawAgentRuntime) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'composer-hint-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: adapter,
  });
  try {
    await run(runtime);
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed(runtime: RawAgentRuntime, name: string, user: string, assistant: string) {
  const bot = runtime.createBot({ name });
  runtime.store.appendMessage(bot.canonicalSessionId, 'user', text(user));
  runtime.store.appendMessage(bot.canonicalSessionId, 'assistant', text(assistant));
  return bot.canonicalSessionId;
}

function scriptedAdapter(
  replyFor: (user: string) => string,
  seen?: { jsonMode?: boolean }
): ModelAdapter {
  return {
    name: 'scripted-hint',
    async runTurn() {
      return { stopReason: 'end', assistantParts: [] };
    },
    async summarizeMessages() {
      return '';
    },
    async completeText(input) {
      if (seen) seen.jsonMode = input.jsonMode;
      return replyFor(input.user);
    },
  };
}

function modelReply(user: string): string {
  if (user.includes('紫藤花蜜')) return '再核对紫藤花蜜放在阴凉处能不能久放，并记下保存时间';
  if (user.includes('玄武湖')) return '继续查玄武湖堤从城北怎么走';
  if (user.includes('超时')) return '把超时改成30秒再验一次';
  return '';
}

test('Bot 主对话在助手回复完成后返回一句建议，且不写进会话 [AC:bot-composer-next-hint#AC-1]', async () => {
  await withRuntime(scriptedAdapter(modelReply), async (runtime) => {
    const sessionId = seed(runtime, '花蜜', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const before = runtime.store.listMessages(sessionId).length;
    const result = await composerHintHttpResult(runtime, { sessionId });
    assert.equal(result.status, 200);
    assert.equal(typeof result.body.hint, 'string');
    assert.ok(result.body.hint.length >= 2);
    assert.equal(result.body.hint.includes('\n'), false);
    assert.equal(runtime.store.listMessages(sessionId).length, before);
    const route = readFileSync(new URL('../src/routes/composer-hint.ts', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    assert.match(route, /\/api\/lab\/composer-hint/);
    assert.match(route, /composerHintHttpResult/);
    assert.match(app, /composerHintRoutes\(runtime\)/);
  });
});

test('建议来自这场已落库对话，不同对话不同，半句草稿不会混进去 [AC:bot-composer-next-hint#AC-2]', async () => {
  await withRuntime(scriptedAdapter(modelReply), async (runtime) => {
    const wisteria = seed(runtime, '紫藤', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const lake = seed(runtime, '玄武', '玄武湖怎么走', '玄武湖堤在城北');
    const first = await composerHintHttpResult(runtime, { sessionId: wisteria, draft: '半句紫藤未落库' });
    const second = await composerHintHttpResult(runtime, { sessionId: lake });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.hint, modelReply('紫藤花蜜'));
    assert.equal(second.body.hint, modelReply('玄武湖'));
    assert.notEqual(first.body.hint, second.body.hint);
    assert.equal(first.body.hint.includes('heuristic'), false);
    assert.equal(first.body.hint.includes('{'), false);
    assert.equal(first.body.hint.includes('半句紫藤未落库'), false);
    assert.equal(second.body.hint.includes('半句紫藤未落库'), false);
  });
});

test('已在回复或还没有助手回复时建议为空 [AC:bot-composer-next-hint#AC-5]', async () => {
  await withRuntime(new HeuristicModelAdapter(), async (runtime) => {
    const quiet = runtime.createBot({ name: '还没回' });
    runtime.store.appendMessage(quiet.canonicalSessionId, 'user', text('还没有任何助手回复'));
    const unanswered = await composerHintHttpResult(runtime, { sessionId: quiet.canonicalSessionId });
    assert.equal(unanswered.body.hint, '');
    const live = seed(runtime, '正在回', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    runtime.store.updateSession(live, { status: 'running' });
    const running = await composerHintHttpResult(runtime, { sessionId: live });
    assert.equal(running.status, 200);
    assert.equal(running.body.hint, '');
    runtime.store.updateSession(live, { status: 'waiting_approval' });
    const waiting = await composerHintHttpResult(runtime, { sessionId: live });
    assert.equal(waiting.body.hint, '');
  });
});

test('普通聊天、子任务和房间返回空建议 [AC:bot-composer-next-hint#AC-6]', async () => {
  await withRuntime(new HeuristicModelAdapter(), async (runtime) => {
    const bot = runtime.createBot({ name: '主对话' });
    const chat = runtime.createChatSession({ title: '普通聊天', agentId: 'general' });
    runtime.store.appendMessage(chat.id, 'user', text('普通聊天里提到桂花'));
    runtime.store.appendMessage(chat.id, 'assistant', text('桂花在窗台'));
    const child = runtime.store.createSession({
      title: '子任务',
      mode: 'subagent',
      agentId: bot.id,
      parentSessionId: bot.canonicalSessionId,
      metadata: { botId: bot.id },
    });
    runtime.store.appendMessage(child.id, 'user', text('子任务里提到石榴'));
    runtime.store.appendMessage(child.id, 'assistant', text('石榴在冷藏'));
    const room = runtime.store.createSession({
      title: '房间',
      mode: 'chat',
      agentId: bot.id,
      metadata: { roomId: 'room-1', botId: bot.id, canonicalBotChat: true },
    });
    runtime.store.appendMessage(room.id, 'user', text('房间里提到荷花'));
    runtime.store.appendMessage(room.id, 'assistant', text('荷花在湖心'));
    assert.equal((await composerHintHttpResult(runtime, { sessionId: chat.id })).body.hint, '');
    assert.equal((await composerHintHttpResult(runtime, { sessionId: child.id })).body.hint, '');
    assert.equal((await composerHintHttpResult(runtime, { sessionId: room.id })).body.hint, '');
  });
});

test('建议超时后模型再失败也不会留下未处理的拒绝 [AC:bot-composer-next-hint#AC-7]', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    await withRuntime(
      {
        name: 'late-hint-failure',
        async runTurn() {
          return { stopReason: 'end', assistantParts: [] };
        },
        async summarizeMessages() {
          return '';
        },
        async completeText(input) {
          await new Promise((resolve) => setTimeout(resolve, 4500));
          if (input.signal?.aborted) throw new Error('late abort');
          return '再核对紫藤花蜜放在阴凉处';
        },
      },
      async (runtime) => {
        const sessionId = seed(runtime, '超时失败', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
        const result = await composerHintHttpResult(runtime, { sessionId });
        assert.equal(result.status, 200);
        assert.equal(result.body.hint, '');
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('模型失败或没有合适的一句时返回空建议且不是 500 [AC:bot-composer-next-hint#AC-7]', async () => {
  const throwing: ModelAdapter = {
    name: 'boom',
    async runTurn() {
      return { stopReason: 'end', assistantParts: [] };
    },
    async summarizeMessages() {
      return '';
    },
    async completeText() {
      throw new Error('upstream exploded 半截');
    },
  };
  await withRuntime(throwing, async (runtime) => {
    const sessionId = seed(runtime, '失败', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const failed = await composerHintHttpResult(runtime, { sessionId });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.hint, '');
    assert.equal(JSON.stringify(failed).includes('半截'), false);
    assert.equal(JSON.stringify(failed).includes('exploded'), false);
  });
  await withRuntime(new HeuristicModelAdapter(), async (runtime) => {
    const bot = runtime.createBot({ name: '太短' });
    runtime.store.appendMessage(bot.canonicalSessionId, 'user', text('嗯'));
    runtime.store.appendMessage(bot.canonicalSessionId, 'assistant', text('。'));
    const empty = await composerHintHttpResult(runtime, { sessionId: bot.canonicalSessionId });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.hint, '');
    const missing = await composerHintHttpResult(runtime, { sessionId: 'missing' });
    const blank = await composerHintHttpResult(runtime, {});
    const junk = await composerHintHttpResult(runtime, null);
    assert.equal(missing.status, 200);
    assert.equal(missing.body.hint, '');
    assert.equal(blank.body.hint, '');
    assert.equal(junk.body.hint, '');
    const broken = {
      getSession() {
        throw new Error('db down 半截');
      },
    } as unknown as RawAgentRuntime;
    const crashed = await composerHintHttpResult(broken, { sessionId: 'x' });
    assert.equal(crashed.status, 200);
    assert.equal(crashed.body.hint, '');
    assert.equal(JSON.stringify(crashed).includes('半截'), false);
  });
});

function stubAdapter(reply: string): ModelAdapter {
  return {
    name: 'stub-hint',
    async runTurn() {
      return { stopReason: 'end', assistantParts: [] };
    },
    async summarizeMessages() {
      return '';
    },
    async completeText() {
      return reply;
    },
  };
}

function assertNextAction(hint: string, things: string[], assistant: string) {
  assert.equal(hint.includes('\n'), false);
  assert.ok(Array.from(hint).length >= 2 && Array.from(hint).length <= 500);
  for (const thing of things) assert.equal(hint.includes(thing), true, hint);
  assert.notEqual(hint, `那${assistant}呢`);
  assert.doesNotMatch(hint, /^那.+呢[？?]?$/);
  assert.doesNotMatch(hint, /^(继续|好的|好|嗯+|然后呢|接下来呢)[。！？!?]?$/);
  assert.equal(hint.includes(assistant), false, hint);
  assert.notEqual(hint.replace(/[？?呢吗]/g, ''), assistant);
  assert.match(hint, /查|核对|验证|确认|改/);
  assert.equal(/[？?吗呢]$/.test(hint), false, hint);
}

test('建议是带具体事物的下一步行动，不是把助手上一句改成那…呢 [AC:bot-composer-next-hint#AC-9]', async () => {
  await withRuntime(scriptedAdapter(modelReply), async (runtime) => {
    const honey = seed(runtime, '花蜜下一步', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const honeyHint = (await composerHintHttpResult(runtime, { sessionId: honey })).body.hint;
    assert.equal(honeyHint, modelReply('紫藤花蜜'));
    assertNextAction(honeyHint, ['紫藤花蜜', '阴凉处'], '紫藤花蜜要放在阴凉处');
    assert.match(honeyHint, /核对|验证|确认/);

    const lake = seed(runtime, '路线下一步', '玄武湖怎么走', '玄武湖堤在城北');
    const lakeHint = (await composerHintHttpResult(runtime, { sessionId: lake })).body.hint;
    assert.equal(lakeHint, modelReply('玄武湖'));
    assertNextAction(lakeHint, ['玄武湖堤', '城北'], '玄武湖堤在城北');
    assert.match(lakeHint, /查/);
    assert.notEqual(honeyHint, lakeHint);

    const edited = seed(runtime, '超时下一步', '超时写成了10秒，帮我改', '超时可以改成30秒');
    const editedHint = (await composerHintHttpResult(runtime, { sessionId: edited })).body.hint;
    assert.equal(editedHint, modelReply('超时'));
    assertNextAction(editedHint, ['超时', '30秒'], '超时可以改成30秒');
    assert.match(editedHint, /改/);
  });

  await withRuntime(stubAdapter('那紫藤花蜜要放在阴凉处呢'), async (runtime) => {
    const sessionId = seed(runtime, '改写问句', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, '');
  });

  await withRuntime(stubAdapter('紫藤花蜜要放在阴凉处吗'), async (runtime) => {
    const sessionId = seed(runtime, '缩成问句', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, '');
  });

  await withRuntime(stubAdapter('再核对紫藤花蜜放在阴凉处能不能久放'), async (runtime) => {
    const sessionId = seed(runtime, '沿用好建议', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, '再核对紫藤花蜜放在阴凉处能不能久放');
  });
});

test('对话里没有可执行的下一步时建议为空 [AC:bot-composer-next-hint#AC-10]', async () => {
  await withRuntime(new HeuristicModelAdapter(), async (runtime) => {
    const hello = seed(runtime, '只打招呼', '你好', '你好，有什么可以帮你');
    assert.equal((await composerHintHttpResult(runtime, { sessionId: hello })).body.hint, '');
    const ack = seed(runtime, '只应声', '好的', '好的');
    assert.equal((await composerHintHttpResult(runtime, { sessionId: ack })).body.hint, '');
    const chat = seed(runtime, '只闲聊', '今天天气不错', '是啊，阳光明媚');
    assert.equal((await composerHintHttpResult(runtime, { sessionId: chat })).body.hint, '');
  });

  await withRuntime(stubAdapter('那好的呢'), async (runtime) => {
    const sessionId = seed(runtime, '应声硬编', '好的', '好的');
    assert.equal((await composerHintHttpResult(runtime, { sessionId })).body.hint, '');
  });
});

test('行动指南显示模型正文，超过 80 字也保留，到 500 字为止 [AC:bot-composer-next-hint#AC-11]', async () => {
  const long = `再核对紫藤花蜜放在阴凉处的保存时间，并对照上次实测。${'记下温度和密封情况。'.repeat(8)}`;
  assert.ok(Array.from(long).length > 80 && Array.from(long).length <= 500);
  const seen: { jsonMode?: boolean } = {};
  await withRuntime(scriptedAdapter(() => long, seen), async (runtime) => {
    const sessionId = seed(runtime, '长指南', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, long);
    assert.equal(seen.jsonMode, false);
  });

  const huge = `核对紫藤花蜜。${'再记一笔保存情况。'.repeat(60)}`;
  assert.ok(Array.from(huge).length > 500);
  await withRuntime(scriptedAdapter(() => huge), async (runtime) => {
    const sessionId = seed(runtime, '超长指南', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, Array.from(huge).slice(0, 500).join(''));
    assert.equal(Array.from(hint).length, 500);
  });

  await withRuntime(scriptedAdapter(() => '再核对紫藤花蜜\n放在阴凉处的保存时间'), async (runtime) => {
    const sessionId = seed(runtime, '换行指南', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, '再核对紫藤花蜜 放在阴凉处的保存时间');
  });

  await withRuntime(new HeuristicModelAdapter(), async (runtime) => {
    const sessionId = seed(runtime, '无模型套话', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, '');
  });

  await withRuntime(
    scriptedAdapter(() => JSON.stringify({ hint: '再核对紫藤花蜜放在阴凉处的保存时间' })),
    async (runtime) => {
      const sessionId = seed(runtime, '模型JSON', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
      const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
      assert.equal(hint, '再核对紫藤花蜜放在阴凉处的保存时间');
    }
  );

  const written = '请把紫藤花蜜的开封日期写在瓶身';
  await withRuntime(scriptedAdapter(() => written), async (runtime) => {
    const sessionId = seed(runtime, '原句', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, written);
  });

  const casual = '把明天的伞放在门口';
  await withRuntime(scriptedAdapter(() => casual), async (runtime) => {
    const sessionId = seed(runtime, '闲聊原句', '今天天气不错', '是啊，阳光明媚');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(hint, casual);
  });

  const source = readFileSync(new URL('../src/composer-hint.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('那${'), false);
  assert.equal(source.includes('再核对'), false);
  assert.equal(source.includes('继续查'), false);
  assert.equal(source.includes('FUNCTION_WORDS'), false);
  assert.equal(source.includes('fallbackComposerHint'), false);
  assert.equal(source.includes('nextActionFromTurn'), false);
});

test('调用建议接口不会把建议写成用户消息 [AC:bot-composer-next-hint#AC-8]', async () => {
  await withRuntime(scriptedAdapter(modelReply), async (runtime) => {
    const sessionId = seed(runtime, '不发送', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const result = await composerHintHttpResult(runtime, { sessionId });
    assert.equal(result.status, 200);
    assert.ok(result.body.hint.includes('紫藤花蜜'));
    const roles = runtime.store.listMessages(sessionId).map((message) => message.role);
    assert.deepEqual(roles, ['user', 'assistant']);
    const userText = runtime.store.listMessages(sessionId)[0]?.parts.find((part) => part.type === 'text');
    assert.equal(userText && userText.type === 'text' ? userText.text : '', '我想做紫藤花蜜');
    assert.notEqual(userText && userText.type === 'text' ? userText.text : '', result.body.hint);
  });
});

test('回顾写成后建议接着回顾里的具体事情，且不写进会话 [AC:recap-next-action#AC-1] [AC:recap-next-action#AC-2] [AC:recap-next-action#AC-3]', async () => {
  let seen = '';
  await withRuntime(scriptedAdapter((user) => {
    seen = user;
    return user.includes('瓶身日期') ? '把紫藤花蜜的开封日期写在瓶身' : '继续';
  }), async (runtime) => {
    const sessionId = seed(runtime, '回顾后续', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const before = runtime.store.listMessages(sessionId).length;
    const recap = '刚刚说到紫藤花蜜要放阴凉处，瓶身日期还没写';
    const result = await composerHintHttpResult(runtime, { sessionId, recap });
    assert.match(seen, /回顾：刚刚说到紫藤花蜜要放阴凉处，瓶身日期还没写/);
    assert.equal(result.body.hint, '把紫藤花蜜的开封日期写在瓶身');
    assert.equal(result.body.hint.includes('继续'), false);
    assert.equal(runtime.store.listMessages(sessionId).length, before);
    assert.notEqual(runtime.store.listMessages(sessionId).map((message) => message.role).join(','), 'user,assistant,user');
  });
});

test('回顾没写成或没有下一步时不插入建议 [AC:recap-next-action#AC-4]', async () => {
  await withRuntime(scriptedAdapter(() => ''), async (runtime) => {
    const sessionId = seed(runtime, '没有下一步', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    assert.equal((await composerHintHttpResult(runtime, { sessionId, recap: '瓶身日期还没写' })).body.hint, '');
  });
  await withRuntime(scriptedAdapter(() => '继续'), async (runtime) => {
    const sessionId = seed(runtime, '空话', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    assert.equal((await composerHintHttpResult(runtime, { sessionId, recap: '瓶身日期还没写' })).body.hint, '');
  });
});

test('没有回顾时仍按原对话给出下一步 [AC:recap-next-action#AC-5]', async () => {
  let seen = '';
  await withRuntime(scriptedAdapter((user) => {
    seen = user;
    return '再核对紫藤花蜜放在阴凉处能不能久放';
  }), async (runtime) => {
    const sessionId = seed(runtime, '无回顾', '我想做紫藤花蜜', '紫藤花蜜要放在阴凉处');
    const hint = (await composerHintHttpResult(runtime, { sessionId })).body.hint;
    assert.equal(seen.includes('回顾：'), false);
    assert.match(hint, /紫藤花蜜/);
  });
});
