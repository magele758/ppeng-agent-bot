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

test('selected reply excludes neighboring turns and tools [AC:session-obsidian#AC-5]',async()=>{
  const { selectedReply } = await import('../../../apps/daemon/dist/session-obsidian.js');
  const messages = [msg('assistant','first'),msg('tool','private'),msg('assistant','second'),msg('user','next question'),msg('assistant','other')].map((m,i)=>({...m,id:String(i)}));
  const reply = selectedReply(messages,['0','2']);
  assert.deepEqual(reply.messages.map(m=>m.id),['0','2']);
  assert.equal(reply.title,'first');
  assert.throws(()=>selectedReply(messages,['0','4']));
  assert.throws(()=>selectedReply(messages,[]));
  assert.throws(()=>selectedReply(messages,['missing']));
});

test('vault setting persists until cleared and rejects invalid replacements [AC:session-obsidian#AC-6]', async t => {
  const { resolveVault, configureVault } = await import('../../../apps/daemon/dist/obsidian-settings.js');
  const state = new Map();
  const store = {getDaemonControl:key=>state.get(key), setDaemonControl:(key,value)=>state.set(key,value), deleteDaemonControl:key=>state.delete(key)};
  const directory = await mkdtemp(path.join(tmpdir(),'vault-setting-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(path.join(directory,'.obsidian'));
  const auto = async()=>'/auto';
  await configureVault(store,directory);
  const chosen = await resolveVault(store,auto);
  assert.equal(path.basename(chosen),path.basename(directory));
  await assert.rejects(configureVault(store,path.join(directory,'missing')));
  assert.equal(await resolveVault(store,auto),chosen);
  await configureVault(store,'');
  assert.equal(await resolveVault(store,auto),'/auto');
});
