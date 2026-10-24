#!/usr/bin/env node
/** Paired real-harness experiments. Live mode is explicit, bounded, isolated, and fail-closed. */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { hash, validateSuite, gradeTask, compareQuality } from './quality.mjs';
import { buildBotSuite, summarizeBaseline } from './bot-quality.mjs';
import { buildReliabilitySuite } from './bot-reliability.mjs';
import { runPairedTasks } from './paired-runner.mjs';
import { configuredModel } from './configured-model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--simulation') options.simulation = true;
  else if(arg === '--baseline-only') options.baselineOnly=true;
  else if (['--config', '--out', '--baseline-root', '--candidate-root', '--trials','--settings-root','--bot'].includes(arg) && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
  else throw new Error(`Unknown/incomplete option ${arg}`);
}
if (!options.config) throw new Error('Usage: compare.mjs --config experiment.json [--simulation] [--out directory] [--baseline-root path] [--candidate-root path] [--trials N]');
const experiment = JSON.parse(readFileSync(resolve(options.config), 'utf8'));
const suite = validateSuite(experiment.suite==='builtin:bot-reliability'?buildReliabilitySuite():experiment.suite==='builtin:bot-p0'?buildBotSuite():JSON.parse(readFileSync(resolve(root, experiment.suite), 'utf8')));
const trials = Number(options.trials ?? experiment.trials ?? 3);
if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('trials must be 1..20');
const concurrency=experiment.concurrency??1;
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('concurrency must be 1..4');
const limits = { timeoutMs: 90_000, maxModelCalls: 6, maxOutputTokens: 2048, maxInputChars: 100_000, maxTotalCalls: 500, ...experiment.limits };
for (const [key, value] of Object.entries(limits)) if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid limit ${key}`);
if (suite.length * trials * (options.baselineOnly?1:2) * limits.maxModelCalls > limits.maxTotalCalls) throw new Error('planned calls exceed maxTotalCalls; reduce cases/trials or explicitly budget the experiment');
if (limits.timeoutMs > 600_000 || limits.maxTotalCalls > 10_000 || limits.maxOutputTokens > 16_384) throw new Error('experiment exceeds hard safety limits');
const variants = {};
for (const label of ['baseline', 'candidate']) {
  const v = experiment[label];
  if (!v || typeof v !== 'object') throw new Error(`missing ${label} variant`);
  variants[label] = { ...v, repoRoot: resolve(root, options[`${label}-root`] ?? v.repoRoot ?? '.') };
  if (v.systemAppendix != null && typeof v.systemAppendix !== 'string') throw new Error('systemAppendix must be text');
  if (v.daemonControl != null && (typeof v.daemonControl !== 'object' || Array.isArray(v.daemonControl))) throw new Error('daemonControl must be an object');
  for (const key of Object.keys(v.daemonControl ?? {})) {
    if (!['loop_settings', 'compact_settings', 'memory_settings', 'skill_settings', 'dyn_tool_settings', 'discovery_settings', 'jev_settings', 'tool_exposure_settings'].includes(key)) throw new Error(`unsupported persisted experiment setting: ${key}`);
  }
  if (!options.simulation && v.simulationFault) throw new Error('simulationFault is forbidden in live eval');
  for (const key of Object.keys(v)) if (!['repoRoot', 'systemAppendix', 'daemonControl', 'simulationFault'].includes(key)) throw new Error(`unknown variant option ${key}`);
}
let model = experiment.model ?? { provider: 'openai-compatible' };
const configured=options['settings-root']&&!options.simulation?await configuredModel(options['settings-root'],options.bot??'ppeng-agent-core',root):undefined;
if(configured){model=configured.model;Object.assign(process.env,configured.env);console.log('Configured model: '+JSON.stringify(configured.selection));}
for (const key of Object.keys(model)) if (!['provider', 'apiKeyEnv', 'baseUrlEnv', 'nameEnv', 'name', 'baseUrl', 'httpKind', 'temperature','useJsonMode'].includes(key)) throw new Error(`unknown model option ${key}; secrets must use env references`);
if (model.temperature != null && (!Number.isFinite(model.temperature) || model.temperature < 0 || model.temperature > 2)) throw new Error('invalid temperature');
// Validate all policy fields before spending any model calls.
compareQuality(suite, [], { trials, policy: experiment.policy, simulation: Boolean(options.simulation) });
if (!options.simulation) loadDotenv({ path: join(root, '.env'), quiet: true });
if (!options.simulation && (!process.env[model.apiKeyEnv ?? 'RAW_AGENT_API_KEY'] || !(model.baseUrl ?? process.env[model.baseUrlEnv ?? 'RAW_AGENT_BASE_URL']) || !(model.name ?? process.env[model.nameEnv ?? 'RAW_AGENT_MODEL_NAME']))) {
  throw new Error('live evaluation requires configured model name, base URL and API key; use --simulation to verify infrastructure without model calls');
}
const env = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
if (!options.simulation) for (const key of [model.apiKeyEnv ?? 'RAW_AGENT_API_KEY', model.baseUrlEnv ?? 'RAW_AGENT_BASE_URL', model.nameEnv ?? 'RAW_AGENT_MODEL_NAME']) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid model environment reference: ${key}`);
  if (process.env[key]) env[key] = process.env[key];
}
// Fixed test isolation, not product feature flags. No .env or live Lab settings are modified.
Object.assign(env, { RAW_AGENT_AGENTS_SKILLS: '0', RAW_AGENT_E2E_ISOLATE: '1', RAW_AGENT_SELF_HEAL_AUTO_START: '0', RAW_AGENT_MAX_TURNS: String(limits.maxModelCalls) });

