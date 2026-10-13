#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_GATES = ['build', 'unit', 'integration', 'browser', 'faults', 'migration-rollback', 'performance', 'soak', 'live-model', 'live-software', 'acceptance', 'crap'];

/** A passed label without matching candidate and evidence is insufficient. */
export function assessReleaseEvidence(manifest) {
  const checks = Array.isArray(manifest?.checks) ? manifest.checks : [];
  const missing = REQUIRED_GATES.filter(gate => !checks.some(check => {
    if (!manifest?.candidate || check?.gate !== gate || check.candidate !== manifest.candidate || check.status !== 'passed' || typeof check.artifact !== 'string' || !check.artifact.trim()) return false;
    if (gate === 'soak') return check.durationSeconds >= 86400 && check.warmupSeconds >= 1800 && check.fullProtocol === true;
    if (gate === 'performance') return check.fullProtocol === true && check.referenceHardwareMatched === true;
    if (gate === 'faults') return check.sequences >= 10000 && check.consecutivePasses >= 3 && check.killRestart === true;
    if (gate === 'browser') return check.consecutivePasses >= 3 && check.retries === 0;
    if (gate === 'live-model') return check.trialsPerModel >= 3 && check.criticalRecall === 1 && check.otherRecall >= 0.95;
    return true;
  }));
  return { candidate: manifest?.candidate ?? null, ready: missing.length === 0, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/bot-release/evidence.mjs <evidence-manifest.json>; missing evidence cannot authorize release.');
    process.exitCode = 1;
  } else {
    try {
      const result = assessReleaseEvidence(JSON.parse(readFileSync(file, 'utf8')));
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 1;
    } catch (error) {
      console.error(`Evidence assessment failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
