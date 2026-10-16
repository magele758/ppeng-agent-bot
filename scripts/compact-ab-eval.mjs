#!/usr/bin/env node
/**
 * Live-model compact A/B: keep_recent vs after_text_assistant (same seeded
 * ls / git status / test-stack stdout). CI runs this only when repository
 * secrets include RAW_AGENT_API_KEY.
 *
 * Policy is written to daemon_control KV (same path as Lab). No new RAW_AGENT_*
 * feature switch. Does not print API keys or env dumps.
 *
 * COMPACT_AB_POLICIES=keep_recent,after_text_assistant
 * COMPACT_AB_CASES=silent
 * COMPACT_AB_OUT_DIR=/path  (writes compact-ab-report.json + .txt)
 */
import { compactRecallPassed } from './agent-eval/context-reliability.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../packages/core/dist/runtime.js';
import {
  formatRemoteEnvInspection,
  inspectRemoteEnv
} from '../packages/core/dist/model/remote-env.js';
import {
  resolveMicroCompactConfig,
  writeCompactSettings
} from '../packages/core/dist/session/compact-settings.js';
import { microCompactMessages } from '../packages/core/dist/session/micro-compact.js';
import {
  applyCompactAbSeedToStore,
  buildCompactAbSeed,
  followUpToolCalls,
  formatCompactAbReport,
  parseCaseList,
  parsePolicyList,
  previewCompactAbView,
  redactAnswerPreview,
  scoreRecall,
  seedToolName,
  summarizeCompactAbRuns,
  summarizeSeedTools
} from '../packages/core/dist/session/compact-ab-harness.js';

const provider = process.env.RAW_AGENT_MODEL_PROVIDER ?? 'heuristic';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} for compact-ab (${provider})`);
  }
  return value;
}

function dropTrailingAssistant(messages) {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  return last?.role === 'assistant' ? messages.slice(0, -1) : messages;
}

function usageFromSession(session) {
  const totals = session?.metadata?.usageTotals;
  if (!totals || typeof totals !== 'object') return undefined;
  return {
    inputTokens: Number(totals.inputTokens) || 0,
    outputTokens: Number(totals.outputTokens) || 0,
    totalTokens: Number(totals.totalTokens) || 0,
    requests: Number(totals.requests) || 0
  };
}

async function runOne(runtime, policy, caseId) {
  const seed = buildCompactAbSeed({ caseId });
  writeCompactSettings(runtime.store, {
    policy,
    keepRecent: policy === 'keep_recent' ? 3 : 0
  });
  const preview = previewCompactAbView(policy, seed);
  const started = Date.now();
  const session = runtime.createChatSession({
    title: `compact-ab ${policy} ${caseId}`,
    agentId: 'general',
    message: seed.firstUser
  });
  applyCompactAbSeedToStore(runtime.store, session.id, seed);
  runtime.sendUserMessage(session.id, seed.followUp);

  const row = {
    policy,
    caseId,
    token: seed.token,
    recalled: false,
    expectedTokenInView: preview.tokenInView,
    collapsed: preview.collapsed,
    charsSaved: preview.charsSaved,
    viewTokens: preview.tokens,
    baselineTokens: preview.baselineTokens,
    elapsedMs: 0,
    answerPreview: '',
    toolName: seedToolName(seed),
    stdoutSummary: summarizeSeedTools(seed)
  };

  try {
    await runtime.runSession(session.id);
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
    row.elapsedMs = Date.now() - started;
    return row;
  }

  const rec = runtime.store.getSession(session.id);
  const answer = runtime.getLatestAssistantText(session.id) ?? '';
  const folded = runtime.store.foldMessages(session.id);
  const live = microCompactMessages(
    dropTrailingAssistant(folded),
    resolveMicroCompactConfig({ store: runtime.store, env: process.env })
  );

  row.collapsed = live.stats.collapsed;
  row.charsSaved = live.stats.charsSaved;
  row.followUpTools = followUpToolCalls(runtime.store.foldMessages(session.id), seed.followUp);
  row.recalled = scoreRecall({ answer, token: seed.token, followUpTools: row.followUpTools });
  row.answerPreview = redactAnswerPreview(answer);
  row.usage = usageFromSession(rec);
  if (typeof rec?.metadata?.usageCostUsd === 'number') {
    row.costUsd = rec.metadata.usageCostUsd;
  }
  row.sessionStatus = rec?.status;
  row.elapsedMs = Date.now() - started;

  if (rec?.status === 'waiting_approval') {
    row.error = 'session waiting_approval';
  } else if (!answer.trim()) {
    row.error = 'empty assistant reply';
  }

  return row;
}

async function writeReport(report) {
  const outDir = process.env.COMPACT_AB_OUT_DIR?.trim();
  if (!outDir) return;
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'compact-ab-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'compact-ab-report.txt'), `${formatCompactAbReport(report)}\n`);
}

async function main() {
  if (provider === 'heuristic') {
    const report = {
      generatedAt: new Date().toISOString(),
      skipped: true,
      skipReason: 'RAW_AGENT_MODEL_PROVIDER=heuristic',
      runs: [],
      summary: summarizeCompactAbRuns([])
    };
    console.log(formatCompactAbReport(report));
    await writeReport(report);
    process.exitCode = 2; // Skipped is not a passing semantic evaluation.
    return;
  }

  if (provider === 'anthropic-compatible') {
    requireEnv('RAW_AGENT_API_KEY');
    requireEnv('RAW_AGENT_MODEL_NAME');
    requireEnv('RAW_AGENT_ANTHROPIC_URL');
  } else {
    requireEnv('RAW_AGENT_API_KEY');
    requireEnv('RAW_AGENT_MODEL_NAME');
    requireEnv('RAW_AGENT_BASE_URL');
  }

  // Third-party OpenAI-compatible APIs often reject response_format.
  if (!process.env.RAW_AGENT_USE_JSON_MODE?.trim()) {
    process.env.RAW_AGENT_USE_JSON_MODE = '0';
  }

  console.log('compact-ab: env', formatRemoteEnvInspection(inspectRemoteEnv(process.env)));

  const policies = parsePolicyList(process.env.COMPACT_AB_POLICIES);
  const cases = parseCaseList(process.env.COMPACT_AB_CASES);
  const repoRoot = mkdtempSync(join(tmpdir(), 'ppeng-compact-ab-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'ppeng-compact-ab-state-'));
  const runtime = new RawAgentRuntime({ repoRoot, stateDir });
  const adapterName = runtime.modelAdapter.name;

  const runs = [];
  try {
    for (const policy of policies) {
      for (const caseId of cases) {
        console.log(`compact-ab: running ${policy}/${caseId}`);
        runs.push(await runOne(runtime, policy, caseId));
      }
    }
  } finally {
    await runtime.destroy();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    adapter: adapterName,
    model: process.env.RAW_AGENT_MODEL_NAME,
    runs,
    summary: summarizeCompactAbRuns(runs)
  };

  console.log(formatCompactAbReport(report));
  await writeReport(report);

  if (!compactRecallPassed(report)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