function identity(repo) {
  const git = args => spawnSync('git', ['-C', repo, ...args], { env: sanitizeScriptEnv(env), encoding: 'utf8' });
  const revision = git(['rev-parse', 'HEAD']);
  if (revision.status !== 0) throw new Error(`not a git checkout: ${repo}`);
  const blobs = [];
  function walk(dir) {
    if (!existsSync(dir)) throw new Error(`missing build: ${dir}; build this revision before evaluating`);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) blobs.push([path.slice(repo.length), hash(readFileSync(path).toString('base64'))]);
    }
  }
  for (const pkg of ['api-types', 'agent-loop', 'core']) walk(join(repo, 'packages', pkg, 'dist'));
  return { gitSha: revision.stdout.trim(), dirty: Boolean(git(['status', '--porcelain', '--untracked-files=no']).stdout.trim()),
    sourceDiffHash: hash(git(['diff', 'HEAD', '--', 'packages', 'apps/daemon']).stdout),
    buildHash: hash(blobs), lockHash: hash(readFileSync(join(repo, existsSync(join(repo,'pnpm-lock.yaml'))?'pnpm-lock.yaml':'package-lock.json'), 'utf8')) };
}

const identities = Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, identity(value.repoRoot)]));
const out = resolve(options.out ?? join(root, 'test-results', `harness-quality-${Date.now()}-${randomUUID().slice(0, 8)}`));
mkdirSync(dirname(out), { recursive: true }); mkdirSync(out); // Never overwrite an existing run.
const workspace = mkdtempSync(join(tmpdir(), 'ppeng-quality-'));
const records = [];
const driverHash=()=>hash(['compare.mjs','quality.mjs','quality-worker.mjs','bot-quality.mjs','configured-model.mjs','bot-reliability.mjs','paired-runner.mjs','completion-audit.mjs'].map(file=>readFileSync(join(root,'scripts/agent-eval',file),'utf8')));
const manifest = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version, simulation: Boolean(options.simulation),
  mode:options.baselineOnly?'baseline':'compare', selection:configured?.selection,
  suiteHash: hash(suite), experimentHash: hash(experiment), driverHash: driverHash(),
  trials, concurrency, limits, identities, variants, model, tasks: suite.map(({ id, category, critical }) => ({ id, category, critical: Boolean(critical) })) };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
writeFileSync(join(out,'suite.json'),JSON.stringify(suite,null,2),{mode:0o600});

async function run(task, trial, label) {
  const name = `${task.id}-${trial}-${label}`, trialWorkspace = join(workspace, name);
  mkdirSync(trialWorkspace);
  const input = join(trialWorkspace, 'input.json'), resultFile = join(out, `${name}.json`);
  writeFileSync(input, JSON.stringify({ task, trial, variant: variants[label], model, limits, workspace: trialWorkspace, simulation: Boolean(options.simulation) }), { mode: 0o600 });
  const execution = await new Promise(resolveResult => {
    const child = spawn(process.execPath, [join(root, 'scripts/agent-eval/quality-worker.mjs'), input, resultFile], {
      cwd: trialWorkspace, env: sanitizeScriptEnv(env), stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '', timedOut = false;
    child.stdout.on('data', data => { log = (log + data).slice(-8000); });
    child.stderr.on('data', data => { log = (log + data).slice(-8000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limits.timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolveResult({ error: error.message }); });
    child.once('exit', code => { clearTimeout(timer); resolveResult({ code, timedOut, log }); });
  });
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, 'utf8'));
    if (execution.code !== 0 || execution.timedOut) result={...result,error:execution.timedOut?'trial timed out':'worker failed',infrastructureError:true,status:'error'};
  } catch (error) {
    result = { error: error.message, infrastructureError: true, status: 'error', durationMs: limits.timeoutMs, tokens: null };
  }
  const grade = gradeTask(task, result);
  const record = { caseId: task.id, category: task.category, variant: label, trial, ...result, ...grade };
  writeFileSync(resultFile, JSON.stringify(record, null, 2), { mode: 0o600 });
  records.push(record);
  console.log(`${task.id} trial=${trial + 1} ${label}: ${grade.pass ? 'pass' : 'FAIL'} (${result.durationMs}ms)`);
}

