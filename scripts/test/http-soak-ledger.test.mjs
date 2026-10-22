import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLedgerBatch} from '../bot-release/http-soak-ledger.mjs';
test('driver batches observation commits while preserving all rows and SQLite FULL durability',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soak-ledger-'));const db=new DatabaseSync(join(dir,'ledger.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE events(id INTEGER PRIMARY KEY,value TEXT)');const reader=new DatabaseSync(join(dir,'ledger.sqlite'));let now=0;
 try{const batch=createLedgerBatch(db,()=>now);batch.start();for(let i=0;i<50;i++)db.prepare('INSERT INTO events VALUES(?,?)').run(i,'observed');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,50);assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
 now=99;batch.flush();assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
 now=100;batch.flush();assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM events').get().n,50);
 db.prepare('INSERT INTO events VALUES(?,?)').run(50,'final');batch.finish();batch.finish();assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM events').get().n,51);
 assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2);
 }finally{reader.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
