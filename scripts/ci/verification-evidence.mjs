import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync, realpathSync, readlinkSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const pending = new Map();

function inputIdentity({ root, kind, environment, runId }) {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, env: sanitizeScriptEnv(), encoding: 'utf8', maxBuffer: 16e6, timeout: 10000
  });
  if (listed.status !== 0 || listed.error) throw new Error('Cannot establish verification evidence inputs');
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file).update('\0');
    try { digest.update(readFileSync(join(root, file))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; digest.update('<deleted>'); }
    digest.update('\0');
  }
  // Verifiers execute compiled JS and real installed dependencies, not just Git
  // source files. Recheck their bytes on every read; a matching lockfile alone
  // cannot prove that an ignored dist or installed module has not changed.
  const visited = new Set();
  const workspaceRoots = new Set();
  const artifacts = [join(root,'node_modules'),process.execPath];
  for (const group of ['packages','apps']) {
    let entries=[];
    try { entries=readdirSync(join(root,group),{withFileTypes:true}); } catch(error) { if(error.code!=='ENOENT')throw error; }
    for(const entry of entries.filter(e=>e.isDirectory())) {
      const workspace=join(root,group,entry.name);
      workspaceRoots.add(realpathSync(workspace));
      artifacts.push(join(workspace,'dist'),join(workspace,'node_modules'));
    }
  }
  function bind(path) {
    digest.update(path).update('\0');
    let stat;
    try { stat=lstatSync(path); } catch(error) { if(error.code!=='ENOENT')throw error; digest.update('<missing>');return; }
    if(stat.isSymbolicLink()) {
      digest.update(readlinkSync(path));
      const target=realpathSync(path);
      // Workspace source, dist and nested dependencies are already bound above;
      // traversing the entire workspace would also include generated reports.
      if(workspaceRoots.has(target))return;
      bind(target);return;
    }
    const real=realpathSync(path);
    if(visited.has(real))return;
    visited.add(real);
    if(stat.isDirectory())for(const name of readdirSync(path).sort())bind(join(path,name));
    else if(stat.isFile())digest.update(readFileSync(path));
    digest.update('\0');
  }
  for(const artifact of artifacts)bind(artifact);
  return sha(JSON.stringify({ schema: 1, root: resolve(root), kind, runId,
    node: process.versions, executable: process.execPath, platform: process.platform, arch: process.arch,
    environment: Object.fromEntries(Object.entries(environment ?? {}).filter(([, v]) => v !== undefined).sort()),
    source: digest.digest('hex') }));
}

function isPass(report) {
  return report?.status === 'pass' && report.completed !== false && report.restored !== false
    && (!report.scenarios || (report.scenarios.length > 0 && report.scenarios.every(s => s.status === 'pass')))
    && (!report.mutants || (report.mutants.length > 0 && report.mutants.every(m => m.killed && m.loaded !== false && m.sourceUnchanged !== false)));
}

