import test from 'node:test';
import assert from 'node:assert/strict';
import { omitStreamTextSavedOnTurn, unpersistedAssistantText } from './history-window.ts';
import { buildFeedSlots } from './feed-window.ts';

const before = '这段内容在用户插话之前已经输出并且保存了。';
const after = '这是插话之后正在输出的新内容。';
const row = (id: string, role: string, text: string, key?: string) => ({ id, role, key, parts: [{ type: 'text', text }] });
const segment = (raw: string) => ({ id: 'live', kind: 'text', raw, html: raw });

test('插话落库后旧回复留在原位置，不从流式末尾重放 [AC:steer-timeline-order#AC-1]', () => {
  const messages = [row('u','user','检查目录'),row('a','assistant',before),row('s','user','换个目录','human-steer:inbox-1')];
  const original = structuredClone(messages);
  const visible = omitStreamTextSavedOnTurn(messages,[segment(before),segment(after)]);
  assert.deepEqual(visible.map(item => item.raw),[after]);
  const slots = buildFeedSlots({messages,turns:[],approvalIndexes:[],optimistic:false,stream:true,streamApproval:false,typing:false,trail:false});
  assert.deepEqual(slots.map(slot => slot.key),['m:u','m:a','m:s','stream']);
  assert.deepEqual(messages,original);
});
test('多次插话和收尾保留只显示尚未保存的新输出 [AC:steer-timeline-order#AC-2]', () => {
  const middle = '第一次插话后的工作已经核对并保存在记录里。';
  const messages = [row('u','user','检查目录'),row('a','assistant',before),row('s1','user','调整','steer'),row('a2','assistant',middle),row('s2','user','再调整','human-steer:inbox-2')];
  const segments = [segment(before + middle + after)];
  assert.deepEqual(omitStreamTextSavedOnTurn(messages,segments).map(item => item.raw),[after]);
  assert.equal(unpersistedAssistantText(messages,segments),after);
  assert.equal(unpersistedAssistantText(messages,[segment(before),segment(middle)]),'');
  assert.equal(unpersistedAssistantText(messages,[segment(before.slice(0,8)),segment(before.slice(8))]),'');
});
test('真正的新请求保留重复措辞的新回复 [AC:steer-timeline-order#AC-3]', () => {
  const messages = [row('u','user','旧问题'),row('a','assistant',before),row('s','user','调整','steer'),row('u2','user','再检查一次')];
  assert.deepEqual(omitStreamTextSavedOnTurn(messages,[segment(before)]).map(item => item.raw),[before]);
  assert.equal(unpersistedAssistantText(messages,[segment(before)]),before);
});
