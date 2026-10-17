/** Real pinned old binary + fresh fixture only. No live state or user credentials are touched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../../packages/core/dist/storage.js';
import { getCurrentSchemaVersion, LATEST_SCHEMA_VERSION } from '../../packages/core/dist/stores/migrations/index.js';
import { openBot } from '../../packages/core/dist/bots/bot-facade.js';
import { createCronJob, listCronJobs } from '../../packages/core/dist/cron/cron-facade.js';
import { RoutineRunStore } from '../../packages/core/dist/cron/routine-runtime.js';
import { sanitizeSpawnEnv } from '../../packages/core/dist/sandbox/env-sanitizer.js';
import { loadSqlDump } from '../migration-fixtures/sql-dump.mjs';
import { preparePinnedCheckout } from '../migration-fixtures/pinned-checkout.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REF = '96d55dc449c776ae4627c570d3fa561cfdd70893';
const fixtureSql = readFileSync(new URL('../migration-fixtures/snapshots/v24.sql', import.meta.url), 'utf8');
const ids = JSON.parse(fixtureSql.split('\n').find(line => line.startsWith('-- seed ids: ')).slice('-- seed ids: '.length));
function run(command, args, cwd = ROOT) {
 const result = spawnSync(command, args, { cwd, encoding:'utf8', env:sanitizeSpawnEnv(), timeout:120000 });
 assert.equal(result.status, 0, `${command} failed: ${result.stdout}\n${result.stderr}`);
 return result.stdout.trim();
}
function host(store,stateDir) {return {store,stateDir,cronStore:undefined,setCronStore(next){this.cronStore=next},runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}};}
function linkDependencies(checkout) {
 const target=join(checkout,'node_modules');mkdirSync(join(target,'@ppeng'),{recursive:true});
 for(const entry of readdirSync(join(ROOT,'node_modules')))if(entry!=='.bin'&&entry!=='@ppeng')symlinkSync(join(ROOT,'node_modules',entry),join(target,entry));
 for(const pkg of readdirSync(join(ROOT,'node_modules/@ppeng')))symlinkSync(readlinkSync(join(ROOT,'node_modules/@ppeng',pkg)),join(target,'@ppeng',pkg));
}
function hash(path) {return createHash('sha256').update(readFileSync(path)).digest('hex');}
/** Writer already closed. Checkpoint then close the connection before copying a complete file set. */
function stoppedSnapshot(source,target) {
 const db=new DatabaseSync(join(source,'runtime.sqlite'));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
 mkdirSync(target,{recursive:true});copyFileSync(join(source,'runtime.sqlite'),join(target,'runtime.sqlite'));
 for(const directory of ['cron','transcripts'])cpSync(join(source,directory),join(target,directory),{recursive:true});
 const manifest={database:hash(join(target,'runtime.sqlite')),cron:hash(join(target,'cron/jobs.json')),transcript:hash(join(target,'transcripts/legacy.txt'))};
 writeFileSync(join(target,'snapshot.json'),JSON.stringify(manifest,null,2));return manifest;
}

