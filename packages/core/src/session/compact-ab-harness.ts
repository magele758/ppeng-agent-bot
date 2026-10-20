/**
 * Live-model A/B harness for after-consume tool-result eviction.
 *
 * Seeds three consumed bash results that look like real command stdout
 * (`ls -la`, `git status`, a node:test failure stack) plus a follow-up.
 * Preview helpers are pure (no LLM). The CI script asks a real model for the
 * release tarball filename that appears only in the ls listing.
 *
 * Policy is applied via `writeCompactSettings` (daemon_control KV), not a new
 * RAW_AGENT_* switch.
 */

import { randomBytes } from 'node:crypto';
import { estimateMessageTokens } from '../model/token-estimate.js';
import type { MessagePart, MessageRole, SessionMessage, TokenUsage } from '../types.js';
import {
  DEFAULT_MICRO_COMPACT_CONFIG,
  microCompactMessages,
  type MicroCompactConfig,
  type MicroCompactPolicy
} from './micro-compact.js';

export const COMPACT_AB_DEFAULT_POLICIES = ['keep_recent', 'after_text_assistant'] as const;
export const COMPACT_AB_DEFAULT_CASES = ['silent'] as const;

export type CompactAbPolicyId = MicroCompactPolicy;
export type CompactAbCaseId = 'silent' | 'restated';
export type CompactAbToolKind = 'ls' | 'git_status' | 'test_stack';

export interface CompactAbToolTurn {
  kind: CompactAbToolKind;
  toolCallId: string;
  name: 'bash';
  command: string;
  stdout: string;
  summary: string;
}

export interface CompactAbSeed {
  token: string;
  caseId: CompactAbCaseId;
  toolCallId: string;
  firstUser: string;
  followUp: string;
  dump: string;
  consumedText: string;
  command: string;
  tools: CompactAbToolTurn[];
}

export interface CompactAbSeedTurn {
  assistantToolCall: MessagePart[];
  toolResult: MessagePart[];
}

export interface CompactAbSeedParts {
  turns: CompactAbSeedTurn[];
  assistantConsumed: MessagePart[];
}

export interface CompactAbSeedStore {
  appendMessage(sessionId: string, role: MessageRole, parts: MessagePart[]): unknown;
}

export interface CompactAbViewPreview {
  collapsed: number;
  charsSaved: number;
  tokens: number;
  baselineTokens: number;
  tokenInView: boolean;
}

export interface CompactAbRunRow {
  policy: CompactAbPolicyId;
  caseId: CompactAbCaseId;
  token: string;
  recalled: boolean;
  expectedTokenInView: boolean;
  collapsed: number;
  charsSaved: number;
  viewTokens: number;
  baselineTokens: number;
  usage?: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'requests'>;
  costUsd?: number;
  elapsedMs: number;
  answerPreview: string;
  sessionStatus?: string;
  error?: string;
  toolName?: string;
  stdoutSummary?: string;
  /** Tools called by the model during the follow-up turn (after seed follow-up user message). */
  followUpTools?: string[];
}

export interface CompactAbSummary {
  completed: number;
  failed: number;
  recalled: number;
  /** Baseline recalled the silent token; after_text_assistant did not. */
  qualityRegression: boolean;
  inputTokensByPolicy: Record<string, number>;
}

export interface CompactAbReport {
  generatedAt: string;
  adapter?: string;
  model?: string;
  skipped?: boolean;
  skipReason?: string;
  runs: CompactAbRunRow[];
  summary: CompactAbSummary;
}

const ALLOWED_POLICIES = new Set<string>([
  'keep_recent',
  'after_any_assistant',
  'after_text_assistant'
]);

const ALLOWED_CASES = new Set<string>(['silent', 'restated']);

const LS_COMMAND = 'ls -la /opt/app/releases';
const GIT_COMMAND = 'git status';
const TEST_COMMAND = 'node --test packages/core/test/release-ready.test.js';

/** Probe fact: release tarball filename. Only appears in the ls stdout. */
export function makeSecretToken(): string {
  return `ppeng-gateway-rel_${randomBytes(6).toString('hex')}.tgz`;
}

