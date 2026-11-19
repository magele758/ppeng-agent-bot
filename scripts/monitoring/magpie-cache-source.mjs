import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const usageName = /^usage(?:[.-](?:\d{4}-\d{2}-\d{2}|\d+))?\.jsonl(?:\.(?:\d{4}-\d{2}-\d{2}|\d+))?(?:\.gz)?$/;
const num = value => Number.isSafeInteger(value) && value >= 0;
const label = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

function statistics() {
  return {
    sourceAvailable: true, incompleteIntervals: [], usageFiles: 0, traceFiles: 0, bytesRead: 0,
    rawInWindow: 0, successfulProxyRequests: 0, traceTurns: 0, traceWithId: 0,
    attributed: 0, matched: 0, unmatched: 0, invalid: 0, duplicates: 0, duplicateTraceIds: 0, ambiguous: 0,
    unattributedUsage: { missingId:0, unmatchedId:0 },
    matchedExcluded: { invalidUsage: 0, missingModel: 0, ambiguous: 0, unsuccessful: 0, zeroInput: 0 },
  };
}

function gap(context, reason, time) {
  const { startMs, endMs, coverage } = context;
  if (Number.isFinite(time) && (time < startMs || time >= endMs)) return;
  const start = Number.isFinite(time) ? time : startMs;
  const end = Number.isFinite(time) ? Math.min(time+1,endMs) : endMs;
  context.gaps.set(reason+':'+start+':'+end,{startMs:start,endMs:end,reason});
  if (!Number.isFinite(time)) coverage.sourceAvailable = false;
}

function readJson(line, context, reason, time) {
  try { return JSON.parse(line); } catch {
    context.coverage.invalid++;
    gap(context,reason,time);
    return undefined;
  }
}

// The archive may contain replayed entries in non-chronological order. Date ranges filter rows, never terminate a file scan early.
async function readLines(file, consume, coverage) {
  const raw = createReadStream(file);
  const stream = file.endsWith('.gz') ? createGunzip() : raw;
  // Propagate both input and decompressor failures to this scan.
  const pumping = stream !== raw ? pipeline(raw,stream) : undefined;
  pumping?.catch(() => {});
  const lines = createInterface({input:stream, crlfDelay:Infinity});
  try {
    for await (const line of lines) if (line.trim()) consume(line);
    await pumping;
  } finally {
    coverage.bytesRead += raw.bytesRead;
    lines.close();
    raw.destroy();
    if (stream !== raw) stream.destroy();
  }
}

async function scanFile(file, type, consume, context, includeClosed = false) {
  try {
    const info = await stat(file);
    // Both producers append after a request starts; a file already closed before the interval cannot contain it.
    if (!includeClosed && info.mtimeMs < context.startMs) return;
    context.coverage[type === 'usage' ? 'usageFiles' : 'traceFiles']++;
    await readLines(file, consume, context.coverage);
  } catch (error) {
    if (type === 'trace' && error.code === 'ENOENT') return; // A directory without a trace has no terminal events.
    gap(context, type+'ReadError');
  }
}

function within(time, {startMs,endMs}) {
  return startMs <= time && time < endMs;
}

function billable(payload) {
  const usage = payload?.usage;
  if (payload?.costUsd > 0) return true;
  return usage && ['inputTokens','outputTokens','totalTokens','cachedInputTokens'].some(key => Number.isFinite(usage[key]) && usage[key] > 0);
}

