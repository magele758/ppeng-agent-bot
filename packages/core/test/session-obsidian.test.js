import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveConversation, selectVault } from '../../../apps/daemon/dist/session-obsidian.js';

const session = {id:'session_one',title:'../研究',createdAt:'2026-11-13'};
const msg = (role,text,more={}) => ({role,parts:[{type:'text',text}],...more});
const history = [msg('user','question'), msg('tool','tool-secret'),msg('assistant','hidden',{hidden:true}),msg('assistant','**answer**')];

test('saves readable transcript and preserves edited snapshots [AC:session-obsidian#AC-1] [AC:session-obsidian#AC-2]', async t => {
  const vault = await mkdtemp(path.join(tmpdir(),'obsidian-'));
  t.after(()=>rm(vault,{recursive:true,force:true}));
  await mkdir(path.join(vault,'.obsidian'));
  const save = messages => saveConversation(vault,session,messages);
  const [a,b] = await Promise.all([save(history),save(history)]);
  assert.equal(a,b);
  const file = path.join(vault,a);
  const body = await readFile(file,'utf8');
  assert.match(body,/session_one[\s\S]*question[\s\S]*\*\*answer\*\*/);
  assert.doesNotMatch(body,/hidden|tool-secret/);
  await writeFile(file,'personal edits');
  assert.equal(await save(history),a);
  assert.notEqual(await save([...history,msg('user','next')]),a);
  assert.equal(await readFile(file,'utf8'),'personal edits');
});

test('requires a known vault and visible conversation [AC:session-obsidian#AC-3]',async () => {
  assert.equal(selectVault({a:{path:'/a'},b:{path:'/b',open:true}}),'/b');
  assert.throws(()=>selectVault({a:{path:'/a'},b:{path:'/b'}}),/vault/i);
  await assert.rejects(saveConversation('/missing',session,[msg('tool','private')]),/empty/i);
});

test('categories connect stored conversations to their subject [AC:session-obsidian#AC-4]',async () => {
  const { noteTopics } = await import('../../../apps/daemon/dist/session-obsidian.js');
  assert.deepEqual(noteTopics('数据库测试 LLM'),['ai','engineering']);
  assert.deepEqual(noteTopics('unclassified'),['other']);
});
