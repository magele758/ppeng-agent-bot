import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePreferences, isUserPreferenceKey } from './user-preference-schema.ts';
test('patch and explicit resets survive migration [AC:user-preference-sync#AC-1] [AC:user-preference-sync#AC-2]', () => {
 const old = {'theme':'dark','lab.locale':'zh'};
 const saved = mergePreferences(old,{'theme':null},false);
 assert.deepEqual(mergePreferences(saved,{'theme':'light','lab.fontSize':'18'},true),{'theme':null,'lab.locale':'zh','lab.fontSize':'18'});
});
test('only durable user preferences migrate [AC:user-preference-sync#AC-3]', () => {
 for(const key of ['theme','lab.locale','lab.skin','lab.fontSize','lab.settings.advanced','agentLab.sendAckSound','lab.sessionBrief','lab.botFirstTaskSent','lab.skillCaptureDismissed.session']) assert.equal(isUserPreferenceKey(key),true,key);
 for(const key of ['token','lab.selectedBot','lab.botFirstTaskDraft','lab.sessionBriefOpen','lab.railCollapsed']) assert.equal(isUserPreferenceKey(key),false,key);
});
import { readFileSync } from 'node:fs';
import { preferenceStorage, pendingPreferences, acknowledgePreferences, scopedLegacyPreferences } from './user-preference-storage.ts';
import { createPreferenceSync } from './user-preference-sync.ts';
test('client and server allowlists stay identical',()=>{
 assert.equal(readFileSync(new URL('./user-preference-schema.ts',import.meta.url),'utf8'),readFileSync(new URL('../../daemon/src/user-preferences.ts',import.meta.url),'utf8'));
});
test('failed writes retry and late replies preserve newer edits [AC:user-preference-sync#AC-3]',async()=>{
 const previous=globalThis.window;
 const data=new Map<string,string>();
 const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);},key:(i:number)=>[...data.keys()][i]??null,get length(){return data.size;}};
 Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:storage}});
 try {
  preferenceStorage.setItem('theme','dark');
  const sent=pendingPreferences();
  const sync=createPreferenceSync(async()=>{throw new Error('offline');});
  await assert.rejects(sync.save(sent));
  assert.equal(pendingPreferences().theme,'dark');
  preferenceStorage.removeItem('theme');
  acknowledgePreferences(sent);
  assert.equal(pendingPreferences().theme,null);
  scopedLegacyPreferences(storage as Storage,'user-a');
  preferenceStorage.setItem('lab.locale','zh');
  assert.deepEqual(scopedLegacyPreferences(storage as Storage,'user-b'),{});
  assert.equal(storage.getItem('lab.locale'),null);
  assert.deepEqual(pendingPreferences(),{});
 } finally {Object.defineProperty(globalThis,'window',{configurable:true,value:previous});}
});
