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

function runs(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env: sanitizeScriptEnv() });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args[2] ?? ''} failed`);
  return JSON.parse(result.stdout || '[]');
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha) throw new Error('GITHUB_REPOSITORY and GITHUB_SHA are required');
  const fields = 'databaseId,headSha,conclusion,status,event,url';
  const onMain = runs(['run', 'list', '--repo', repo, '--workflow', 'full-validation.yml', '--branch', 'main', '--limit', '30', '--json', fields]);
  const onHead = runs(['run', 'list', '--repo', repo, '--workflow', 'full-validation.yml', '--commit', sha, '--limit', '10', '--json', fields]);
  const decision = mergeDecision(onMain, onHead);
  console.log(`[main-full-health] ${decision.ok ? 'pass' : 'fail'}: ${decision.reason}`);
  if (!decision.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