function lsLine(
  mode: string,
  links: number,
  user: string,
  group: string,
  size: number,
  date: string,
  name: string
): string {
  return `${mode}  ${links} ${user} ${group} ${String(size).padStart(6)} ${date} ${name}`;
}

export function buildLsListing(filename: string, minChars = 0): string {
  const rows: string[] = [
    lsLine('drwxr-xr-x', 3, 'deploy', 'deploy', 4096, 'Sep  2 07:48', '.'),
    lsLine('drwxr-xr-x', 8, 'deploy', 'deploy', 4096, 'Sep  1 11:02', '..'),
    lsLine('-rw-r--r--', 1, 'deploy', 'deploy', 812, 'Sep  2 07:40', 'SHA256SUMS'),
    lsLine('-rw-r--r--', 1, 'deploy', 'deploy', 22104, 'Sep  1 23:11', 'previous.tgz'),
    lsLine('-rw-r--r--', 1, 'deploy', 'deploy', 184201, 'Sep  2 07:48', filename),
    lsLine('-rw-r--r--', 1, 'deploy', 'deploy', 4096, 'Sep  2 07:41', 'manifest.json'),
    lsLine('-rwxr-xr-x', 1, 'deploy', 'deploy', 8832, 'Sep  2 07:40', 'install.sh'),
    lsLine('drwxr-xr-x', 2, 'deploy', 'deploy', 4096, 'Sep  2 06:02', 'tmp')
  ];

  let i = 0;
  while (listingLength(rows) < minChars) {
    const n = String(i).padStart(4, '0');
    rows.push(lsLine('-rw-r--r--', 1, 'deploy', 'deploy', 4096 + (i % 50), 'Sep  2 06:10', `build-${n}.log`));
    i += 1;
  }

  const totalBlocks = Math.max(12, Math.ceil(rows.reduce((sum, line) => {
    const size = Number(line.trim().split(/\s+/)[4]) || 0;
    return sum + size;
  }, 0) / 1024));
  return [`total ${totalBlocks}`, ...rows].join('\n') + '\n';
}

function listingLength(rows: string[]): number {
  return rows.reduce((n, line) => n + line.length + 1, 'total 999\n'.length);
}

export function buildGitStatusStdout(): string {
  return [
    'On branch cursor/compact-settings',
    "Your branch is ahead of 'origin/main' by 2 commits.",
    "  (use \"git push\" to publish your local commits)",
    '',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
    '  (use "git restore <file>..." to discard changes in working directory)',
    '\tmodified:   packages/core/src/session/micro-compact.ts',
    '\tmodified:   packages/core/src/session/compact-settings.ts',
    '\tmodified:   apps/web-console/components/CompactSettingsCard.tsx',
    '',
    'Untracked files:',
    '  (use "git add <file>..." to include in what will be committed)',
    '\tpackages/core/test/compact-ab-harness.test.js',
    '',
    'no changes added to commit (use "git add" and/or "git commit -a")',
    ''
  ].join('\n');
}

export function buildTestStackStdout(): string {
  return [
    'TAP version 13',
    '# Subtest: releaseReady marks a green deploy',
    'not ok 1 - releaseReady marks a green deploy',
    '  ---',
    '  duration_ms: 12.408',
    "  location: 'packages/core/test/release-ready.test.js:14:3'",
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    '    Expected 200 "OK" from /api/readiness, got 503',
    '        at TestContext.<anonymous> (/workspace/packages/core/test/release-ready.test.js:18:12)',
    '        at Test.runInAsyncScope (node:async_hooks:214:14)',
    '        at Test.run (node:internal/test_runner/test:1047:25)',
    '        at Test.start (node:internal/test_runner/test:944:17)',
    '        at startSubtestAfterBootstrap (node:internal/test_runner/harness:332:17)',
    '        at run (node:internal/test_runner/runner:184:12)',
    '        at async main (node:internal/test_runner/main:66:7)',
    '  code: ERR_ASSERTION',
    '  name: AssertionError',
    "  expected: 200",
    '  actual: 503',
    '  operator: strictEqual',
    '  stack: |-',
    '    AssertionError [ERR_ASSERTION]: Expected 200 "OK" from /api/readiness, got 503',
    '        at TestContext.<anonymous> (/workspace/packages/core/test/release-ready.test.js:18:12)',
    '        at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    '  ...',
    '# Subtest: releaseReady writes the last status file',
    'not ok 2 - releaseReady writes the last status file',
    '  ---',
    '  duration_ms: 3.102',
    "  location: 'packages/core/test/release-ready.test.js:27:3'",
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    '    ENOENT: no such file or directory, open /var/lib/ppeng/last-status.json',
    '        at Object.openSync (node:fs:561:18)',
    '        at Object.readFileSync (node:fs:445:35)',
    '        at TestContext.<anonymous> (/workspace/packages/core/test/release-ready.test.js:31:18)',
    '  ...',
    '1..2',
    '# tests 2',
    '# suites 0',
    '# pass 0',
    '# fail 2',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 16.771',
    ''
  ].join('\n');
}

