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

/** The pull-request token can read check-runs on this commit when run list --commit is empty. */
export function headRunsFromChecks(checkRuns, sha) {
  const gate = (checkRuns ?? []).find((run) => run.name === HEAD_GATE_CHECK);
  if (!gate) return [];
  return [{ conclusion: gate.conclusion, status: gate.status, headSha: sha }];
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

function checkRuns(repo, sha) {
  const text = gh(['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs`, '--jq', '.check_runs[] | {name,conclusion,status}']);
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha) throw new Error('GITHUB_REPOSITORY and GITHUB_SHA are required');
  const fields = 'databaseId,headSha,conclusion,status,event,url';
  const onMain = runs(['run', 'list', '--repo', repo, '--workflow', 'full-validation.yml', '--branch', 'main', '--limit', '30', '--json', fields]);
  const onHead = headRunsFromChecks(checkRuns(repo, sha), sha);
  const decision = mergeDecision(onMain, onHead);
  console.log(`[main-full-health] ${decision.ok ? 'pass' : 'fail'}: ${decision.reason}`);
  if (!decision.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