function traceLine(line, context, session) {
  // Most trace bytes contain tool output. Ignore them without parsing the payload.
  const header = line.slice(0,512);
  const kind = /"kind"\s*:\s*"([^"]+)"/.exec(header)?.[1];
  if (kind && kind !== 'turn_end') return;
  const hint = timestamp(/"ts"\s*:\s*"([^"]+)"/.exec(header)?.[1]);
  const event = readJson(line,context,'invalidTraceJson',hint);
  if (event?.kind !== 'turn_end') return;
  const time = timestamp(event.ts), payload = event.payload;
  if (['heuristic','mock-llm'].includes(payload?.servedBy?.adapter)) return;
  const billed = Boolean(billable(payload));
  const id = label(payload?.requestId);
  if (!Number.isFinite(time)) {
    if (billed || id) { context.coverage.invalid++; gap(context,'invalidTraceTime'); }
    return;
  }
  const active = within(time,context);
  if (active) {
    context.coverage.traceTurns++;
    if (id) context.coverage.traceWithId++;
    else if (billed) {
      context.coverage.unattributedUsage.missingId++;
      gap(context,'billableTraceWithoutId',time);
    }
  }
  // The SDK may omit usage on a streamed response. An exact ID still identifies Magpie’s billing record.
  if (!id) return;
  // Pick the earliest completion for duplicate terminal events in this session, including duplicates across a window boundary.
  if (!context.traces.has(id)) context.traces.set(id,new Map());
  const owners = context.traces.get(id);
  const previous = owners.get(session);
  if (previous) {
    if (active) context.coverage.duplicateTraceIds++;
    previous.time = Math.min(previous.time,time);
    previous.billed ||= billed;
    return;
  }
  owners.set(session,{session,time,billed});
}

function relevantTraces(context) {
  for (const [id, owners] of context.traces) {
    const times = [...owners.values()];
    const relevant = context.timeBasis === 'completed'
      ? times.some(trace => within(trace.time,context)) : times.some(trace => trace.time >= context.startMs);
    if (!relevant) context.traces.delete(id);
  }
}

function hasTracedId(line, ids) {
  // Use the native flat usage schema to seek a completed request among older, out-of-order starts.
  const fields = /"(?:rid|response_id)"\s*:\s*("(?:\\.|[^"\\])*")/g;
  for (const match of line.matchAll(fields)) {
    let id;
    try { id = JSON.parse(match[1]); } catch { continue; }
    if (ids.has(id)) return true;
  }
  return false;
}

function proxyLine(line, context) {
  const { coverage } = context;
  const hint = timestamp(/"t"\s*:\s*"([^"]+)"/.exec(line.slice(0,512))?.[1]);
  if (Number.isFinite(hint) && !within(hint,context) && !hasTracedId(line,context.traces)) return;
  const row = readJson(line,context,'invalidProxyJson',hint);
  if (row === undefined) return;
  const time = timestamp(row?.t);
  if (!Number.isFinite(time)) {
    coverage.invalid++;
    gap(context,'invalidProxyTime');
    return;
  }
  const active = within(time,context);
  if (active) coverage.rawInWindow++;
  const aliases = [...new Set([label(row.rid),label(row.response_id)].filter(Boolean))].sort();
  const owners = new Map();
  for (const id of aliases) {
    const found = context.traces.get(id);
    if (!found) continue;
    context.found.add(id);
    for (const [session,trace] of found) {
      if (!owners.has(session) || trace.time < owners.get(session).time) owners.set(session,trace);
    }
  }
  if (!active && !owners.size) return;
  // A distinct attempt with a reused ID is ambiguous. Only identical billing/identity metadata can represent archive copies.
  const signature = JSON.stringify([time,row.status,row.route_id,aliases,row.provider,row.served,row.model,row.in,row.cache_read,row.cache_write,row.out,row.ms]);
  if (context.proxySignatures.has(signature)) {
    if (active || owners.size) coverage.duplicates++;
    return;
  }
  context.proxySignatures.add(signature);
  if (active && row.status >= 200 && row.status < 300) coverage.successfulProxyRequests++;
  const record = {time, active, provider:label(row.provider), model:label(row.served) ?? label(row.model),
    status:row.status, fresh:row.in, cached:row.cache_read, written:row.cache_write, owners, collision:false};
  context.proxy.push(record);
  for (const id of aliases.filter(x => context.traces.has(x))) {
    const previous = context.byId.get(id);
    if (previous) { previous.collision = true; record.collision = true; }
    else context.byId.set(id,record);
  }
}

