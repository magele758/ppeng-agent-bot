import test from 'node:test';import assert from 'node:assert/strict';import {chooseUpdate} from './update-prompt.ts';
test('selecting release only previews; cancel does not authorize installation [AC:desktop-safe-update#AC-1] [AC:desktop-safe-update#AC-2]',async()=>{
 const preview={current:'1 old-build',target:'2 new-build',notes:'release notes'};let shown;
 const result=await chooseUpdate({select:async()=>'/test/candidate.app',preview:()=>preview,confirm:async value=>{shown=value;return false;}});
 assert.deepEqual(shown,preview);assert.equal(result,undefined);
});
test('only explicit update confirmation returns an authorized candidate [AC:desktop-safe-update#AC-1] [AC:desktop-safe-update#AC-2]',async()=>{
 const preview={current:'1',target:'2',notes:'changes'};
 assert.deepEqual(await chooseUpdate({select:async()=>'/test/new.app',preview:()=>preview,confirm:async()=>true}),{candidate:'/test/new.app',preview});
 assert.equal(await chooseUpdate({select:async()=>undefined,preview:()=>{throw Error('must not inspect')},confirm:async()=>{throw Error('must not confirm')}}),undefined);
});