function countLines(text: string): number {
  return text.replace(/\n$/, '').split('\n').length;
}

export function buildToolTurns(filename: string, minChars = 2400): CompactAbToolTurn[] {
  const git = buildGitStatusStdout();
  const stack = buildTestStackStdout();
  const reserved = git.length + stack.length;
  const ls = buildLsListing(filename, Math.max(0, minChars - reserved));
  return [
    {
      kind: 'ls',
      toolCallId: 'call_compact_ab_ls',
      name: 'bash',
      command: LS_COMMAND,
      stdout: ls,
      summary: `${countLines(ls)}-line ls -la listing of /opt/app/releases`
    },
    {
      kind: 'git_status',
      toolCallId: 'call_compact_ab_git',
      name: 'bash',
      command: GIT_COMMAND,
      stdout: git,
      summary: 'git status on feature branch, 3 modified'
    },
    {
      kind: 'test_stack',
      toolCallId: 'call_compact_ab_test',
      name: 'bash',
      command: TEST_COMMAND,
      stdout: stack,
      summary: 'node:test FAIL releaseReady (AssertionError, 503)'
    }
  ];
}

export function firstUserPrompt(): string {
  return [
    'Please list /opt/app/releases, check git status, and re-run the failing unit test.',
    'Briefly confirm you captured those three outputs.'
  ].join(' ');
}

export function followUpPrompt(): string {
  return [
    'What tarball filename appeared in the directory listing?',
    'Do not re-run any commands.',
    'If the earlier output is no longer in view, recover it from this session\'s history.',
    'Reply with only the filename.'
  ].join(' ');
}

export function consumedAssistantText(caseId: CompactAbCaseId, token: string): string {
  if (caseId === 'restated') {
    return `Captured the three outputs. The tarball in the listing is ${token}.`;
  }
  return 'Captured the directory listing, git status, and the unit-test failure. Details are in the tool results.';
}

export function seedToolName(seed: CompactAbSeed): string {
  return [...new Set(seed.tools.map((t) => t.name))].join(',');
}

export function summarizeSeedTools(seed: CompactAbSeed): string {
  return seed.tools.map((t) => `${t.kind}: ${t.summary} (${t.stdout.length}ch)`).join(' | ');
}

export function buildCompactAbSeed(input?: {
  token?: string;
  caseId?: CompactAbCaseId;
  minChars?: number;
}): CompactAbSeed {
  const token = input?.token ?? makeSecretToken();
  const caseId = input?.caseId ?? 'silent';
  const tools = buildToolTurns(token, input?.minChars ?? 2400);
  return {
    token,
    caseId,
    toolCallId: tools[0]!.toolCallId,
    firstUser: firstUserPrompt(),
    followUp: followUpPrompt(),
    dump: tools.map((t) => t.stdout).join('\n'),
    consumedText: consumedAssistantText(caseId, token),
    command: tools.map((t) => t.command).join('\n'),
    tools
  };
}

export function seedParts(seed: CompactAbSeed): CompactAbSeedParts {
  return {
    turns: seed.tools.map((tool) => ({
      assistantToolCall: [
        {
          type: 'tool_call',
          toolCallId: tool.toolCallId,
          name: tool.name,
          input: { command: tool.command }
        }
      ],
      toolResult: [
        {
          type: 'tool_result',
          toolCallId: tool.toolCallId,
          name: tool.name,
          ok: tool.kind !== 'test_stack',
          content: tool.stdout
        }
      ]
    })),
    assistantConsumed: [{ type: 'text', text: seed.consumedText }]
  };
}

