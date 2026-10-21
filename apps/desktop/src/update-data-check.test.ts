import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {checkData} from './update-data-check.ts';
test('data validation detects lost messages after a migration [AC:desktop-safe-update#AC-6] [AC:desktop-safe-update#AC-7]',()=>{
 const root=mkdtempSync(join(tmpdir(),'update-data-check-'));try{
 const before=join(root,'before'),after=join(root,'after');mkdirSync(before);mkdirSync(after);
 const db=new DatabaseSync(join(before,'runtime.sqlite'));db.exec("CREATE TABLE session_messages(id TEXT PRIMARY KEY,body TEXT); INSERT INTO session_messages VALUES('m1','keep this message')");db.close();copyFileSync(join(before,'runtime.sqlite'),join(after,'runtime.sqlite'));
 checkData(after,before);const changed=new DatabaseSync(join(after,'runtime.sqlite'));changed.exec('DELETE FROM session_messages');changed.close();assert.throws(()=>checkData(after,before),/Data missing/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
