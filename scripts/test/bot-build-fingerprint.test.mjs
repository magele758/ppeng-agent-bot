import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readBuildTreeFingerprint} from '../bot-release/executable-fingerprint.mjs';

test('build fingerprint covers nested and hidden artifacts and detects content changes without a CLI',t=>{
 const root=mkdtempSync(join(tmpdir(),'build-fingerprint-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'nested'));writeFileSync(join(root,'z.js'),'z');
 writeFileSync(join(root,'nested','a.map'),'map');writeFileSync(join(root,'.hidden'),'hidden');
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const expected=[['.hidden','hidden'],['nested/a.map','map'],['z.js','z']].map(([path,value])=>`${root}/${path}:${digest(value)}`).join('\n');
 assert.deepEqual(readBuildTreeFingerprint([root]),{count:3,hash:digest(expected)});
 writeFileSync(join(root,'nested','a.map'),'changed');
 assert.notEqual(readBuildTreeFingerprint([root]).hash,digest(expected));
 assert.throws(()=>readBuildTreeFingerprint([join(root,'missing')]),/ENOENT/);
});
