import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createCacheBaseline, evaluateCacheWindows } from './magpie-cache-policy.mjs';
import { collectMagpieCacheSource } from './magpie-cache-source.mjs';

const windowMs = 30 * 60000;
// Leave time for the proxy and the local turn_end to both finish writing.
const settleMs = 5 * 60000;
const iso = time => Number.isFinite(time) ? new Date(time).toISOString() : null;

function publicWindow(stats) {
  if (!stats) return null;
  const { from, to, requests, input, cached, hitRequests, ratio, requestHitRatio } = stats;
  return {from:iso(from), to:iso(to), requests, input, cached, hitRequests, ratio, requestHitRatio};
}

function publicModels(models) {
  return models.map(model => ({
    provider:model.provider, model:model.model, status:model.status, incidentOpen:model.incidentOpen,
    lastValidAt:iso(model.lastValidAt ?? model.reference?.lastSampleAt),
    window:publicWindow(model.window), reference:publicWindow(model.reference),
  }));
}

function summaryAt(now, sourceStatus, models) {
  const validTimes = models.map(model => model.lastValidAt).filter(Boolean).sort();
  return {version:1, checkedAt:iso(now), lastValidAt:validTimes.at(-1) ?? null, sourceStatus, models};
}

function readState(db) {
  const row = db.prepare('SELECT data FROM monitor WHERE id = 1').get();
  return row && JSON.parse(row.data);
}

function getPending(db) {
  return db.prepare('SELECT data FROM event WHERE delivered IS NULL ORDER BY rowid').all().map(row => JSON.parse(row.data));
}

function save(db, record) {
  db.prepare('INSERT OR REPLACE INTO monitor(id,data) VALUES(1,?)').run(JSON.stringify(record));
}

function acknowledge(db, ids, now) {
  const mark = db.prepare('UPDATE event SET delivered = coalesce(delivered, ?) WHERE id = ?');
  for (const id of ids) {
    if (mark.run(now, id).changes !== 1) throw Error('Unknown monitor event ID');
  }
}

async function initialize(init, read, now) {
  if (!init) throw Error('Initialize the monitor with its reference time range first');
  const {from,to} = init;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to > now - settleMs) {
    throw Error('The reference range must end at least five minutes ago');
  }
  const data = await read(from, to);
  if (!data.coverage.sourceAvailable || data.coverage.incompleteIntervals.length) {
    throw Error('The reference range contains missing or unreadable usage evidence');
  }
  return {baseline:createCacheBaseline(data.records, {from,to}), policy:null, models:[]};
}

async function sample(record, read, now) {
  const origin = record.baseline.to;
  const from = record.policy?.cursor ?? origin;
  const to = origin + Math.floor((now - settleMs - origin) / windowMs) * windowMs;
  let data;
  try {
    // Even between closed windows, verify that the sources are accessible.
    data = await read(from, Math.max(to, from + 1));
  } catch {
    return {sourceStatus:'unavailable', events:[]};
  }
  if (!data.coverage.sourceAvailable) return {sourceStatus:'unavailable', events:[]};
  if (to <= from && record.policy) {
    return { sourceStatus: record.closedSourceStatus ?? 'ok', events: [] };
  }
  const gaps = data.coverage.incompleteIntervals.map(({startMs,endMs}) => ({from:startMs,to:endMs}));
  const result = evaluateCacheWindows(data.records, {
    baseline:record.baseline, state:record.policy ?? undefined, windowMs, now:Math.max(origin,to), coverageGaps:gaps,
  });
  record.policy = result.state;
  record.models = publicModels(result.models);
  record.closedSourceStatus = gaps.length ? 'incomplete' : 'ok';
  return {sourceStatus:record.closedSourceStatus, events:result.events};
}

export async function runMonitor({stateDir, magpieDir = join(homedir(), '.config', 'magpie'), now = Date.now(),
  init, ack, source = collectMagpieCacheSource}) {
  const directory = join(stateDir, 'monitoring');
  mkdirSync(directory, {recursive:true, mode:0o700});
  // This database is private to the monitor. No lock is taken on the Lab's live runtime database.
  const db = new DatabaseSync(join(directory, 'magpie-cache.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS monitor(id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event(id TEXT PRIMARY KEY, data TEXT NOT NULL, delivered INTEGER);
      BEGIN IMMEDIATE`);
    const read = (startMs,endMs) => source({magpieDir, traceDir:join(stateDir,'traces'), startMs,endMs, timeBasis:'completed'});
    const record = readState(db) ?? await initialize(init,read,now);
    if (init && (init.from !== record.baseline.from || init.to !== record.baseline.to)) {
      throw Error('The monitor already has a different reference range');
    }
    if (ack?.length) {
      acknowledge(db,ack,now);
    } else {
      const measured = await sample(record,read,now);
      const add = db.prepare('INSERT OR IGNORE INTO event(id,data) VALUES(?,?)');
      for (const event of measured.events) add.run(event.id,JSON.stringify(event));
      record.summary = summaryAt(now,measured.sourceStatus,record.models);
      save(db,record);
      const output = join(directory,'magpie-cache-summary.json');
      writeFileSync(output+'.tmp',JSON.stringify(record.summary)+'\n',{mode:0o600});
      renameSync(output+'.tmp',output);
    }
    const pending = getPending(db);
    db.exec('COMMIT');
    return {summary:record.summary,pending};
  } finally {
    db.close();
  }
}

async function main() {
  const {values,positionals} = parseArgs({allowPositionals:true,options:{
    'state-dir':{type:'string'}, 'magpie-dir':{type:'string'}, from:{type:'string'}, to:{type:'string'},
    id:{type:'string',multiple:true}, help:{type:'boolean'},
  }});
  if (values.help) {
    console.log('magpie-cache-monitor.mjs init --from ISO --to ISO | check | ack --id ID [--id ID] [--state-dir DIR] [--magpie-dir DIR]');
    return;
  }
  const [command] = positionals;
  if (positionals.length !== 1 || !['check','init','ack'].includes(command)) throw Error('Expected init, check or ack; see --help');
  if (command === 'ack' && !values.id?.length) throw Error('ack requires at least one --id');
  const result = await runMonitor({
    stateDir:resolve(values['state-dir'] ?? '.agent-state'), magpieDir:values['magpie-dir'],
    init:command === 'init' ? {from:Date.parse(values.from),to:Date.parse(values.to)} : undefined,
    ack:command === 'ack' ? values.id : undefined,
  });
  console.log(JSON.stringify(result,null,2));
  if (result.summary.sourceStatus === 'unavailable') process.exitCode=2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode=2; });
}
