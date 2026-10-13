#!/usr/bin/env node
/** Produce an inspectable context-specific result inventory. Never starts paid model calls. */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { buildContextSuite, summarizeContextEvidence } from './agent-eval/context-reliability.mjs';
import { hash, gradeTask } from './agent-eval/quality.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (!['--out', '--results'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: context-reliability-eval.mjs --out DIRECTORY [--results QUALITY_RUN_DIRECTORY]');
  options[args[i].slice(2)] = args[++i];
}
if (!options.out) throw new Error('--out is required');
config({ path: join(root, '.env'), quiet: true });
const suite = buildContextSuite();
let records = [], manifest, results, comparison;
if (options.results) {
  results = resolve(options.results);
  comparison = JSON.parse(readFileSync(join(results, 'report.json'), 'utf8'));
  manifest = JSON.parse(readFileSync(join(results, 'manifest.json'), 'utf8'));
  if (manifest.suiteHash !== hash(suite)) throw new Error('suite fingerprint mismatch');
  records = readdirSync(results).filter(name => /-\d+-candidate\.json$/.test(name))
    .map(name => {
      const row = JSON.parse(readFileSync(join(results, name), 'utf8'));
      const task = suite.find(c => c.id === row.caseId);
      return { ...row, ...(task ? gradeTask(task, row) : {}), evidenceFile: name };
    });
}
const summary = summarizeContextEvidence(suite, records, { trials: manifest?.trials ?? 3, simulation: manifest?.simulation ?? false, invalidReasons: comparison?.invalid ?? [] });
const report = { generatedAt: new Date().toISOString(), suiteHash: hash(suite), ...summary,
  sourceRun: results ?? null,
  liveConfiguration: { apiKeyPresent: Boolean(process.env.RAW_AGENT_API_KEY), baseUrlPresent: Boolean(process.env.RAW_AGENT_BASE_URL), modelNamePresent: Boolean(process.env.RAW_AGENT_MODEL_NAME) },
  deterministicChecks: { status: 'not_collected', instruction: 'Attach actual node:test/JUnit results separately; fixture validation is not runtime regression.' },
  records: records.map(({ caseId, trial, pass, failures, contextEvidence, evidenceFile, durationMs, tokens }) => ({ caseId, trial, pass, failures, contextEvidence, evidenceFile, durationMs, tokens })) };
const out = resolve(options.out); mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
writeFileSync(join(out, 'context-evidence.json'), JSON.stringify(report, null, 2));
writeFileSync(join(out, 'context-evidence.txt'), `Context semantic status: ${summary.semanticStatus}\nObserved trials: ${summary.observedTrials}/${summary.expectedTrials}\nDeterministic checks: not collected in this report\nSource run: ${results ?? 'none'}\n${summary.limitation}\n`);
console.log(JSON.stringify({ semanticStatus: summary.semanticStatus, observedTrials: summary.observedTrials, liveConfiguration: report.liveConfiguration, out }));
if (options.results && summary.semanticStatus !== 'passed_samples') process.exitCode = 1;
