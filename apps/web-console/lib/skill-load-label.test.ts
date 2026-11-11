import test from 'node:test';
import assert from 'node:assert/strict';
import {toolDisplayName} from './skill-load-label.ts';
const format=(name:string)=>`加载技能：${name}`;
test('skill name is readable from stored args and an incomplete streamed object [AC:skill-load-visible#AC-2]',()=>{
 assert.equal(toolDisplayName('load_skill',{name:' Planning '},format),'加载技能：Planning');
 assert.equal(toolDisplayName('load_skill','{"name":"agent-home-diagnostics"',format),'加载技能：agent-home-diagnostics');
 assert.equal(toolDisplayName('load_skill','{"name":"a\\"b"',format),'加载技能：a"b');
});
test('unknown names and unrelated tools remain safe [AC:skill-load-visible#AC-3]',()=>{
 for(const input of [undefined,null,{},[],{name:42},'{"name":"unfinished','{"name":"bad\\q"}','{"options":{"name":"not-the-skill"}'])assert.equal(toolDisplayName('load_skill',input,format),'load_skill');
 assert.equal(toolDisplayName('bash',{name:'not a skill'},format),'bash');
 assert.equal(toolDisplayName(undefined,null,format),'unknown');
 assert.equal(toolDisplayName('',null,format),'unknown');
});
