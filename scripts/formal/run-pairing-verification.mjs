#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, runVerificationProcess } from './pairing-verifier.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) {
  console.error('Usage: pnpm run test:pairing [--out report-directory]');
  process.exit(2);
}
const out = args.length ? resolve(args[1]) : join(ROOT, 'coverage/formal/pairing');
const report = runVerificationProcess();
const lines = [
  '# Tool-call pairing verification', '',
  `Overall: **${report.status}** (exit ${report.exitCode})`,
  report.reason ? `Reason: ${report.reason}` : '',
  `Model: ${report.model?.status ?? 'not completed'}; states=${report.model?.states ?? 0}; transitions=${report.model?.transitions ?? 0}; exhausted=${report.model?.exhausted ?? false}`,
  `Real source probes: ${report.source?.status ?? 'not completed'}`,
  `Isolated mutations: ${report.mutations?.status ?? 'not completed'}; restored=${report.mutations?.restored ?? false}`,
  `Source/model review: ${report.review?.status ?? 'not completed'}`, '',
  'A model pass is bounded design evidence, not a proof of the whole implementation.', '',
];
if (report.scope) {
  lines.push('## Scope', '', JSON.stringify(report.scope.bounds), '', ...report.scope.assumptions.map(x => `- Assumption: ${x}`), ...report.scope.exclusions.map(x => `- Excluded: ${x}`), '');
}
for (const row of report.source?.scenarios ?? []) {
  lines.push(`- ${row.name}: ${row.status}`);
  if (row.status === 'violation') lines.push(`  - Events: ${row.events.join(' → ')}`, `  - Violations: ${JSON.stringify(row.issues)}`);
}
for (const row of report.mutations?.mutants ?? []) lines.push(`- Mutation ${row.name}: ${row.killed ? 'caught' : 'MISSED'} (${row.file})`);
for (const path of report.review?.changed ?? []) lines.push(`- Needs review: ${path}`);
for (const path of report.review?.unmapped ?? []) lines.push(`- Missing mapping: ${path}`);
try {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'report.md'), lines.filter(x => x !== undefined).join('\n') + '\n');
} catch (error) {
  console.error(`Could not save verification evidence: ${error.message}`); process.exit(2);
}
console.log(lines.slice(0, 10).join('\n'));
console.log(`Evidence: ${join(out, 'report.md')}`);
process.exitCode = report.exitCode;