export function applyCompactAbSeedToStore(
  store: CompactAbSeedStore,
  sessionId: string,
  seed: CompactAbSeed
): void {
  const parts = seedParts(seed);
  for (const turn of parts.turns) {
    store.appendMessage(sessionId, 'assistant', turn.assistantToolCall);
    store.appendMessage(sessionId, 'tool', turn.toolResult);
  }
  store.appendMessage(sessionId, 'assistant', parts.assistantConsumed);
}

export function seedMessages(seed: CompactAbSeed): SessionMessage[] {
  const parts = seedParts(seed);
  const ts = '2026-09-02T00:00:00.000Z';
  const sid = 'compact-ab';
  const messages: SessionMessage[] = [
    { id: 'u1', sessionId: sid, role: 'user', parts: [{ type: 'text', text: seed.firstUser }], createdAt: ts }
  ];
  parts.turns.forEach((turn, idx) => {
    const n = idx + 1;
    messages.push({
      id: `a${n}`,
      sessionId: sid,
      role: 'assistant',
      parts: turn.assistantToolCall,
      createdAt: ts
    });
    messages.push({
      id: `t${n}`,
      sessionId: sid,
      role: 'tool',
      parts: turn.toolResult,
      createdAt: ts
    });
  });
  messages.push({
    id: `a${parts.turns.length + 1}`,
    sessionId: sid,
    role: 'assistant',
    parts: parts.assistantConsumed,
    createdAt: ts
  });
  messages.push({
    id: 'u2',
    sessionId: sid,
    role: 'user',
    parts: [{ type: 'text', text: seed.followUp }],
    createdAt: ts
  });
  return messages;
}

export function compactAbPolicyConfig(policy: CompactAbPolicyId): MicroCompactConfig {
  return {
    ...DEFAULT_MICRO_COMPACT_CONFIG,
    enabled: true,
    keepRecent: policy === 'keep_recent' ? 3 : 0,
    minChars: 100,
    policy
  };
}

function viewText(messages: SessionMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'text') chunks.push(part.text);
      if (part.type === 'tool_result') chunks.push(part.content);
    }
  }
  return chunks.join('\n');
}

export function previewCompactAbView(
  policy: CompactAbPolicyId,
  seed: CompactAbSeed
): CompactAbViewPreview {
  const messages = seedMessages(seed);
  const compact = microCompactMessages(messages, compactAbPolicyConfig(policy));
  return {
    collapsed: compact.stats.collapsed,
    charsSaved: compact.stats.charsSaved,
    tokens: estimateMessageTokens(compact.messages),
    baselineTokens: estimateMessageTokens(messages),
    tokenInView: viewText(compact.messages).includes(seed.token)
  };
}

/** Tool names that indicate the model re-ran a command instead of recalling from context.
 * bash/exec: shell-policy.ts treats both; bg_run/work_evidence: builtin-tools.ts. */
const COMMAND_TOOL_NAMES = new Set(['bash', 'exec', 'bg_run', 'work_evidence']);

/**
 * Extract tool names called after the follow-up user message. Pure; no I/O.
 * Ignores any tool calls that belong to the seeded turns before the follow-up.
 */
export function followUpToolCalls(messages: SessionMessage[], followUpText: string): string[] {
  let followUpIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as {text:string}).text).join('');
      if (text === followUpText) { followUpIdx = i; break; }
    }
  }
  if (followUpIdx < 0) return [];
  const tools: string[] = [];
  for (let i = followUpIdx + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant') {
      for (const p of m.parts) {
        if (p.type === 'tool_call' && (p as {name?:string}).name) {
          tools.push((p as {name:string}).name);
        }
      }
    }
  }
  return tools;
}

/** True when the model called a shell/command tool — counts as a recall MISS, not an error. */
export function isCommandReexecution(tools: string[]): boolean {
  return tools.some((t) => COMMAND_TOOL_NAMES.has(t));
}

