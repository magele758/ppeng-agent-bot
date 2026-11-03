import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantNameLabel, transcriptBotName } from './assistant-name.ts';
const t = (key: string, values?: { name: string }) => ({ 'play.role.assistant':'助手', 'play.role.streaming':'助手（生成中）', 'play.role.botStreaming':`${values?.name}（生成中）` })[key] ?? key;
test('named Bot labels cover stored and streaming replies [AC:bot-message-name#AC-1]', () => {
 assert.equal(assistantNameLabel(' RSI bot ', false, t), 'RSI bot');
 assert.equal(assistantNameLabel('RSI bot', true, t), 'RSI bot（生成中）');
 assert.equal(transcriptBotName(true, {name:'RSI bot'}), 'RSI bot');
});
test('ordinary or unnamed chats retain localized fallback [AC:bot-message-name#AC-2]', () => {
 assert.equal(transcriptBotName(false, {name:'RSI bot'}), null);
 assert.equal(assistantNameLabel(null, false, t), '助手');
 assert.equal(assistantNameLabel(' ', true, t), '助手（生成中）');
});
