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
  if (head?.conclusion === 'success') return { ok: true, reason: '这个版本自己的完整验证已经通过' };
  const main = decisive(runsOnMain);
  if (!main) return { ok: false, reason: '主分支还没有完成过的完整验证' };
  if (main.conclusion === 'success') return { ok: true, reason: `主分支完整验证通过（${main.headSha ?? main.id ?? ''}）`.trim() };
  return {
    ok: false,
    reason: `主分支完整验证是 ${main.conclusion}（${main.headSha ?? ''}）。在这个分支上手动跑一次 Full validation 并通过后才能合并。`.trim()
  };
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

function actionRuns(repo, sha) {
  const text = gh(['api', '--paginate', `repos/${repo}/actions/workflows/${FULL_VALIDATION_WORKFLOW}/runs?head_sha=${sha}&per_page=20`, '--jq', '.workflow_runs[] | {name,path,event,conclusion,status,head_sha,id}']);
  return jsonLines(text);
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = resolveHeadSha();
  if (!repo || !sha) throw new Error('GITHUB_REPOSITORY and PR_HEAD_SHA (or GITHUB_SHA) are required');
  const fields = 'databaseId,headSha,conclusion,status,event,url';
  const onMain = runs(['run', 'list', '--repo', repo, '--workflow', FULL_VALIDATION_WORKFLOW, '--branch', 'main', '--limit', '30', '--json', fields]);
  const fromChecks = headRunsFromChecks(checkRuns(repo, sha), sha);
  const fromActions = headRunsFromActions(actionRuns(repo, sha), sha);
  const decision = mergeDecision(onMain, [...fromActions, ...fromChecks]);
  console.log(`[main-full-health] ${decision.ok ? 'pass' : 'fail'}: ${decision.reason}`);
  if (!decision.ok) console.log(`[main-full-health] head ${sha}: check-runs=${fromChecks.length} action-runs=${fromActions.length}`);
  if (!decision.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