try {
  await runPairedTasks(suite,{trials,concurrency,baselineOnly:options.baselineOnly},run);
  const report = options.baselineOnly?summarizeBaseline(suite,records,{trials,simulation:Boolean(options.simulation)}):compareQuality(suite, records, { trials, policy: experiment.policy, simulation: Boolean(options.simulation) });
  const interventions = label => ({ systemAppendix: variants[label].systemAppendix ?? '', daemonControl: variants[label].daemonControl ?? {}, simulationFault: variants[label].simulationFault });
  report.control = identities.baseline.buildHash === identities.candidate.buildHash && hash(interventions('baseline')) === hash(interventions('candidate'));
  if (report.control) report.promotionEligible = false; // A/A calibrates noise; it cannot certify a new intervention.
  if(driverHash()!==manifest.driverHash){report.invalid.push('evaluation driver changed during run');report.verdict='invalid';report.promotionEligible=false;}
  for (const [label, variant] of Object.entries(variants)) if (identity(variant.repoRoot).buildHash !== identities[label].buildHash) {
    report.invalid.push(`${label} build changed while evaluation was running`); report.verdict = 'invalid'; report.promotionEligible = false;
  }
  const liveModels = records.map(r => r.model).filter(Boolean);
  if (!options.simulation && (liveModels.length !== records.length || new Set(liveModels.map(m => hash(m))).size !== 1)) {
    report.invalid.push('missing or inconsistent model identity'); report.verdict = 'invalid'; report.promotionEligible = false;
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(out,'evidence-index.json'),JSON.stringify(Object.fromEntries(readdirSync(out).filter(f=>f.endsWith('.json')).map(f=>[f,hash(readFileSync(join(out,f),'utf8'))])),null,2));
  const md = [ '# Harness quality comparison', '', `Verdict: **${report.verdict}**; promotion eligible: **${report.promotionEligible}**.`,
    `Evaluation: ${report.evaluationKind}. Distinct tasks: ${suite.length}; trials per variant: ${trials}.`, '',
    '| Category | Baseline pass | Candidate pass | All-trials reliability delta interval |', '|---|---:|---:|---|',
    ...Object.entries(report.byCategory).map(([key, value]) => value ? `| ${key} | ${(value.baselinePassRate * 100).toFixed(1)}% | ${(value.candidatePassRate * 100).toFixed(1)}% | ${value.deltaInterval.map(x => (x * 100).toFixed(1) + '%').join(' … ')} |` : `| ${key} | unavailable | unavailable | incomplete |`),
    '', '## Gate reasons', '', ...[...report.invalid, ...report.regressions, ...report.blockers, ...report.uncertain].map(reason => `- ${reason}`), '',
    'Repeated trials measure stability; they do not multiply the number of independent tasks. Intervals are approximate and apply only to this task distribution.',
    'Simulation verifies the evaluator and harness wiring only. It never establishes model quality or authorizes promotion.', '' ].join('\n');
  writeFileSync(join(out, 'report.md'), md + (options.baselineOnly ? '\nBaseline: '+report.passed+'/'+report.samples+' passed; infrastructure failures: '+report.infrastructureFailures+'; trials missing usage: '+report.missingUsageTrials+'.\n\n'+report.cases.map(r=>'- '+r.caseId+': '+(r.pass?'PASS':'FAIL')+'; '+r.failures.join('; ')).join('\n')+'\n' : ''));
  console.log(`\n${report.verdict}: ${out}/report.md`);
  process.exitCode = options.baselineOnly ? (report.invalid.length?2:report.failed?1:0) : options.simulation ? (report.invalid.length || report.regressions.length || report.blockers.length ? 1 : 0)
    : report.promotionEligible ? 0 : ['regressed', 'blocked'].includes(report.verdict) ? 1 : 2;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
