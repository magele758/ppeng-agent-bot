#!/usr/bin/env node
/**
 * Read-only release-gate health report over recent CI runs (main + PRs): gate pass rate, most failing
 * jobs/steps, flaky unit tests (flaky-tests-* artifacts) and whether main's branch protection
 * requires "Release gate / Main release gate". Only uses `gh` GET calls and `gh run download`.
 *
 * Usage: pnpm run ci:gate-health [--limit 30] [--workflow ci.yml] [--branch main] [--repo owner/name]
 *        [--no-artifacts] [--json]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUICK_CHECK, GATE_CHECK, aggregateRuns, evaluateProtection, renderText, summarizeFlaky, summarizeRun } from './gate-health-lib.mjs';

function parseArgs(argv) {
  const args = { limit: 30, workflow: 'ci.yml', check: QUICK_CHECK, branch: 'main', repo: null, artifacts: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--workflow') args.workflow = argv[++i];
    else if (a === '--full') { args.workflow = 'full-validation.yml'; args.check = GATE_CHECK; }
    else if (a === '--branch') args.branch = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--no-artifacts') args.artifacts = false;
    else if (a === '--json') args.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  return args;
}

function gh(argList) {
  const r = spawnSync('gh', argList, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gh not available: ${r.error.message}`);
  const httpStatus = Number(/HTTP (\d{3})/.exec(r.stderr ?? '')?.[1] ?? 0) || null;
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, httpStatus };
}

function ghJson(argList) {
  const r = gh(argList);
  if (!r.ok) throw new Error(`gh ${argList.join(' ')} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

/** GET that tolerates 403/404: returns { status, body }. */
function ghApiSoft(endpoint) {
  const r = gh(['api', endpoint]);
  if (r.ok) return { status: 200, body: JSON.parse(r.stdout) };
  return { status: r.httpStatus ?? 0, body: null };
}

function loadFlakyReports(repo, runId, artifactNames) {
  const entries = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-health-'));
  try {
    for (const name of artifactNames) {
      const target = path.join(dir, name);
      const r = gh(['run', 'download', String(runId), '--repo', repo, '--name', name, '--dir', target]);
      if (!r.ok) continue;
      for (const file of fs.readdirSync(target)) {
        if (!file.endsWith('.json')) continue;
        try {
          entries.push({ runId, artifact: name, report: JSON.parse(fs.readFileSync(path.join(target, file), 'utf8')) });
        } catch {
          /* unreadable report: ignore */
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return entries;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;

  const runs = ghJson([
    'run', 'list', '--repo', repo, '--workflow', args.workflow, '--status', 'completed', '--limit', String(args.limit),
    '--json', 'databaseId,event,headBranch,conclusion,createdAt,displayTitle,url'
  ]);

  const summaries = [];
  const flakyEntries = [];
  for (const run of runs) {
    const { jobs } = ghJson(['api', `repos/${repo}/actions/runs/${run.databaseId}/jobs?per_page=100`]);
    summaries.push(summarizeRun(run, jobs, args.branch, args.check));
    if (args.artifacts) {
      const { artifacts } = ghJson(['api', `repos/${repo}/actions/runs/${run.databaseId}/artifacts?per_page=100`]);
      const names = artifacts.filter((a) => !a.expired && a.name.startsWith('flaky-tests-')).map((a) => a.name);
      if (names.length) flakyEntries.push(...loadFlakyReports(repo, run.databaseId, names));
    }
  }

  const branchSummary = ghApiSoft(`repos/${repo}/branches/${args.branch}`);
  const rules = ghApiSoft(`repos/${repo}/rules/branches/${args.branch}`);
  const protection = evaluateProtection({
    requiredCheck: QUICK_CHECK,
    protection: ghApiSoft(`repos/${repo}/branches/${args.branch}/protection`),
    branch: branchSummary.body,
    rules: rules.status === 200 ? rules.body : null
  });

  const dates = runs.map((r) => r.createdAt).sort();
  const report = {
    meta: { repo, check: args.check, workflow: args.workflow, branch: args.branch, runs: runs.length, from: dates[0] ?? null, to: dates.at(-1) ?? null },
    aggregate: aggregateRuns(summaries),
    flaky: args.artifacts ? summarizeFlaky(flakyEntries) : null,
    protection
  };
  console.log(args.json ? JSON.stringify(report, null, 2) : renderText(report));
}

try {
  main();
} catch (err) {
  console.error(`[gate-health] ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}
