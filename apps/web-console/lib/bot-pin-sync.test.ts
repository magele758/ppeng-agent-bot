import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinSync } from './bot-pin-sync.ts';
test('cross browser pins and explicit empty state [AC:bot-pin-sync#AC-1]', async () => {
 let server: any = null;
 const request = async (_: string, init?: RequestInit) => {
  if (init) server = JSON.parse(String(init.body)).state;
  return { state: server };
 };
 const a = createPinSync(request), b = createPinSync(request);
 const pins = {customized:true,ids:['rsi'],roomIds:[]};
 await a.save(pins);
 assert.deepEqual(await b.refresh({customized:false,ids:[],roomIds:[]}), pins);
 const empty = {...pins,ids:[]};
 await a.save(empty);
 assert.deepEqual(await b.refresh(pins), empty);
});
test('migrate only before server state exists [AC:bot-pin-sync#AC-2]', async () => {
 let server: any = null;
 const request = async (_: string, init?: RequestInit) => {
  if(init && (!JSON.parse(String(init.body)).initialize || !server)) server=JSON.parse(String(init.body)).state;
  return {state:server};
 };
 const sync = createPinSync(request);
 const old = {customized:true,ids:['rsi'],roomIds:[]};
 assert.deepEqual(await sync.refresh(old),old);
 assert.deepEqual(await sync.refresh({...old,ids:['other']}),old);
});
