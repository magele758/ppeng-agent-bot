#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, runLifecycleProcess } from './lifecycle-verifier.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) { console.error('Usage: pnpm run test:lifecycle [--out directory]'); process.exit(2); }
const out = args.length ? resolve(args[1]) : join(ROOT, 'coverage/formal/lifecycle');
const report = runLifecycleProcess();
const lines = ['# Session lifecycle verification', '', `Overall: **${report.status}** (exit ${report.exitCode})`,
  `Model: ${report.model?.status ?? 'not completed'}; states=${report.model?.states ?? 0}; transitions=${report.model?.transitions ?? 0}; exhausted=${report.model?.exhausted ?? false}`,
  `Real public runtime + SQLite: ${report.runtime?.status ?? 'not completed'}`,
  `Mutation controls: ${report.mutations?.status ?? 'not completed'}; restored=${report.mutations?.restored ?? false}`,
  `Source/model review: ${report.review?.status ?? 'not completed'}`, '',
  'A bounded design model passing does not imply the implementation passes.', ''];
if (report.reason) lines.push(report.reason);
if (report.scope) lines.push('## Scope', '', JSON.stringify(report.scope.bounds), '', ...report.scope.assumptions.map(s => `- Assumption: ${s}`), ...report.scope.exclusions.map(s => `- Excluded: ${s}`), '');
for (const row of report.runtime?.scenarios ?? []) {
  lines.push(`- ${row.name}: ${row.status}`);
  if (row.status === 'fail') {
    lines.push(`  - Events: ${row.events.join(' → ')}`);
    for (const c of row.checks.filter(x => !x.ok)) lines.push(`  - ${c.label}; expected=${JSON.stringify(c.expected)}; actual=${JSON.stringify(c.actual)}`);
  }
}
for (const m of report.mutations?.mutants ?? []) lines.push(`- Mutation ${m.name}: ${m.killed ? 'caught' : 'MISSED'}; ${m.file}`);
for (const path of report.review?.changed ?? []) lines.push(`- Needs review: ${path}`);
try {
  mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n');
} catch (error) { console.error(`Cannot preserve evidence: ${error.message}`); process.exit(2); }
console.log(lines.slice(0, 10).join('\n')); console.log(`Evidence: ${join(out, 'report.md')}`); process.exitCode = report.exitCode;