function exclusion(row) {
  if (row.collision || row.owners.size > 1) return 'ambiguous';
  if (!Number.isInteger(row.status)) return 'invalidUsage';
  if (row.status < 200 || row.status >= 300) return 'unsuccessful';
  if (!row.provider || !row.model) return 'missingModel';
  if (![row.fresh,row.cached,row.written,row.fresh+row.cached+row.written].every(num)) return 'invalidUsage';
  if (row.fresh+row.cached+row.written === 0) return 'zeroInput';
  return undefined;
}

function summarize(context) {
  const { coverage } = context;
  const records = [];
  for (const [id, owners] of context.traces) {
    if (context.found.has(id)) continue;
    for (const trace of owners.values()) {
      if (trace.billed && within(trace.time,context)) {
        coverage.unattributedUsage.unmatchedId++;
        gap(context,'billableTraceUnmatched',trace.time);
      }
    }
  }
  for (const row of context.proxy) {
    if (!row.owners.size) {
      coverage.unmatched++;
      continue;
    }
    const ownerTimes = [...row.owners.values()].map(trace => trace.time);
    const times = context.timeBasis === 'completed' ? ownerTimes.filter(time => within(time,context)) : row.active ? [row.time] : [];
    if (!times.length) continue;
    coverage.attributed++;
    const reason = exclusion(row);
    if (reason) {
      coverage.matchedExcluded[reason]++;
      if (reason === 'ambiguous') coverage.ambiguous++;
      if (reason === 'invalidUsage' || reason === 'missingModel') coverage.invalid++;
      if (!['unsuccessful','zeroInput'].includes(reason)) for (const time of times) gap(context,reason,time);
      continue;
    }
    coverage.matched++;
    records.push({time:times[0], provider:row.provider, model:row.model, input:row.fresh+row.cached+row.written, cached:row.cached});
  }
  coverage.incompleteIntervals = [...context.gaps.values()].sort((a,b) => a.startMs-b.startMs);
  return {records:records.sort((a,b) => a.time-b.time), coverage};
}

/** Use proxy start for historical audits or the exact local turn completion for polling independent, half-open windows. */
export async function collectMagpieCacheSource({
  magpieDir = join(homedir(),'.config','magpie'),
  traceDir = resolve(process.env.RAW_AGENT_STATE_DIR || '.agent-state','traces'),
  startMs, endMs, timeBasis = 'start',
}) {
  if (![startMs,endMs].every(Number.isSafeInteger) || startMs >= endMs) throw new RangeError('Invalid cache collection interval');
  if (!['start','completed'].includes(timeBasis)) throw new RangeError('Invalid cache time basis');
  const context = {startMs,endMs,timeBasis, coverage:statistics(), gaps:new Map(), proxy:[], byId:new Map(), proxySignatures:new Set(), traces:new Map(), found:new Set()};
  let sessions;
  try { sessions = await readdir(traceDir,{withFileTypes:true}); } catch {
    gap(context,'missingTraceDirectory');
    sessions = [];
  }
  for (const folder of sessions) {
    if (!folder.isDirectory()) continue;
    await scanFile(join(traceDir,folder.name,'events.jsonl'),'trace',line => traceLine(line,context,folder.name),context);
  }
  relevantTraces(context);
  let usageFiles;
  try { usageFiles = (await readdir(magpieDir,{withFileTypes:true})).filter(entry => entry.isFile() && usageName.test(entry.name)); }
  catch { usageFiles = []; }
  if (!usageFiles.length) gap(context,'missingUsageLog');
  for (const entry of usageFiles) await scanFile(join(magpieDir,entry.name),'usage',line => proxyLine(line,context),context,context.traces.size > 0);
  return summarize(context);
}
