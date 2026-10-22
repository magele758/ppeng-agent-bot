import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  acceptSuggestionResponse,
  defaultInputSuggestionSettings,
  hasPersistedInputSuggestionSettings,
  inputSuggestionRequest,
  parseInputSuggestion,
  readInputSuggestionSettings,
  recentSuggestionTurns,
  suggestionPrompt,
  suggestionVisible,
  writeInputSuggestionSettings
} from '../dist/session/input-suggestion.js';

test('输入框在回复结束后才显示建议，开关关闭则不显示 [AC:bot-input-suggestion#AC-2]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'input-suggestion-settings-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    assert.equal(hasPersistedInputSuggestionSettings(store), false);
    assert.equal(defaultInputSuggestionSettings().enabled, true);
    assert.equal(readInputSuggestionSettings(store).enabled, true, '从未保存时默认开');

    const idle = { botChat: true, draft: '', focused: true, busy: false, enabled: true };
    assert.equal(suggestionVisible(idle), true);
    assert.equal(suggestionVisible({ ...idle, busy: true }), false, '回复还没结束');
    assert.equal(suggestionVisible({ ...idle, draft: '已有字' }), false);
    assert.equal(suggestionVisible({ ...idle, focused: false }), false);
    assert.equal(suggestionVisible({ ...idle, botChat: false }), false, '非 bot 会话不建议');

    const off = writeInputSuggestionSettings(store, { enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(hasPersistedInputSuggestionSettings(store), true);
    assert.equal(readInputSuggestionSettings(store).enabled, false);
    assert.equal(suggestionVisible({ ...idle, enabled: readInputSuggestionSettings(store).enabled }), false);

    const on = writeInputSuggestionSettings(store, { enabled: true });
    assert.equal(on.enabled, true);
    assert.equal(suggestionVisible({ ...idle, enabled: true }), true);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('建议来自最近对话，模型输出被整理成一条主建议和至多两条备选 [AC:bot-input-suggestion#AC-2]', () => {
  const messages = [
    { id: '1', sessionId: 's', role: 'user', parts: [{ type: 'text', text: '帮我看登录失败' }], createdAt: '' },
    { id: '2', sessionId: 's', role: 'assistant', parts: [{ type: 'text', text: '日志里是密码错误。' }], createdAt: '' },
    { id: '3', sessionId: 's', role: 'tool', parts: [{ type: 'text', text: '不应进入建议上下文' }], createdAt: '' },
    {
      id: '4',
      sessionId: 's',
      role: 'assistant',
      hidden: true,
      parts: [{ type: 'text', text: '隐藏内容' }],
      createdAt: ''
    }
  ];
  const turns = recentSuggestionTurns(messages);
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ['user', 'assistant']
  );
  const request = inputSuggestionRequest(turns);
  assert.match(request.user, /登录失败/);
  assert.match(request.user, /密码错误/);
  assert.doesNotMatch(request.user, /隐藏内容/);
  assert.doesNotMatch(request.user, /不应进入/);

  const parsed = parseInputSuggestion(
    '{"suggestions":["把重置密码的步骤发我","再查一次最近的失败","第三条","把重置密码的步骤发我","第四条丢掉"]}'
  );
  assert.equal(parsed.primary, '把重置密码的步骤发我');
  assert.deepEqual(parsed.alternatives, ['再查一次最近的失败', '第三条']);
  assert.equal(parseInputSuggestion('{"primary":"继续","alternatives":["换个问法"]}').alternatives[0], '换个问法');
  assert.equal(parseInputSuggestion('not json but a line').primary, 'not json but a line');
  assert.equal(parseInputSuggestion('{"suggestions":[]}'), null);
  assert.equal(parseInputSuggestion(''), null);

  const early = '甲开头'.repeat(900);
  const middle = '乙中间'.repeat(900);
  const latest = '丙最近'.repeat(40);
  const prompt = suggestionPrompt([
    { role: 'user', text: early },
    { role: 'assistant', text: middle },
    { role: 'user', text: latest }
  ]);
  assert.ok(prompt.length <= 4000);
  assert.match(prompt, /丙最近/);
  assert.doesNotMatch(prompt, /甲开头/, '超长时丢掉最早的轮次，保留最近几轮');
  assert.match(prompt, /^assistant: 乙中间/);
});

test('后发出的建议请求覆盖先发出的，过期响应不能串到当前会话 [AC:bot-input-suggestion#AC-4]', () => {
  const first = { primary: '旧建议', alternatives: [] };
  const second = { primary: '新建议', alternatives: ['备选'] };
  assert.equal(
    acceptSuggestionResponse({
      requestId: 1,
      latestId: 2,
      sessionId: 's1',
      currentSessionId: 's1',
      value: first
    }),
    null,
    '旧请求晚到也被丢弃'
  );
  assert.deepEqual(
    acceptSuggestionResponse({
      requestId: 2,
      latestId: 2,
      sessionId: 's1',
      currentSessionId: 's1',
      value: second
    }),
    second
  );
  assert.equal(
    acceptSuggestionResponse({
      requestId: 2,
      latestId: 2,
      sessionId: 's1',
      currentSessionId: 's2',
      value: second
    }),
    null,
    '切到别的会话后不能把建议画过去'
  );
});
