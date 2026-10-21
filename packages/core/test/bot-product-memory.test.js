import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDialogueFacts } from '../dist/memory/memory-dialogue-extract.js';
import { mergeSemanticFactContent } from '../dist/memory/memory-semantic-merge.js';
import { SqliteStateStore } from '../dist/storage.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryTools } from '../dist/tools/memory-tools.js';

test('temporary task instructions never become automatic long-term preferences [AC:bot-product-p2#AC-3]', async () => {
  let calls = 0;
  for (const userText of ['仅这次任务请使用英文，以后的偏好不变。', 'For this task only, use Markdown. Do not remember this.']) {
    const facts = await extractDialogueFacts({ userText, completeText: async () => {
      calls++;
      return JSON.stringify({ facts: [{ category: 'preference', content: 'Always use English and Markdown', importance: 0.8 }] });
    } });
    assert.deepEqual(facts, []);
  }
  assert.equal(calls, 0);
});

test('corrected memory keeps an inspectable prior value while recall uses the replacement [AC:bot-product-p2#AC-2] [AC:bot-product-p2#AC-3]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-memory-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    const memory = store.agentMemory();
    const original = memory.set({ scope: 'user.memory', namespace: 'default', key: 'language', value: 'Chinese',
      userId: 'u', agentId: 'bot', importance: 0.8, confidence: 'high', source: 'user' });
    const corrected = memory.set({ ...original, value: 'English', source: 'user_correction' });
    assert.equal(corrected.id, original.id);
    assert.equal(memory.getEntryById(original.id).value, 'English');
    const revisions = memory.revisions(original.id);
    assert.equal(revisions[0].value, 'Chinese');
    assert.equal(revisions[0].updatedAt, original.updatedAt);
    assert.equal(revisions[0].source, 'user');
    assert.equal(Object.hasOwn(corrected, 'revisions'), false);
  } finally {store.db.close();rmSync(dir, {recursive:true,force:true});}
});

test('explicit corrections replace a conflicting recalled fact instead of concatenating both [AC:bot-product-p2#AC-3]', () => {
  assert.equal(mergeSemanticFactContent('用户偏好：所有回复使用中文', '更正：用户偏好从现在起使用英文'), '更正：用户偏好从现在起使用英文');
});

test('model-initiated memory writes cannot persist a temporary user instruction [AC:bot-product-p2#AC-3]', async () => {
  const writes=[];
  const tools=createMemoryTools({
    currentUserText:async()=> '仅这次任务请使用英文，不要记住这个要求。',
    upsertSessionMemory:async(...args)=>{writes.push(args);},
    upsertAgentMemory:async(input)=>{writes.push(input);},
    listSessionMemory:async()=>[],deleteSessionMemory:async()=>false,
  });
  const tool=tools.find(tool=>tool.name==='memory_set');
  const context={session:{id:'s',metadata:{userId:'u'}},agent:{id:'general'}};
  assert.equal((await tool.execute(context,{scope:'user',key:'language',value:'Always use English.'})).ok,false);
  assert.equal((await tool.execute(context,{scope:'long',key:'language',value:'Always use English.'})).ok,false);
  assert.equal(writes.length,0);
  assert.equal((await tool.execute(context,{scope:'scratch',key:'language',value:'Use English for this task.'})).ok,true);
  assert.equal(writes.length,1);
});

test('repeated compaction retains pending work, corrected recall and accessible original evidence [AC:bot-product-p2#AC-4]', async () => {
  const { autoCompactSession } = await import('../dist/runtime/compact-host.js');
  const { createExtensionRegistry } = await import('../dist/extensions/extension-registry.js');
  const { createBot, openBot } = await import('../dist/bots/bot-facade.js');
  const { compileTurnAppendix } = await import('../dist/session/context-compiler.js');
  const { createHistoryTools } = await import('../dist/session/history/tools.js');
  const dir = mkdtempSync(join(tmpdir(), 'product-memory-compact-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    const bot = createBot({store}, { name: 'Continuing worker' });
    const session = store.getSession(openBot({store}, bot.id).sessionId);
    const source = store.appendMessage(session.id,'user',[{type:'text',text:'The launch city is OLD_CITY. The release checklist is unfinished.'}]);
    const memory = store.agentMemory();
    const original = memory.set({ scope:'user.memory',namespace:'semantic',key:'launch-city',value:'The launch city is OLD_CITY.',
      userId:session.metadata.userId,agentId:bot.id,importance:0.9,confidence:'high',
      sourceRefs:[{sessionId:session.id,messageId:source.id,seq:source.seq}] });
    const host = { store, stateDir:dir, extensionRegistry:createExtensionRegistry(),turnShapeBySession:new Map(),
      emitTrace(){},prepareMessagesForModel:async(_context,messages)=>messages,
      modelAdapter:{name:'deterministic-continuation',contextWindow:8192,async summarizeMessages(){
        return 'Pending work: finish the release checklist. This is a summary; use original history for evidence and current memory for corrected facts.';
      }} };
    const context = { session, agent:store.getAgent(bot.agentId),repoRoot:dir,stateDir:dir };
    let correction;
    for(let pass=0;pass<3;pass++){
      for(let i=0;i<32;i++)store.appendMessage(session.id,i%2?'assistant':'user',[{type:'text',text:`Checklist item ${pass}:${i} is still pending.`}]);
      if(pass===1){
        correction=store.appendMessage(session.id,'user',[{type:'text',text:'Correction: the launch city is NEW_CITY.'}]);
        memory.set({...original,value:'The launch city is NEW_CITY.',source:'user_correction',
          sourceRefs:[{sessionId:session.id,messageId:correction.id,seq:correction.seq}]});
      }
      await autoCompactSession(host,context,{force:true});
    }
    const current=store.getSession(session.id);
    assert.match(current.summary,/finish the release checklist/);
    const appendix=compileTurnAppendix({session:current,query:'launch city',store});
    assert.match(appendix,/NEW_CITY/);assert.doesNotMatch(appendix,/OLD_CITY/);
    const search=createHistoryTools(store).find(tool=>tool.name==='history_search');
    const result=JSON.parse((await search.execute({session:current},{query:'Correction: the launch city'})).content);
    assert.ok(result.messages.some(message=>message.id===correction.id));
    assert.equal(store.readHistory(session.id,source.seq,0,0).message.id,source.id);
  } finally {store.db.close();rmSync(dir,{recursive:true,force:true});}
});
