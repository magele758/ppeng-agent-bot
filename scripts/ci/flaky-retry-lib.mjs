// Pure helpers for retry-failed-tests.mjs (unit-tested in scripts/test/flaky-retry-lib.test.mjs).
import fs from 'node:fs';
import { isKnownFlaky, knownFlaky } from './known-flaky.mjs';
import path from 'node:path';

/** More failing files than this looks like a real breakage, not noise: skip the retry. */
export const DEFAULT_MAX_RETRY_FILES = 10;

/**
 * Split a `node [flags] --test <patterns...>` npm script into node flags and file patterns.
 * Flags must use the `--flag=value` form (a bare word ends the flag list).
 */
export function splitNodeTestCommand(command) {
  const tokens = String(command).trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== 'node') throw new Error(`expected a "node ..." command, got: ${command}`);
  const rest = tokens.slice(1);
  const firstPattern = rest.findIndex((t) => !t.startsWith('-'));
  const flags = firstPattern === -1 ? rest : rest.slice(0, firstPattern);
  const patterns = firstPattern === -1 ? [] : rest.slice(firstPattern);
  if (!flags.includes('--test')) throw new Error(`expected a "node --test" command, got: ${command}`);
  if (patterns.length === 0) throw new Error(`no test file patterns in: ${command}`);
  return { flags, patterns };
}

export function shellQuote(value) {
  const s = String(value);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Rebuild the npm script for `sh -c` with a pinned node binary and extra flags (patterns stay shell globs). */
export function buildShellCommand(command, { nodeBin, extraFlags }) {
  const { flags, patterns } = splitNodeTestCommand(command);
  return [shellQuote(nodeBin), ...flags, ...extraFlags.map(shellQuote), ...patterns].join(' ');
}

/** argv (after the node binary) to re-run one test file in its own `node --test` process. */
export function buildRetryArgs(flags, file) {
  return [...flags, file];
}

/** Parse failed-tests-reporter.mjs output (JSON lines); malformed lines are ignored. */
export function parseFailureLines(text) {
  const events = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object') events.push(ev);
    } catch {
      /* partial line from an interrupted run */
    }
  }
  return events;
}

/**
 * Node reports an absolute real path. On macOS `os.tmpdir()` is under `/var`, which is a symlink
 * to `/private/var`, so a plain `path.relative` walks out to the filesystem root and the isolated
 * retry cannot find the file. Realpath both sides, then fall back for synthetic paths in tests.
 */
export function failureFileRelativeToRoot(file, root) {
  if (!path.isAbsolute(file)) return file;
  try {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  } catch {
    /* path does not exist (unit fixtures) or was removed before grouping */
  }
  return path.relative(root, file);
}

/**
 * Group failure events by test file (relative to root). Parent suites that only failed because a
 * subtest failed are dropped from the test names; events without a file are counted as unattributed.
 */
export function groupFailuresByFile(events, root) {
  const byFile = new Map();
  let unattributed = 0;
  for (const ev of events) {
    if (!ev.file) {
      unattributed += 1;
      continue;
    }
    const file = failureFileRelativeToRoot(ev.file, root);
    if (!byFile.has(file)) byFile.set(file, { file, tests: [] });
    const group = byFile.get(file);
    if (ev.failureType !== 'subtestsFailed' && !group.tests.some((t) => t.name === ev.name)) {
      group.tests.push({ name: String(ev.name), message: String(ev.message ?? '') });
    }
  }
  const files = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  return { files, unattributed };
}

/**
 * Whether the failing files from the first pass may be retried; when not, `reason` says why the
 * step fails outright.
 */
export function retryPlan({ exitCode, files, unattributed, maxRetryFiles = DEFAULT_MAX_RETRY_FILES }) {
  if (exitCode === 0) return { retry: false, pass: true, reason: null };
  if (files.length === 0) return { retry: false, pass: false, reason: 'test run failed without attributable test failures' };
  if (unattributed > 0) return { retry: false, pass: false, reason: `${unattributed} failure(s) without a test file` };
  if (files.length > maxRetryFiles) {
    return { retry: false, pass: false, reason: `${files.length} failing files exceeds retry limit ${maxRetryFiles}` };
  }
  return { retry: true, pass: false, reason: null };
}

/** Split first-pass failures by isolated retry exit code: 0 → flaky, anything else → failed. */
export function classifyRetry(files, retryExitCodes) {
  const flaky = [];
  const failed = [];
  for (const group of files) {
    (retryExitCodes[group.file] === 0 ? flaky : failed).push(group);
  }
  return { flaky, failed };
}

// GitHub workflow-command escaping (see actions/toolkit command.ts).
export function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function testNames(group) {
  return group.tests.length ? group.tests.map((t) => t.name).join('; ') : '(file-level failure)';
}

export function renderAnnotations({ flaky, failed }, label) {
  const lines = [];
  for (const g of flaky) {
    lines.push(
      `::warning file=${escapeProperty(g.file)},title=${escapeProperty(`Flaky test (${label})`)}::${escapeData(
        `Failed, then passed on isolated retry: ${testNames(g)}`
      )}`
    );
  }
  for (const g of failed) {
    lines.push(
      `::error file=${escapeProperty(g.file)},title=${escapeProperty(`Test failed twice (${label})`)}::${escapeData(
        `Failed on first run and on isolated retry: ${testNames(g)}`
      )}`
    );
  }
  return lines;
}

function mdCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderSummary({ flaky, failed }, label) {
  if (flaky.length === 0 && failed.length === 0) return '';
  const out = [];
  if (flaky.length) {
    out.push(`### Flaky tests (${label})`, '');
    out.push('Failed on the first run, passed when the file was re-run alone. Unlisted retry recoveries fail the step; checked-in exceptions remain visibly flaky.', '');
    out.push('| File | Tests |', '|---|---|');
    for (const g of flaky) out.push(`| \`${mdCell(g.file)}\` | ${mdCell(testNames(g))} |`);
    out.push('');
  }
  if (failed.length) {
    out.push(`### Failed twice (${label})`, '');
    out.push('| File | Tests |', '|---|---|');
    for (const g of failed) out.push(`| \`${mdCell(g.file)}\` | ${mdCell(testNames(g))} |`);
    out.push('');
  }
  return out.join('\n');
}

export function buildReport({ label, script, firstExitCode, plan, flaky, failed, allowlist = knownFlaky }) {
  return {
    schema: 1,
    label,
    script,
    firstExitCode,
    retried: plan.retry,
    noRetryReason: plan.reason,
    pass: plan.pass || (plan.retry && failed.length === 0 && flaky.every(g => g.tests.length > 0 && g.tests.every(t => isKnownFlaky(g.file, t.name, allowlist)))),
    flaky,
    failed
  };
}
