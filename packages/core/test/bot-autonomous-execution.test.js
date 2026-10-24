import test from 'node:test';
import assert from 'node:assert/strict';
import {selectGoalRoute} from '../dist/bots/goals/routing.js';
import {goalWorkKind} from '../dist/bots/goals/runtime-host.js';
import {createGoalExecutionAdapters} from '../dist/bots/goals/adapters.js';
import {selfHealPresetForTask} from '../dist/bots/goals/specialty-services.js';

const capabilities = {registeredTools:['spawn_subagent','ptc_exec','goal_self_heal_start','factory_dispatch'],enabledStrategies:['direct','subagent','ptc','orchestrator','self_heal','factory'],hasWorkspace:true,ptcEnabled:true};
test('task intent chooses execution without a user mode [AC:bot-autonomous-execution-coverage#AC-1]',()=>{
  assert.equal(selectGoalRoute({task:'解释这段代码'},capabilities).strategy,'direct');
  assert.equal(selectGoalRoute({task:'请编排规划、开发和验证整个功能'},capabilities).strategy,'orchestrator');
});
test('task intent selects research browser computer and batch profiles [AC:bot-autonomous-execution-coverage#AC-2]',()=>{
  const c={...capabilities,registeredTools:[...capabilities.registeredTools,'browser_navigate','lcu_action']};
  for(const [task,mode] of [['调研部署方案','deep_research'],['使用浏览器填写网页','browser'],['操作电脑桌面','computer'],['批量处理数据','dynamic_workflow']]) {
    assert.equal(selectGoalRoute({task},c).taskMode,mode);
  }
});
test('specialty requirements never silently become ordinary chat [AC:bot-autonomous-execution-coverage#AC-6]',()=>{
  for(const task of ['启动自愈修复失败测试','启动 Evolution 演进流程','运行工厂任务']) {
    assert.equal(selectGoalRoute({task},{registeredTools:[],enabledStrategies:['direct']}).blocked,true,task);
  }
});
test('self heal and factory launch real authorized operations and keep references [AC:bot-autonomous-execution-coverage#AC-3]',async()=>{
  const calls=[];
  const adapters=createGoalExecutionAdapters({getCapabilities:()=>capabilities,runSessionExecution:async()=>{throw Error('must use service')},invokeAuthorizedTool:async(name,args)=>{calls.push({name,args});return {ok:true,content:JSON.stringify({id:'durable-run'})}}});
  const base={goalId:'g',revision:1,executionId:'e',task:'启动自愈修复失败测试'};
  const heal=await adapters.start(base);
  assert.equal(heal.status,'waiting');assert.equal(heal.reference,'durable-run');assert.equal(calls[0].name,'goal_self_heal_start');
  const factory=await adapters.start({...base,task:'运行工厂快照',factory:{machineId:'m',repositoryId:'r',operation:'snapshot'}});
  assert.equal(factory.status,'waiting');assert.equal(calls[1].name,'factory_dispatch');assert.equal(calls[1].args.machineId,'m');
});
test('professional work selects original specialist and carries prior progress [AC:bot-autonomous-execution-coverage#AC-4] [AC:bot-autonomous-execution-coverage#AC-5]',async()=>{
  const seen=[];
  const adapters=createGoalExecutionAdapters({getCapabilities:()=>capabilities,runSessionExecution:async req=>{seen.push(req);return {status:'waiting',reference:'session:child',content:'started'}},invokeAuthorizedTool:async()=>{throw Error('not expected')}});
  for(const [task,role] of [['制定产品规划','planner'],['实现功能','generator'],['验收测试结果','evaluator']]) {
    await adapters.start({goalId:'same-goal',revision:2,executionId:role,task,preferredStrategy:'subagent',progress:'研究已完成',evidence:['研究结论'],constraints:['不发布']});
    assert.equal(seen.at(-1).role,role);assert.equal(seen.at(-1).goalId,'same-goal');
    assert.match(seen.at(-1).task,/研究已完成/);assert.match(seen.at(-1).task,/不发布/);
  }
});
test('cancellation targets actual specialized executor [AC:bot-autonomous-execution-coverage#AC-7]',async()=>{
  const calls=[];
  const adapters=createGoalExecutionAdapters({getCapabilities:()=>capabilities,runSessionExecution:async()=>({status:'blocked',content:''}),invokeAuthorizedTool:async()=>({ok:false,content:''}),cancelExecution:async(ref,strategy)=>{calls.push([ref,strategy]);return true}});
  assert.equal(await adapters.cancel('run-1','self_heal'),true);
  assert.deepEqual(calls,[['run-1','self_heal']]);
  assert.equal(goalWorkKind('操作电脑桌面'),'computer');
});
test('self-heal chooses the requested test workflow without a mode form [AC:bot-autonomous-execution-coverage#AC-1]',()=>{
  for(const [task,preset] of [['启动自愈修复端到端测试','e2e'],['运行自愈修复回归测试','regression'],['start self-heal for CI failures','ci'],['启动自愈修复构建','build'],['启动自愈修复测试','unit']]) assert.equal(selfHealPresetForTask(task),preset);
  assert.equal(selectGoalRoute({task:'实现 factory 状态展示'},capabilities).strategy,'direct');
});