/**
 * Score a follow-up turn. Re-executing a command is always recalled=false regardless of
 * whether the answer happens to contain the token (the model cheated by re-running).
 */
export function scoreRecall(opts: {
  answer: string;
  token: string;
  followUpTools: string[];
}): boolean {
  if (isCommandReexecution(opts.followUpTools)) return false;
  return answerRecallsToken(opts.answer, opts.token);
}

export function answerRecallsToken(answer: string, token: string): boolean {
  const needle = token.trim();
  if (!needle) return false;
  return answer.includes(needle) || answer.toUpperCase().includes(needle.toUpperCase());
}

export function redactAnswerPreview(answer: string, max = 240): string {
  return String(answer ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function parsePolicyList(raw: string | undefined): CompactAbPolicyId[] {
  const items = (raw ?? COMPACT_AB_DEFAULT_POLICIES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is CompactAbPolicyId => ALLOWED_POLICIES.has(s));
  return items.length > 0 ? unique(items) : [...COMPACT_AB_DEFAULT_POLICIES];
}

export function parseCaseList(raw: string | undefined): CompactAbCaseId[] {
  const items = (raw ?? COMPACT_AB_DEFAULT_CASES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is CompactAbCaseId => ALLOWED_CASES.has(s));
  return items.length > 0 ? unique(items) : [...COMPACT_AB_DEFAULT_CASES];
}

export function summarizeCompactAbRuns(runs: CompactAbRunRow[]): CompactAbSummary {
  const completed = runs.filter((row) => !row.error);
  const keepSilent = completed.find((row) => row.policy === 'keep_recent' && row.caseId === 'silent');
  const afterSilent = completed.find(
    (row) => row.policy === 'after_text_assistant' && row.caseId === 'silent'
  );
  const inputTokensByPolicy: Record<string, number> = {};
  for (const row of completed) {
    inputTokensByPolicy[row.policy] =
      (inputTokensByPolicy[row.policy] ?? 0) + (row.usage?.inputTokens ?? 0);
  }
  return {
    completed: completed.length,
    failed: runs.length - completed.length,
    recalled: completed.filter((row) => row.recalled).length,
    qualityRegression: Boolean(keepSilent?.recalled && afterSilent && !afterSilent.recalled),
    inputTokensByPolicy
  };
}

export function formatCompactAbReport(report: CompactAbReport): string {
  if (report.skipped) {
    return `compact-ab: skipped (${report.skipReason ?? 'n/a'})`;
  }
  const lines = [
    `compact-ab ${report.generatedAt}`,
    `adapter=${report.adapter ?? '?'} model=${report.model ?? '?'}`
  ];
  const sample = report.runs.find((row) => row.toolName || row.stdoutSummary);
  if (sample?.toolName) lines.push(`tool=${sample.toolName}`);
  if (sample?.stdoutSummary) lines.push(`stdout: ${sample.stdoutSummary}`);
  lines.push(
    `completed=${report.summary.completed} failed=${report.summary.failed} recalled=${report.summary.recalled} quality_regression=${report.summary.qualityRegression}`
  );
  for (const row of report.runs) {
    const usage = row.usage
      ? ` in=${row.usage.inputTokens} out=${row.usage.outputTokens} tot=${row.usage.totalTokens}`
      : '';
    const err = row.error ? ` error=${row.error}` : '';
    const tool = row.toolName ? ` tool=${row.toolName}` : '';
    const followUp = row.followUpTools?.length ? ` follow_up_tools=${row.followUpTools.join(',')}` : '';
    lines.push(
      `  ${row.policy}/${row.caseId}:${tool} recalled=${row.recalled} in_view=${row.expectedTokenInView} collapsed=${row.collapsed} chars_saved=${row.charsSaved} view_tok=${row.viewTokens} base_tok=${row.baselineTokens}${usage}${followUp} ${row.elapsedMs}ms${err}`
    );
    if (row.stdoutSummary) lines.push(`    stdout: ${row.stdoutSummary}`);
    if (row.answerPreview) lines.push(`    answer: ${row.answerPreview}`);
  }
  return lines.join('\n');
}
