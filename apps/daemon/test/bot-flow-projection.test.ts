import assert from 'node:assert/strict';
import test from 'node:test';
import { flowSessionView } from '../src/routes/flow-session-view.ts';
test('工作流读模型只保留会话关系、状态与用量 [AC:bot-flow-read-projection#AC-1]',()=>{
 const s={id:'s',title:'child',status:'completed',agentId:'worker',parentSessionId:'parent',updatedAt:'date',metadata:{usageCostUsd:0,usageTotals:{totalTokens:78,extra:1},workingLog:'private'}};
 const view=flowSessionView(s);
 assert.deepEqual(view,{id:'s',title:'child',status:'completed',agentId:'worker',parentSessionId:'parent',updatedAt:'date',metadata:{usageCostUsd:0,usageTotals:{totalTokens:78}}});
 assert.equal(s.metadata.workingLog,'private');
});
