#!/usr/bin/env node
/**
 * A/B release orchestrator — Stable/Candidate control plane.
 *
 * Usage:
 *   node scripts/release-orchestrator.mjs start [--run-id rel_...]
 *   node scripts/release-orchestrator.mjs git-sync
 *   node scripts/release-orchestrator.mjs gate-g0|gate-g1|gate-g2|gate-g3 --run-id ...
 *   node scripts/release-orchestrator.mjs deploy-candidate|promote|rollback|fix|observe|status
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { EVOLUTION_DISABLED_CODE, considerEvolutionSchedule } from '../packages/core/src/evolution/surface.ts';
import { createReleaseRunId, imageTagForRelease, loadReleaseConfig } from './release/config.mjs';
import { gitSync, currentGitSha } from './release/git-sync.mjs';
import {
  aggregateFromRunsJsonl,
  appendReportEvent,
  beginCandidateDeployment,
  createEmptyReport,
  loadReport,
  saveReport,
  setPhase
} from './release/report-builder.mjs';
import { runG0, runG1, runG2, runG3, bakeElapsedHours } from './release/gates.mjs';
import { runCodingAgent } from './release/coding-agent.mjs';
import * as composeBackend from './release/deploy-backend-compose.mjs';
import * as helmBackend from './release/deploy-backend-helm.mjs';
import { promoteWithSmoke, verifyCandidate } from './release/deploy-smoke-step.mjs';
import { sanitizeScriptEnv } from './spawn-utils.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: join(repoRoot, '.env') });

function backend(cfg) {
  return cfg.backend === 'helm' ? helmBackend : composeBackend;
}

function parseArgs(argv) {
  const out = { cmd: argv[0] ?? 'help', runId: null, force: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--run-id' && argv[i + 1]) out.runId = argv[++i];
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

function ensureReport(runId) {
  const id = runId || createReleaseRunId(repoRoot);
  let report = loadReport(repoRoot, id);
  if (!report) {
    report = createEmptyReport(id);
    saveReport(repoRoot, report);
  }
  return report;
}

async function cmdStart(args) {
  const cfg = loadReleaseConfig(repoRoot);
  if (!cfg.enabled) {
    console.error('release-orchestrator: EVOLUTION_RELEASE_ENABLED=0');
    process.exit(1);
  }
  const report = ensureReport(args.runId);
  console.log(`release-orchestrator: start ${report.release_run_id}`);

  const sync = gitSync({ repoRoot, remote: cfg.gitRemote, branch: cfg.gitBranch });
  appendReportEvent(report, 'git_sync', sync);
  if (!sync.ok) {
    report.outcome = 'backlog';
    saveReport(repoRoot, report);
    process.exit(1);
  }
  report.candidate.git_sha = sync.sha || currentGitSha(repoRoot);
  saveReport(repoRoot, report);

  const evolutionDecision = considerEvolutionSchedule({ reason: 'cli' });
  if (!cfg.skipEvolution && !evolutionDecision.started) {
    appendReportEvent(report, 'evolution', { code: EVOLUTION_DISABLED_CODE, skipped: true });
    console.error(`${EVOLUTION_DISABLED_CODE}: Evolution is hidden and will not run.`);
  } else if (!cfg.skipEvolution) {
    setPhase(report, 'learn');
    saveReport(repoRoot, report);
    const evArgs = cfg.evolutionArgs.split(/\s+/).filter(Boolean);
    const ev = spawnSync('node', ['scripts/evolution-cli.mjs', ...evArgs], {
      cwd: repoRoot,
      env: sanitizeScriptEnv({ ...process.env, EVOLUTION_AUTO_MERGE: '0' }),
      encoding: 'utf8',
      shell: false
    });
    appendReportEvent(report, 'evolution', { code: ev.status, tail: (ev.stderr || ev.stdout || '').slice(-2000) });
    const agg = aggregateFromRunsJsonl(repoRoot);
    report.inbox_items = agg.inbox_items;
    if (ev.status !== 0) {
      report.outcome = 'backlog';
      saveReport(repoRoot, report);
      process.exit(ev.status ?? 1);
    }
  }

  beginCandidateDeployment(report, {
    gitSha: currentGitSha(repoRoot),
    tags: { daemon: imageTagForRelease(report.release_run_id, 'daemon'), web: imageTagForRelease(report.release_run_id, 'web') }
  });
  setPhase(report, 'build');
  saveReport(repoRoot, report);
  const g0 = await runG0(repoRoot, report);
  saveReport(repoRoot, report);
  if (!g0.ok) {
    report.outcome = 'backlog';
    saveReport(repoRoot, report);
    process.exit(1);
  }

  if (!cfg.skipDeploy) {
    setPhase(report, 'deploy_candidate');
    const tagD = imageTagForRelease(report.release_run_id, 'daemon');
    const tagW = imageTagForRelease(report.release_run_id, 'web');
    report.candidate.image_tags = { daemon: tagD, web: tagW };
    saveReport(repoRoot, report);
    const dep = backend(cfg).deployCandidate(cfg, {
      releaseRunId: report.release_run_id,
      imageTagDaemon: tagD,
      imageTagWeb: tagW
    });
    appendReportEvent(report, 'deploy_candidate', dep);
    report.candidate.image_ids = dep.imageIds;
    report.candidate.image_refs = dep.imageRefs;
    saveReport(repoRoot, report);
    if (!dep.ok) {
      report.outcome = 'backlog';
      saveReport(repoRoot, report);
      process.exit(1);
    }
    const smoke = await verifyCandidate({ cfg, report, backend: backend(cfg) });
    saveReport(repoRoot, report);
    if (!smoke.ok) process.exit(1);
  }

  const g1 = await runG1(cfg, report);
  saveReport(repoRoot, report);
  if (!g1.ok) {
    report.outcome = 'backlog';
    saveReport(repoRoot, report);
    process.exit(1);
  }

  setPhase(report, 'observe');
  report.observation.bake_started_at = new Date().toISOString();
  saveReport(repoRoot, report);

  const g2 = await runG2(cfg, report);
  saveReport(repoRoot, report);
  if (!g2.ok) {
    if (cfg.fixMaxAttempts > 0) {
      await cmdFix({ runId: report.release_run_id });
      return;
    }
    const rollback = backend(cfg).rollbackCandidate(cfg);
    report.outcome = rollback.ok ? 'rolled_back' : 'backlog';
    appendReportEvent(report, 'rollback', rollback);
    saveReport(repoRoot, report);
    process.exit(1);
  }

  if (cfg.autoPromote) {
    await cmdPromote({ runId: report.release_run_id });
  } else {
    console.log('release-orchestrator: G2 pass — manual promote with: npm run release:promote -- --run-id', report.release_run_id);
  }
}

async function cmdFix(args) {
  const cfg = loadReleaseConfig(repoRoot);
  const report = loadReport(repoRoot, args.runId);
  if (!report) {
    console.error('report not found');
    process.exit(1);
  }
  setPhase(report, 'fix');
  const attempt = (report.fix_loops?.length ?? 0) + 1;
  if (attempt > cfg.fixMaxAttempts) {
    report.outcome = 'backlog';
    appendReportEvent(report, 'fix_exhausted', { attempt });
    backend(cfg).rollbackCandidate(cfg);
    saveReport(repoRoot, report);
    process.exit(1);
  }
  const fix = runCodingAgent({ repoRoot, task: `Fix release ${report.release_run_id} gate failures`, worktreeDir: repoRoot });
  report.fix_loops.push({ attempt, coding_agent: fix.agent, tests: fix.ok ? 'agent ok' : fix.detail.slice(0, 200) });
  saveReport(repoRoot, report);
  if (!fix.ok) {
    report.outcome = 'backlog';
    saveReport(repoRoot, report);
    process.exit(1);
  }
  const tags = {
    daemon: `${imageTagForRelease(report.release_run_id, 'daemon')}-fix-${attempt}`,
    web: `${imageTagForRelease(report.release_run_id, 'web')}-fix-${attempt}`
  };
  beginCandidateDeployment(report, { gitSha: currentGitSha(repoRoot), tags });
  saveReport(repoRoot, report);
  const g0 = await runG0(repoRoot, report);
  saveReport(repoRoot, report);
  if (!g0.ok) process.exit(1);
  if (cfg.skipDeploy) {
    appendReportEvent(report, 'fix_deploy_required', { reason: 'fixed source requires a fresh candidate deployment' });
    saveReport(repoRoot, report);
    process.exit(1);
  }
  const deployed = backend(cfg).deployCandidate(cfg, { releaseRunId: report.release_run_id, imageTagDaemon: tags.daemon, imageTagWeb: tags.web });
  appendReportEvent(report, 'fix_deploy_candidate', deployed);
  report.candidate.image_ids = deployed.imageIds;
  report.candidate.image_refs = deployed.imageRefs;
  saveReport(repoRoot, report);
  if (!deployed.ok) process.exit(1);
  const g1 = await runG1(cfg, report);
  saveReport(repoRoot, report);
  if (!g1.ok) process.exit(1);
  const g2 = await runG2(cfg, report);
  saveReport(repoRoot, report);
  if (!g2.ok) {
    await cmdFix({ runId: report.release_run_id });
  } else {
    report.observation.bake_started_at = new Date().toISOString();
    setPhase(report, 'observe');
    saveReport(repoRoot, report);
  }
}

async function cmdPromote(args) {
  const cfg = loadReleaseConfig(repoRoot);
  const report = loadReport(repoRoot, args.runId);
  if (!report) {
    console.error('report not found');
    process.exit(1);
  }
  // --force may shorten observation, never bypass failed/missing tests or artifact identity.
  const g3 = runG3({ ...cfg, bakeHours: args.force ? 0 : cfg.bakeHours }, report);
  saveReport(repoRoot, report);
  if (!g3.ok) {
    console.error('G3 not ready:', g3.failures.join('; '));
    process.exit(1);
  }
  setPhase(report, 'promote');
  const tags = report.candidate.image_tags;
  const res = await promoteWithSmoke({
    cfg,
    report,
    backend: backend(cfg),
    tags: {
      imageTagDaemon: tags.daemon,
      imageTagWeb: tags.web,
      imageIds: report.candidate.image_ids,
      imageRefs: report.candidate.image_refs
    }
  });
  saveReport(repoRoot, report);
  process.exit(res.ok ? 0 : 1);
}

async function cmdRollback(args) {
  const cfg = loadReleaseConfig(repoRoot);
  const report = loadReport(repoRoot, args.runId) || ensureReport(args.runId);
  setPhase(report, 'rollback');
  const res = backend(cfg).rollbackCandidate(cfg);
  report.outcome = res.ok ? 'rolled_back' : 'backlog';
  appendReportEvent(report, 'rollback', res);
  saveReport(repoRoot, report);
  process.exit(res.ok ? 0 : 1);
}

async function cmdObserve(args) {
  const cfg = loadReleaseConfig(repoRoot);
  const report = loadReport(repoRoot, args.runId);
  if (!report) {
    console.error('report not found');
    process.exit(1);
  }
  console.log(JSON.stringify({
    release_run_id: report.release_run_id,
    phase: report.phase,
    gates: report.gates,
    bake_hours: bakeElapsedHours(report),
    required_bake_hours: cfg.bakeHours
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadReleaseConfig(repoRoot);
  switch (args.cmd) {
    case 'start':
      await cmdStart(args);
      break;
    case 'git-sync': {
      const r = gitSync({ repoRoot, remote: cfg.gitRemote, branch: cfg.gitBranch });
      console.log(r);
      process.exit(r.ok ? 0 : 1);
    }
    case 'gate-g0': {
      const report = ensureReport(args.runId);
      const r = await runG0(repoRoot, report);
      saveReport(repoRoot, report);
      process.exit(r.ok ? 0 : 1);
    }
    case 'gate-g1': {
      const report = ensureReport(args.runId);
      const r = await runG1(cfg, report);
      saveReport(repoRoot, report);
      process.exit(r.ok ? 0 : 1);
    }
    case 'gate-g2': {
      const report = ensureReport(args.runId);
      const r = await runG2(cfg, report);
      saveReport(repoRoot, report);
      process.exit(r.ok ? 0 : 1);
    }
    case 'gate-g3': {
      const report = ensureReport(args.runId);
      const r = runG3(cfg, report);
      saveReport(repoRoot, report);
      process.exit(r.ok ? 0 : 1);
    }
    case 'deploy-candidate': {
      const report = ensureReport(args.runId);
      const tags = report.candidate.image_tags?.daemon
        ? report.candidate.image_tags
        : { daemon: imageTagForRelease(report.release_run_id, 'daemon'), web: imageTagForRelease(report.release_run_id, 'web') };
      beginCandidateDeployment(report, { gitSha: currentGitSha(repoRoot), tags });
      setPhase(report, 'deploy_candidate');
      saveReport(repoRoot, report);
      const r = backend(cfg).deployCandidate(cfg, {
        releaseRunId: report.release_run_id,
        imageTagDaemon: tags.daemon,
        imageTagWeb: tags.web
      });
      report.candidate.image_tags = tags;
      report.candidate.image_ids = r.imageIds;
      report.candidate.image_refs = r.imageRefs;
      appendReportEvent(report, 'deploy_candidate', r);
      saveReport(repoRoot, report);
      if (!r.ok) process.exit(1);
      const smoke = await verifyCandidate({ cfg, report, backend: backend(cfg) });
      saveReport(repoRoot, report);
      process.exit(smoke.ok ? 0 : 1);
    }
    case 'fix':
      await cmdFix(args);
      break;
    case 'promote':
      await cmdPromote(args);
      break;
    case 'rollback':
      await cmdRollback(args);
      break;
    case 'observe':
      await cmdObserve(args);
      break;
    case 'status': {
      const report = args.runId ? loadReport(repoRoot, args.runId) : null;
      if (report) console.log(JSON.stringify(report, null, 2));
      else console.log(JSON.stringify({ reports: (await import('./release/report-builder.mjs')).listReports(repoRoot) }, null, 2));
      break;
    }
    default:
      console.log(`Usage: node scripts/release-orchestrator.mjs <start|git-sync|gate-g0|gate-g1|gate-g2|gate-g3|deploy-candidate|fix|promote|rollback|observe|status> [--run-id ID] [--force]`);
      process.exit(args.cmd === 'help' ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
