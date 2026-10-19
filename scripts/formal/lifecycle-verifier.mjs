import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { withVerificationEvidence } from '../ci/verification-evidence.mjs';
import { MUTATIONS } from './lifecycle-mutations.mjs';
export { SCOPE, exploreLifecycleModel, replayLifecycle } from './lifecycle-model.mjs';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = source => createHash('sha256').update(source).digest('hex');
const env = () => sanitizeScriptEnv({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, CI_VERIFICATION_EVIDENCE_DIR: process.env.CI_VERIFICATION_EVIDENCE_DIR, CI_VERIFICATION_RUN_ID: process.env.CI_VERIFICATION_RUN_ID });
let built = false;
function build() {
  if (built) return;
  const ts = JSON.parse(readFileSync(join(ROOT, 'node_modules/typescript/package.json'), 'utf8'));
  if (ts.version !== '5.9.3') throw new Error('TypeScript 5.9.3 required; npm ci');
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-b', 'packages/core'], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 60000, maxBuffer: 4e6 });
  if (r.error || r.status !== 0) throw new Error(`Fresh build failed: ${r.error?.message ?? r.stdout + r.stderr}`);
  built = true;
}
export async function verifyRuntime(options = {}) {
  build();
  return withVerificationEvidence({root:ROOT,kind:'lifecycle-runtime',options,environment:env(),validate:r=>r.completed===true&&r.scenarios?.length===20&&new Set(r.scenarios.map(s=>s.name)).size===20&&r.scenarios.every(s=>s.status==='pass'&&s.checks?.length&&s.checks.every(c=>c.ok===true)&&s.snapshots?.length&&s.events?.length)}, () => executeRuntime(options));
}
async function executeRuntime({ mutation } = {}) {
  build();
  const args = ['--import', join(ROOT, 'scripts/formal/lifecycle-register.mjs'), join(ROOT, 'scripts/formal/lifecycle-runtime.mjs')];
  if (mutation) args.push('--mutation', mutation);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 45000, maxBuffer: 8e6 });
  if (r.error || r.signal) throw new Error(`Runtime probe incomplete: ${r.error?.message ?? r.signal}`);
  let report;
  try { report = JSON.parse(r.stdout); } catch { throw new Error(`No runtime evidence: ${r.stderr.slice(-1600)}`); }
  if (!report.completed || !report.scenarios?.length || ![0, 1].includes(r.status)) throw new Error(`Runtime probe incomplete: ${JSON.stringify(report)}`);
  if (mutation && !r.stderr.includes(`LIFECYCLE_MUTATION_LOADED:${mutation}`)) throw new Error('Mutation did not load');
  return report;
}
export async function verifyLifecycleMutations() {
  build();
  return withVerificationEvidence({root:ROOT,kind:'lifecycle-mutations',environment:env(),validate:r=>r.restored===true&&r.baselineStatus==='pass'&&JSON.stringify(r.mutants?.map(m=>m.name))===JSON.stringify(Object.keys(MUTATIONS))&&r.mutants.every(m=>m.killed&&m.before!==m.after&&m.counterexample?.status==='fail')}, () => executeLifecycleMutations());
}
async function executeLifecycleMutations() {
  const baseline = await verifyRuntime({ fresh: true }), mutants = [];
  for (const [name, patch] of Object.entries(MUTATIONS)) {
    const source = readFileSync(join(ROOT, patch.file), 'utf8');
    if (source.split(patch.from).length !== 2) throw new Error(`Mutation anchor drift: ${name}`);
    const mutated = await verifyRuntime({ mutation: name });
    const counterexample = mutated.scenarios.find(row => row.status === 'fail' && baseline.scenarios.find(b => b.name === row.name)?.status === 'pass');
    mutants.push({ name, file: patch.file, before: sha(source), after: sha(source.replace(patch.from, patch.to)), killed: !!counterexample, counterexample });
  }
  const restored = JSON.stringify(baseline) === JSON.stringify(await verifyRuntime({ fresh: true }));
  return { status: restored && mutants.every(x => x.killed) ? 'pass' : 'fail', restored, baselineStatus: baseline.status, mutants };
}
export function checkLifecycleReview({ read = path => readFileSync(path, 'utf8') } = {}) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'specs/formal/lifecycle-review.json'), 'utf8'));
  const required = manifest.mapping.flatMap(x => x.files);
  const changed = [...new Set([...required, ...Object.keys(manifest.sha256)])].filter(path => {
    try { return sha(read(join(ROOT, path))) !== manifest.sha256[path]; } catch { return true; }
  });
  return { status: changed.length ? 'needs-review' : 'reviewed', changed, mapping: manifest.mapping };
}
export function runLifecycleProcess({ executable = process.execPath, worker = join(ROOT, 'scripts/formal/lifecycle-worker.mjs'), timeoutMs = 180000 } = {}) {
  const r = spawnSync(executable, [worker], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 12e6 });
  if (r.error || r.signal) return { status: 'incomplete', exitCode: 2, reason: r.error?.message ?? r.signal };
  try {
    const report = JSON.parse(r.stdout);
    if (report.schema !== 1 || !['pass', 'fail', 'incomplete'].includes(report.status)) throw new Error('Invalid report');
    if (report.status !== 'incomplete' && (!report.model || !report.runtime || !report.mutations || !report.review || !report.negativeControls)) throw new Error('Missing stages');
    if (report.status === 'pass' && (!report.model.exhausted || !report.runtime.completed || !report.mutations.restored || [report.model, report.runtime, report.mutations].some(x => x.status !== 'pass') || report.review.status !== 'reviewed' || report.negativeControls.length !== 3 || report.negativeControls.some(x => x.result.status !== 'fail'))) throw new Error('False pass report');
    const exitCode = report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 2;
    if (r.status !== exitCode) throw new Error('Exit/report mismatch');
    return { ...report, exitCode };
  } catch (error) { return { status: 'incomplete', exitCode: 2, reason: `${error.message}; ${r.stderr.slice(-1000)}` }; }
}
