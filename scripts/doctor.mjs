#!/usr/bin/env node
/**
 * Offline doctor entry (no daemon required).
 * Usage: node scripts/doctor.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const dist = join(repoRoot, 'packages', 'core', 'dist', 'doctor', 'doctor.js');

if (!existsSync(dist)) {
  console.error('doctor: packages/core/dist missing — run: pnpm exec tsc -b packages/core');
  process.exit(2);
}

const { runDoctor, formatDoctorReport } = await import(dist);
const report = runDoctor({ repoRoot, env: process.env });
console.log(formatDoctorReport(report));
process.exit(report.ok ? 0 : 1);
