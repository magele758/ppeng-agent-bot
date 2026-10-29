// A red full validation on main blocks the next merge. A successful full
// validation of this head still merges, so the fix for that red run is not stuck.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const SKIPPED = new Set(['cancelled', 'skipped', 'neutral']);

/** Newest completed run that was not superseded or skipped. */
export function decisive(runs) {
  for (const run of runs ?? []) {
    if (run.status && run.status !== 'completed') continue;
    if (SKIPPED.has(run.conclusion)) continue;
    return run;
  }
  return null;
}

export const HEAD_GATE_CHECK = 'Release gate / Main release gate';
const FULL_VALIDATION_WORKFLOW = 'full-validation.yml';

/** The pull-request token can read check-runs on this commit when run list --commit is empty. */
export function headRunsFromChecks(checkRuns, sha) {
  const gate = (checkRuns ?? []).find((run) => run.name === HEAD_GATE_CHECK);
  if (!gate) return [];
  return [{ conclusion: gate.conclusion, status: gate.status, headSha: sha }];
}

/** workflow_dispatch Full validation is an Actions run. A PR token may omit its check-run. */
export function headRunsFromActions(runs, sha) {
  const found = [];
  for (const run of runs ?? []) {
    const head = run.headSha ?? run.head_sha;
    if (head && head !== sha) continue;
    const path = String(run.path ?? '');
    const name = String(run.name ?? '');
    const full = path.endsWith(FULL_VALIDATION_WORKFLOW) || name === 'Full validation' || name === HEAD_GATE_CHECK;
    if (!full) continue;
    found.push({ conclusion: run.conclusion, status: run.status, headSha: sha, id: run.id });
  }
  return found;
}

/** Actions refuses to override GITHUB_SHA, so a pull request passes its head explicitly. */
export function resolveHeadSha(env = process.env) {
  return env.PR_HEAD_SHA || env.GITHUB_SHA || '';
}

export function mergeDecision(runsOnMain, headRuns) {
  const head = decisive(headRuns);
  if (head?.conclusion === 'success') return { ok: true, pending: false, reason: '这个版本自己的完整验证已经通过' };
  if ((headRuns ?? []).some((run) => run.status && run.status !== 'completed')) {
    return { ok: false, pending: true, reason: '这个版本的完整验证还在跑' };
  }
  const main = decisive(runsOnMain);
  if (!main) return { ok: false, pending: false, reason: '主分支还没有完成过的完整验证' };
  if (main.conclusion === 'success') return { ok: true, pending: false, reason: `主分支完整验证通过（${main.headSha ?? main.id ?? ''}）`.trim() };
  return {
    ok: false,
    pending: false,
    reason: `主分支完整验证是 ${main.conclusion}（${main.headSha ?? ''}）。在这个分支上手动跑一次 Full validation 并通过后才能合并。`.trim()
  };
}

/** In-progress release-gate checks or workflow runs. Completed skips are not activity. */
export function validationActivity(checkRuns, workflowRuns) {
  const running = [];
  for (const run of checkRuns ?? []) {
    if (!String(run.name ?? '').startsWith('Release gate /')) continue;
    if (run.status && run.status !== 'completed') running.push(run);
  }
  for (const run of workflowRuns ?? []) {
    if (run.status && run.status !== 'completed') running.push(run);
  }
  return running;
}

/** Keep polling while this head's full validation is still open, or for a short grace before it is registered. */
export function shouldKeepWaiting({ ok, pending, sawActivity, elapsedMs, graceMs }) {
  if (ok) return false;
  if (pending) return true;
  return !sawActivity && elapsedMs < graceMs;
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env: sanitizeScriptEnv() });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args[0]} failed`);
  return result.stdout;
}

function runs(args) {
  return JSON.parse(gh(args) || '[]');
}

function jsonLines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function checkRuns(repo, sha) {
  const text = gh(['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs[] | {name,conclusion,status}']);
  return jsonLines(text);
}

function workflowRuns(repo, sha, workflow) {
  const text = gh(['api', '--paginate', `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=20`, '--jq', '.workflow_runs[] | {name,path,event,conclusion,status,head_sha,id}']);
  return jsonLines(text);
}

const PR_RELEASE_WORKFLOW = 'pr-release-gate.yml';
const WAIT_GRACE_MS = 2 * 60 * 1000;
const WAIT_DEADLINE_MS = 55 * 60 * 1000;

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = resolveHeadSha();
  if (!repo || !sha) throw new Error('GITHUB_REPOSITORY and PR_HEAD_SHA (or GITHUB_SHA) are required');
  const fields = 'databaseId,headSha,conclusion,status,event,url';
  const started = Date.now();
  let sawActivity = false;
  let decision = { ok: false, pending: false, reason: '' };
  let checks = [];
  let flows = [];
  for (;;) {
    const onMain = runs(['run', 'list', '--repo', repo, '--workflow', FULL_VALIDATION_WORKFLOW, '--branch', 'main', '--limit', '30', '--json', fields]);
    checks = checkRuns(repo, sha);
    const full = workflowRuns(repo, sha, FULL_VALIDATION_WORKFLOW);
    const pr = workflowRuns(repo, sha, PR_RELEASE_WORKFLOW);
    flows = [...full, ...pr];
    const activity = validationActivity(checks, flows);
    if (activity.length) sawActivity = true;
    decision = mergeDecision(onMain, [...headRunsFromActions(full, sha), ...headRunsFromChecks(checks, sha)]);
    const pending = decision.pending || activity.length > 0;
    if (pending && !decision.ok) decision = { ...decision, pending: true, reason: decision.pending ? decision.reason : '这个版本的完整验证还在跑' };
    console.log(`[main-full-health] ${decision.ok ? 'pass' : pending ? 'wait' : 'fail'}: ${decision.reason}`);
    if (decision.ok) return;
    if (!shouldKeepWaiting({ ok: false, pending, sawActivity, elapsedMs: Date.now() - started, graceMs: WAIT_GRACE_MS }) || Date.now() - started > WAIT_DEADLINE_MS) break;
    spawnSync('sleep', ['30']);
  }
  console.log(`[main-full-health] head ${sha}: check-runs=${checks.length} action-runs=${flows.length}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