async function acquireEvidenceLock(file) {
  const directory=`${file}.lock`, token=randomUUID(), started=Date.now();
  for (;;) {
    try {
      mkdirSync(directory,{mode:0o700});
      const ownerTemporary=join(directory,`${token}.tmp`);
      writeFileSync(ownerTemporary,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});
      renameSync(ownerTemporary,join(directory,'owner.json'));
      return () => {
        const owner=JSON.parse(readFileSync(join(directory,'owner.json'),'utf8'));
        if(owner.pid!==process.pid||owner.token!==token)throw new Error('Verification evidence lock ownership changed');
        rmSync(directory,{recursive:true});
      };
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      let owner;
      try {owner=JSON.parse(readFileSync(join(directory,'owner.json'),'utf8'));}
      catch(error){if(error.code!=='ENOENT')throw new Error('Verification evidence lock integrity failure');}
      if(owner){
        if(!Number.isInteger(owner.pid)||owner.pid<1||typeof owner.token!=='string')throw new Error('Verification evidence lock integrity failure');
        try{process.kill(owner.pid,0);}catch(error){if(error.code!=='EPERM')throw new Error('Verification evidence producer exited without completing');}
      }
      if(!owner&&Date.now()-started>5000)throw new Error('Verification evidence producer did not establish lock ownership');
      if(Date.now()-started>900000)throw new Error('Verification evidence lock timed out');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
}

/** Only canonical probes are reusable. Explicit subsets/faults/repetitions always execute. */
export async function withVerificationEvidence(context, execute) {
  const { root, kind, directory = process.env.CI_VERIFICATION_EVIDENCE_DIR,
    options = {}, environment = {}, runId = process.env.CI_VERIFICATION_RUN_ID,
    validate = isPass } = context;
  if (!directory || Object.keys(options).length) return execute();
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error('Invalid verification evidence kind');
  if (!runId) throw new Error('Verification evidence requires a candidate run identity');
  const identity = inputIdentity({ root, kind, environment, runId });
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${kind}-${identity}.json`);
  const event=type=>appendFileSync(join(directory,'events.jsonl'),JSON.stringify({type,kind,identity,pid:process.pid,at:Date.now()})+'\n',{mode:0o600});
  const key = resolve(file);
  if (pending.has(key)) {
    const report=await pending.get(key);
    if(report?.status==='pass'&&!validate(report))throw new Error('Verification evidence consumer rejected shared result');
    return structuredClone(report);
  }
  const operation = (async () => {
    const release=await acquireEvidenceLock(file);
    try {
    let contents;
    try { contents = readFileSync(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (contents !== undefined) {
      let record;
      try { record = JSON.parse(contents); } catch { throw new Error('Verification evidence integrity failure: invalid JSON'); }
      if (record.schema !== 1 || record.identity !== identity || record.kind !== kind || !record.report
        || sha(JSON.stringify(record.report)) !== record.digest || !isPass(record.report) || !validate(record.report)) {
        throw new Error('Verification evidence integrity failure: inputs/report mismatch');
      }
      if(inputIdentity({root,kind,environment,runId})!==identity)throw new Error('Verification evidence inputs changed during read');
      event('reuse');
      return record.report;
    }
    event('execute');
    const report = await execute();
    if (report?.status !== 'pass') return report;
    if (!isPass(report) || !validate(report)) throw new Error('Incomplete verification evidence cannot report pass');
    if (inputIdentity({ root, kind, environment, runId }) !== identity) throw new Error('Verification evidence inputs changed during probe');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, kind, identity,
        digest: sha(JSON.stringify(report)), report }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
    return report;
    } finally { release(); }
  })();
  pending.set(key, operation);
  try { return structuredClone(await operation); }
  finally { pending.delete(key); }
}

const median = values => { const sorted = [...values].sort((a,b) => a-b); const i = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[i] : (sorted[i-1]+sorted[i])/2; };
export function compareGateRuns(before, after) {
  const samples = [...before, ...after];
  const identity = r => JSON.stringify([r.candidate, r.environment, [...r.scope].sort()]);
  const valid = before.length >= 3 && after.length >= 3 && new Set(samples.map(r => r.id)).size === samples.length
    && samples.every(r => r.complete && r.candidate && r.environment && Array.isArray(r.scope) && r.scope.length
      && ['queueSeconds', 'executionSeconds', 'computeSeconds'].every(k => Number.isFinite(r[k]) && r[k] >= 0))
    && samples.every(r => identity(r) === identity(samples[0]));
  if (!valid) return { pass: false, reason: 'At least three distinct comparable complete runs per schedule are required' };
  const summary = rows => ({ queueSeconds: median(rows.map(r=>r.queueSeconds)), executionSeconds: median(rows.map(r=>r.executionSeconds)),
    computeSeconds: median(rows.map(r=>r.computeSeconds)), firstPassRate: rows.filter(r=>r.firstPass).length/rows.length });
  const baseline = summary(before), candidate = summary(after);
  const improvement = baseline.executionSeconds > 0 ? 1-candidate.executionSeconds/baseline.executionSeconds : 0;
  return { pass: improvement >= 0.3, improvement, baseline, candidate };
}

export function completeGateProtection(current) {
  const required = 'Release gate / Main release gate';
  return { ...current, contexts: [...new Set([...(current.contexts ?? []), required])],
    ...(current.checks ? { checks: [...current.checks.filter(c => c.context !== required), { context: required, app_id: 15368 }] } : {}) };
}
