import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RawAgentRuntime} from '../dist/exports/public.js';
const result={stopReason:'end',assistantParts:[{type:'text',text:'valid answer'}]};
test('aborting a contender before writer admission preserves the live owner [AC:session-multiprocess-state-consistency#AC-1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abort-contender-'));
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const options = { repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'), modelAdapter: {
    name: 'abort-contender', summarizeMessages: async () => '',
    runTurn: async () => { entered(); await gate; return result; }
  } };
  const owner = new RawAgentRuntime(options), contender = new RawAgentRuntime(options);
  let running;
  try {
    const session = owner.createChatSession({ message: 'hold owner' });
    running = owner.runSession(session.id);
    await ready;
    const before = owner.getSession(session.id);
    const controller = new AbortController();
    controller.abort();
    const competing = contender.runSession(session.id, { signal: controller.signal });
    const after = owner.getSession(session.id);
    await assert.rejects(competing, { code: 'WRITER_CLAIM_MISMATCH' });
    release();
    await running;
    assert.deepEqual(after, before);
    assert.equal(owner.getLatestAssistantText(session.id), 'valid answer');
  } finally {
    release();
    await running?.catch(() => {});
    await contender.destroy(); await owner.destroy();
  }
});
test('revoked model cannot publish late stream content into the session [AC:session-multiprocess-state-consistency#AC-2]',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stream-fence-'));let oldEntered,oldRelease,nextEntered,nextRelease;
  const entered=new Promise(r=>oldEntered=r), gate=new Promise(r=>oldRelease=r);
  const next=new Promise(r=>nextEntered=r),nextGate=new Promise(r=>nextRelease=r);
  const make=runTurn=>new RawAgentRuntime({repoRoot:join(dir,'repo'),stateDir:join(dir,'state'),modelAdapter:{name:'controlled',summarizeMessages:async()=>'',completeText:async()=>'{"met":true}',runTurn,runTurnStream:runTurn}});
  const first=make(async(_input,stream)=>{oldEntered();await gate;stream?.({type:'text_delta',text:'late-old'});return result;});
  const second=make(async()=>{nextEntered();await nextGate;return result;});
  let a,b;const direct=[],follow=[];
  try{
    const session=first.createChatSession({message:'work'});first.subscribeModelStream(session.id,c=>follow.push(c));
    a=first.runSession(session.id,{onModelStreamChunk:c=>direct.push(c)});await entered;
    first.cancelSession(session.id);b=second.runSession(session.id);await next;
    const before=second.getSession(session.id);oldRelease();await a;
    assert.equal(second.getSession(session.id).status,before.status);
    assert.equal(second.getSession(session.id).activeWriterRunId,before.activeWriterRunId);
    assert.deepEqual(direct,[]);assert.deepEqual(follow,[]);
    nextRelease();await b;
    assert.equal(second.getLatestAssistantText(session.id),'valid answer');
  }finally{oldRelease();nextRelease();await Promise.allSettled([a,b].filter(Boolean));await first.destroy();await second.destroy();}
});
