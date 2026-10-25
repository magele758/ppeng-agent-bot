import test from 'node:test';
import assert from 'node:assert/strict';
import { getLatestAssistantText } from '../dist/runtime/session-facade.js';
import { classifyGoalMessage, classifyGoalIntents } from '../dist/bots/goals/intake.js';

export const smoke = '这是 PR #251 更新后的只读冒烟验证。本轮独立计算 19 + 23，不执行命令、不读写文件、不创建或推进目标任务。只输出数字。';

test('latest answer excludes reasoning without altering transcript [AC:bot-readonly-api#AC-1]',()=>{
 const messages=[{role:'assistant',parts:[{type:'text',text:'old answer'}]},{role:'assistant',parts:[{type:'reasoning',text:'private plan'},{type:'text',text:'4'},{type:'text',text:'2'}]}];
 const before=structuredClone(messages),store={foldMessages:()=>messages};
 assert.equal(getLatestAssistantText(store,'s'),'4\n2');
 assert.deepEqual(messages,before);
 messages.at(-1).parts=[{type:'reasoning',text:'private only'}];
 assert.equal(getLatestAssistantText(store,'s'),'');
 assert.equal(getLatestAssistantText({foldMessages:()=>[]},'s'),undefined);
});
test('explicit read-only request bypasses goal judge [AC:bot-readonly-api#AC-2]',async()=>{
 let calls=0;
 for(const text of [smoke,'只读查询当前配置；不要写入文件。只输出 JSON。','Read-only check: calculate 19 + 23. Do not run commands or create tasks. Only output the number.']){
  assert.equal(classifyGoalMessage(text).kind,'query',text);
  const intents=await classifyGoalIntents(text,[],async()=>{calls++;return {intents:[{kind:'new_goal',text}]};});
  assert.deepEqual(intents,[{kind:'query',text}]);
 }
 assert.equal(calls,0);
});
test('readonly words cannot erase deliverables or explicit controls [AC:bot-readonly-api#AC-3]',()=>{
 for(const text of ['只读查询数据，然后保存结果到 result。','Read-only inspect config, then update the port.','请实现“只读查询”功能','不要只读，修复故障','只读查日志，不要改样式，但修复计算逻辑。','只读查询状态；另外创建报告文件。','只读查数据，不写日志并保存结果。','Read-only check. Do not run commands and save the result.','This is not read-only. Calculate and persist results.'])assert.ok(['new_goal','amend_goal'].includes(classifyGoalMessage(text).kind),text);
 assert.equal(classifyGoalMessage('[goal:g1] 暂停，只读查询状态').kind,'pause');
 assert.equal(classifyGoalMessage('[goal:g1] 只读查询状态').kind,'amend_goal');
});

test('read-only clauses preserve named amendments and priority controls [AC:bot-readonly-api#AC-3]',async()=>{
 const goals=[{id:'goal_a',title:'调查日志',status:'paused',priority:0}];
 assert.equal((await classifyGoalIntents('追加要求：目标 goal_a 只读查询，不要重做',goals))[0].kind,'amend_goal');
 assert.ok((await classifyGoalIntents('只读查询状态；另外提高调查日志优先级',goals)).some(i=>i.kind==='reprioritize'));
 assert.equal(classifyGoalMessage('Read-only inspect data, then persist the result.').kind,'new_goal');
});
