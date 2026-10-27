// Fail the quick gate when a touched function exceeds the CRAP complexity limit.
// Untouched functions keep their existing debt. Coverage is not required: at full
// coverage the CRAP score is the complexity.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectFunctions } from '../crap/crap-lib.mjs';
import { baseRevision, git } from './base-revision.mjs';

export const COMPLEXITY_LIMIT = 30;
const SOURCE = /\.(tsx|ts|mts|cts|jsx|js|mjs|cjs)$/;

/** 1-based new-file line numbers added or touched by a unified diff. */
export function changedLineSet(diffText) {
  const lines = new Set();
  let next = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.add(next);
      next += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    } else {
      next += 1;
    }
  }
  return lines;
}

/** Functions over the limit whose body or signature intersects changedLines. Null means the whole file. */
export function overComplexTouched(fileName, text, changedLines, limit = COMPLEXITY_LIMIT) {
  return collectFunctions(fileName, text).filter((fn) => {
    if (fn.complexity <= limit) return false;
    if (changedLines == null) return true;
    const owned = new Set([fn.line, ...fn.statementLines.map((line) => line + 1)]);
    for (const line of owned) if (changedLines.has(line)) return true;
    return false;
  });
}

function sourcePaths(root, base) {
  const names = git(root, ['diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD']).split('\n').filter(Boolean);
  return names.filter((name) => SOURCE.test(name) && !name.includes('/dist/') && !name.includes('/node_modules/') && !name.endsWith('.d.ts'));
}

export function overComplexChanges(root, env = process.env, limit = COMPLEXITY_LIMIT) {
  const base = baseRevision(root, env);
  if (!base) return [];
  const found = [];
  for (const file of sourcePaths(root, base)) {
    let text;
    try { text = readFileSync(`${root}/${file}`, 'utf8'); } catch { continue; }
    const diff = git(root, ['diff', '--unified=0', base, 'HEAD', '--', file]);
    for (const fn of overComplexTouched(file, text, changedLineSet(diff), limit)) {
      found.push({ file, name: fn.name, line: fn.line, complexity: fn.complexity });
    }
  }
  return found;
}

function main() {
  const found = overComplexChanges(process.cwd());
  if (!found.length) {
    console.log(`[complexity] no touched function exceeds ${COMPLEXITY_LIMIT}`);
    return;
  }
  for (const fn of found) console.error(`[complexity] ${fn.complexity} ${fn.file}:${fn.line} ${fn.name}`);
  console.error(`[complexity] ${found.length} touched function(s) exceed ${COMPLEXITY_LIMIT}. Split them; do not wait for coverage.`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