test('real v24 ownerless Bot/cron upgrade is idempotent and rollback restores a stopped snapshot [AC:schema-upgrade-safety#AC-1] [AC:schema-upgrade-safety#AC-2]', {timeout:180000}, async()=>{
 const temporary=mkdtempSync(join(tmpdir(),'bot-migration-rollback-'));
 const checkout=join(temporary,'old');const stateDir=join(temporary,'state');const dbFile=join(stateDir,'runtime.sqlite');
 try {
  assert.match(fixtureSql,new RegExp(REF));
  const {sha}=preparePinnedCheckout({sourceRoot:ROOT,checkout,sha:REF});assert.equal(sha,REF);linkDependencies(checkout);
  run(process.execPath,[join(ROOT,'node_modules/typescript/bin/tsc'),'-b','packages/core'],checkout);
  const oldModule=await import(pathToFileURL(join(checkout,'packages/core/dist/storage.js')).href);
  mkdirSync(stateDir,{recursive:true});const raw=new DatabaseSync(dbFile);loadSqlDump(raw,fixtureSql);
  assert.equal(getCurrentSchemaVersion(raw),24);
  raw.prepare("UPDATE sessions SET metadata_json=json_remove(metadata_json,'$.userId','$.tenantId') WHERE id=?").run(ids.bots.researcher.sessionId);
  raw.prepare('UPDATE bots SET hidden=1 WHERE id=?').run(ids.bots.planner.id);raw.close();
  mkdirSync(join(stateDir,'cron'));mkdirSync(join(stateDir,'transcripts'));
  const legacyJob={id:'legacy-cron',sessionId:ids.bots.researcher.sessionId,agentId:ids.bots.researcher.agentId,name:'legacy reminder',prompt:'preserve this instruction',scheduleKind:'once_at',scheduleValue:'2099-01-01T00:00:00.000Z',enabled:true,nextRunAt:'2099-01-01T00:00:00.000Z',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',metadata:{botId:ids.bots.researcher.id}};
  writeFileSync(join(stateDir,'cron/jobs.json'),JSON.stringify([legacyJob],null,2));writeFileSync(join(stateDir,'transcripts/legacy.txt'),'original private history archive\n');
  const oldBefore=new oldModule.SqliteStateStore(dbFile);assert.equal(oldBefore.getSession(ids.bots.researcher.sessionId).metadata.userId,undefined);assert.equal(oldBefore.getBot(ids.bots.planner.id).hidden,true);const originalMessages=oldBefore.listMessages(ids.bots.researcher.sessionId);oldBefore.db.close();
  const beforeDir=join(temporary,'before-upgrade');const beforeManifest=stoppedSnapshot(stateDir,beforeDir);

  const current=new SqliteStateStore(dbFile);const currentHost=host(current,stateDir);
  assert.equal(getCurrentSchemaVersion(current.db),LATEST_SCHEMA_VERSION);assert.equal(LATEST_SCHEMA_VERSION,29);
  assert.equal(current.getBot(ids.bots.planner.id).hidden,true);assert.deepEqual(current.listMessages(ids.bots.researcher.sessionId),originalMessages);
  const installation=openBot(currentHost,ids.bots.researcher.id);assert.equal(installation.sessionId,ids.bots.researcher.sessionId);assert.equal(current.getSession(installation.sessionId).metadata.userId,undefined);
  assert.throws(()=>openBot(currentHost,ids.bots.researcher.id,{userId:'new-login',tenantId:'new-tenant'}));
  assert.deepEqual(current.listMessages(installation.sessionId),originalMessages);
  assert.equal(current.listSessions().some(session=>session.metadata?.userId==='new-login'),false);
  assert.equal(current.agentMemory().search({scope:'user.memory',userId:'new-login',agentId:ids.bots.researcher.agentId,limit:50}).length,0);
  const other={sessionId:current.createSession({title:'post-upgrade',mode:'chat',agentId:ids.bots.researcher.agentId}).id};
  const oldCron=listCronJobs(currentHost,{botId:ids.bots.researcher.id});assert.equal(oldCron.length,1);assert.equal(oldCron[0].id,'legacy-cron');assert.equal(oldCron[0].prompt,legacyJob.prompt);assert.ok(oldCron[0].timezone);
  assert.equal(readFileSync(join(stateDir,'transcripts/legacy.txt'),'utf8'),'original private history archive\n');
  const job=createCronJob(currentHost,{sessionId:other.sessionId,name:'new interval',prompt:'new data that must be archived',intervalMs:60000,timezone:'Asia/Shanghai'});
  const occurrence=new RoutineRunStore(current).enqueue(job,new Date().toISOString());current.appendMessage(other.sessionId,'user',[{type:'text',text:'post-upgrade write'}]);
  const counts=Object.fromEntries(['sessions','session_messages','bots','bot_routine_runs'].map(table=>[table,current.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const migrations=current.db.prepare('SELECT version FROM schema_version ORDER BY version').all();const principal=current.getDaemonControl('bot.installationPrincipal');current.db.close();
  const reopened=new SqliteStateStore(dbFile);assert.deepEqual(reopened.db.prepare('SELECT version FROM schema_version ORDER BY version').all(),migrations);assert.equal(reopened.getDaemonControl('bot.installationPrincipal'),principal);
  for(const [table,count]of Object.entries(counts))assert.equal(reopened.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,count);
  assert.equal(new RoutineRunStore(reopened).get(occurrence.id).status,'queued');assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(),[]);reopened.db.close();

  // The pinned v24 binary refuses any newer schema. It cannot silently downgrade the candidate.
  const incompatibleHash=hash(dbFile);
  assert.throws(()=>new oldModule.SqliteStateStore(dbFile),new RegExp(`schema v${LATEST_SCHEMA_VERSION} is newer than supported v24.*No automatic downgrade is safe`));
  assert.equal(hash(dbFile),incompatibleHash);
  const postDir=join(temporary,'post-upgrade-archive');const postManifest=stoppedSnapshot(stateDir,postDir);
  const recoveryDir=join(temporary,'restored-v24');cpSync(beforeDir,recoveryDir,{recursive:true});
  assert.equal(hash(join(recoveryDir,'runtime.sqlite')),beforeManifest.database);assert.equal(hash(join(recoveryDir,'cron/jobs.json')),beforeManifest.cron);assert.equal(hash(join(recoveryDir,'transcripts/legacy.txt')),beforeManifest.transcript);
  const restored=new oldModule.SqliteStateStore(join(recoveryDir,'runtime.sqlite'));assert.equal(getCurrentSchemaVersion(restored.db),24);assert.deepEqual(restored.listMessages(ids.bots.researcher.sessionId),originalMessages);assert.equal(restored.getSession(other.sessionId),undefined);assert.equal(restored.getBot(ids.bots.planner.id).hidden,true);restored.db.close();
  assert.deepEqual(JSON.parse(readFileSync(join(recoveryDir,'cron/jobs.json'),'utf8')),[legacyJob]);
  const preserved=new SqliteStateStore(join(postDir,'runtime.sqlite'));assert.equal(new RoutineRunStore(preserved).get(occurrence.id).status,'queued');assert.ok(preserved.listMessages(other.sessionId).some(message=>JSON.stringify(message).includes('post-upgrade write')));preserved.db.close();
  assert.notEqual(beforeManifest.database,postManifest.database);assert.notEqual(beforeManifest.cron,postManifest.cron);
 } finally {
  if(existsSync(temporary))rmSync(temporary,{recursive:true,force:true});
 }
});
