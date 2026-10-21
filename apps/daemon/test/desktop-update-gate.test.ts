import test from 'node:test';import assert from 'node:assert/strict';
import { DesktopUpdateGate } from '../src/desktop-update-gate.ts';
test('desktop update gate refuses tasks, requests and scheduler races [AC:desktop-safe-update#AC-3]',()=>{
 const gate=new DesktopUpdateGate(false);let suspended=false;
 assert.equal(gate.prepare(1,()=>{suspended=true;}),false);gate.mutations=1;
 assert.equal(gate.prepare(0,()=>{suspended=true;}),false);gate.mutations=0;gate.schedulerRunning=true;
 assert.equal(gate.prepare(0,()=>{suspended=true;}),false);assert.equal(suspended,false);
 gate.schedulerRunning=false;assert.equal(gate.prepare(0,()=>{suspended=true;}),true);assert.equal(suspended,true);
 assert.equal(gate.prepare(0,()=>{}),false);
});
test('validation starts with request and scheduler barrier closed [AC:desktop-safe-update#AC-10]',()=>{assert.equal(new DesktopUpdateGate(true).locked,true);});
