/**
 * Default-FAIL policy for dangerous cwd and untrusted markdown/PR induction.
 *
 * PreToolUse direction: high-privilege tools must not auto-run when the working
 * directory is untrusted or when the tool call was clearly induced by untrusted
 * content (fenced external markdown, PR body markers, etc.).
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type HighPrivilegeTool =
  | 'bash'
  | 'bg_run'
  | 'shell'
  | 'work_evidence'
  | 'write_secrets'
  | 'apply_patch';

const HIGH_PRIVILEGE = new Set<string>([
  'bash',
  'bg_run',
  'shell',
  'work_evidence',
  'write_secrets',
  'apply_patch'
]);

const UNTRUSTED_INSTRUCTION_MARKERS = [
  'Ignore previous instructions',
  'ignore all previous instructions',
  'sudo rm -rf /',
  'curl | bash',
  'curl|bash',
  'wget | sh'
];

/** Markers that indicate tool input was induced by untrusted markdown / PR text. */
const UNTRUSTED_INDUCTION_MARKERS = [
  '«external ',
  '«end external»',
  '[untrusted source=',
  'BEGIN PR BODY',
  'BEGIN UNTRUSTED MARKDOWN',
  '<!-- untrusted-pr -->',
  ...UNTRUSTED_INSTRUCTION_MARKERS
];

export interface DefaultDenyInput {
  tool: string;
  cwd?: string;
  /** Trusted workspace roots; cwd outside all of them is dangerous. */
  workspaceRoots?: string[];
  /** Raw tool args / surrounding prompt snippets to scan for induction. */
  inductionText?: string;
  /** Shell text checked for cwd / eval escape. Defaults to inductionText. */
  command?: string;
  /** Prior tool or web text. Explicit untrusted instructions block eval escape. */
  untrustedCorpus?: string;
  /** Explicit session/metadata flag that cwd is untrusted. */
  cwdUntrusted?: boolean;
}

export interface DefaultDenyDecision {
  allow: boolean;
  reason?: string;
  /** Always true when allow=false — callers must fail closed. */
  defaultFail: true;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const a = resolve(candidate);
  const b = resolve(root);
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

function lexicalOrReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function pathInsideRoots(abs: string, roots: string[]): boolean {
  const real = lexicalOrReal(abs);
  return roots.filter(Boolean).some((root) => isInsideRoot(real, lexicalOrReal(resolve(root))));
}

function symlinkCwdDecision(abs: string, roots: string[]): { dangerous: boolean; reason?: string } {
  if (pathInsideRoots(abs, roots)) return { dangerous: false };
  return { dangerous: true, reason: 'cwd symlink leaves workspace' };
}

/** Dangerous when cwd is missing, outside workspace, or flagged untrusted. */
export function isDangerousCwd(
  cwd: string | undefined,
  workspaceRoots: string[] | undefined,
  cwdUntrusted?: boolean
): { dangerous: boolean; reason?: string } {
  if (cwdUntrusted) {
    return { dangerous: true, reason: 'cwd flagged untrusted' };
  }
  if (!cwd || !cwd.trim()) {
    return { dangerous: true, reason: 'cwd missing' };
  }
  const roots = (workspaceRoots ?? []).filter(Boolean);
  if (roots.length === 0) {
    // No trusted roots configured — fail closed for high privilege.
    return { dangerous: true, reason: 'no trusted workspace roots' };
  }
  const abs = resolve(cwd);
  if (!roots.some((r) => isInsideRoot(abs, r))) {
    return { dangerous: true, reason: `cwd outside workspace: ${abs}` };
  }
  // World-writable-ish temp dirs without being the workspace itself.
  const lower = abs.toLowerCase();
  const tmpHints = ['/tmp/', '/var/tmp/', '\\temp\\', '/private/tmp/'];
  const inTmp = tmpHints.some((h) => lower.includes(h));
  const tmpIsWorkspace = roots.some((r) => isInsideRoot(abs, r) && resolve(r) === abs);
  if (inTmp && !tmpIsWorkspace && !roots.some((r) => isInsideRoot(abs, r) && resolve(r) !== abs ? isInsideRoot(abs, r) : isInsideRoot(abs, r))) {
    // still inside a root that happens to be under tmp — allow if inside roots (already checked)
  }
  // If cwd is under system tmp AND not equal to a declared workspace root path prefix that user chose:
  if (inTmp && !roots.some((r) => abs === resolve(r) || abs.startsWith(resolve(r) + '/'))) {
    return { dangerous: true, reason: 'cwd in shared temp without workspace trust' };
  }
  return symlinkCwdDecision(abs, roots);
}

export function detectUntrustedInduction(text: string | undefined): { induced: boolean; marker?: string } {
  if (!text) return { induced: false };
  const lower = text.toLowerCase();
  for (const marker of UNTRUSTED_INDUCTION_MARKERS) {
    if (text.includes(marker) || lower.includes(marker.toLowerCase())) {
      return { induced: true, marker };
    }
  }
  return { induced: false };
}

export function isHighPrivilegeTool(tool: string): boolean {
  return HIGH_PRIVILEGE.has(tool.trim().toLowerCase());
}

const EVAL_ESCAPE =
  /(?:^|[\s;&|`(])(?:eval\s|node(?:\s+--eval|\s+-e\b)|python3?\s+-c\b|perl\s+-e\b|ruby\s+-e\b|php\s+-r\b)|(?:\bFunction\s*\(|child_process|os\.system\s*\()/i;
const PIPE_SHELL = /\|\s*(?:ba)?sh\b|\|\s*(?:z|da)sh\b|\bbase64\s+(?:-d|--decode)\b|\b(?:ba)?sh\s+-c\b/i;

function isParentEscape(target: string): boolean {
  return target === '..' || target.startsWith('../') || target.includes('/../');
}

function targetOutsideWorkspace(target: string, cwd: string, roots: string[]): boolean {
  return !pathInsideRoots(resolve(cwd || '.', target), roots);
}

function cdTargetEscapes(raw: string, cwd: string, roots: string[]): boolean {
  const target = raw.replace(/^['"]|['"]$/g, '');
  if (!target || target === '.') return false;
  if (isParentEscape(target) || target === '-') return true;
  return targetOutsideWorkspace(target, cwd, roots);
}

function isShellQuote(quote: string | undefined): boolean {
  return quote === "'" || quote === '"';
}

function hasLocalExpansion(quote: string | undefined, body: string): boolean {
  return quote === '"' && /[$`\\]/.test(body);
}

function literalRemoteBodyEnd(command: string, start: number): number {
  const quote = command[start];
  if (!isShellQuote(quote)) return -1;
  const end = command.indexOf(quote!, start + 1);
  if (end < 0 || hasLocalExpansion(quote, command.slice(start + 1, end))) return -1;
  return /^\s*(?:$|[;&|])/.test(command.slice(end + 1)) ? end : -1;
}

/** Exclude only a statically literal SSH body, never local expansions or tails. */
function localCommandText(command: string): string {
  const prefix = /^\s*(?:\/usr\/bin\/)?ssh[ \t]+(?:(?:-(?:p|i|l|F|J|o)[ \t]+[A-Za-z0-9_@.\/:=,+-]+|-o[A-Za-z0-9_@.\/:=,+-]+|-[A-Za-z0-9]+)[ \t]+)*[A-Za-z0-9_@.:\[\]-]+[ \t]+/.exec(command);
  if (!prefix) return command;
  const start = prefix[0].length;
  const end = literalRemoteBodyEnd(command, start);
  return end < 0 ? command : command.slice(0, start) + "''" + command.slice(end + 1);
}

function hasUntrustedInstructions(corpus: string): boolean {
  const lower = corpus.toLowerCase();
  return UNTRUSTED_INSTRUCTION_MARKERS.some(marker => lower.includes(marker.toLowerCase()));
}

/** `cd` / `pushd` / `chdir` that leaves every trusted root, including `..`. */
export function commandLeavesWorkspace(command: string, cwd: string, roots: string[]): boolean {
  const re = /\b(?:cd|pushd|chdir)\s+([^\s;|&]+)/gi;
  const local = localCommandText(command);
  let match: RegExpExecArray | null = re.exec(local);
  while (match) {
    if (cdTargetEscapes(match[1] ?? '', cwd, roots)) return true;
    match = re.exec(local);
  }
  return false;
}

export function commandEvaluatesCode(command: string): boolean {
  return EVAL_ESCAPE.test(command) || PIPE_SHELL.test(command);
}

function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  const record = part as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  return '';
}

function isUntrustedChunk(text: string): boolean {
  return text.includes('«external') || text.includes('[untrusted') || text.includes('BEGIN PR BODY') || text.includes('BEGIN UNTRUSTED');
}

/** Keep only fenced / marked untrusted tool and web text. */
export function untrustedCorpusFromMessages(
  messages: ReadonlyArray<{ parts?: readonly unknown[] }> | undefined
): string {
  if (!messages) return '';
  const chunks: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) chunks.push(partText(part));
  }
  return chunks.filter(isUntrustedChunk).join('\n').slice(0, 20_000);
}

export function untrustedEscapeReason(
  command: string,
  corpus: string | undefined,
  cwd: string,
  roots: string[]
): string | undefined {
  if (commandLeavesWorkspace(command, cwd, roots)) return 'cwd escape';
  if (corpus && hasUntrustedInstructions(corpus) && commandEvaluatesCode(command)) {
    return 'eval escape induced by untrusted content';
  }
  return undefined;
}

/**
 * Default-FAIL gate for PreToolUse / bash entry.
 * High-privilege tools are blocked when cwd is dangerous or induction is untrusted.
 */
export function evaluateDefaultDenyPolicy(input: DefaultDenyInput): DefaultDenyDecision {
  if (!isHighPrivilegeTool(input.tool)) {
    return { allow: true, defaultFail: true };
  }
  const cwdCheck = isDangerousCwd(input.cwd, input.workspaceRoots, input.cwdUntrusted);
  if (cwdCheck.dangerous) {
    return {
      allow: false,
      reason: `[default-deny] high-privilege tool "${input.tool}" blocked: ${cwdCheck.reason}`,
      defaultFail: true
    };
  }
  const induction = detectUntrustedInduction(input.inductionText);
  if (induction.induced) {
    return {
      allow: false,
      reason: `[default-deny] high-privilege tool "${input.tool}" blocked: untrusted induction (${induction.marker})`,
      defaultFail: true
    };
  }
  const escape = untrustedEscapeReason(
    input.command ?? input.inductionText ?? '',
    input.untrustedCorpus,
    input.cwd ?? '',
    input.workspaceRoots ?? []
  );
  if (escape) {
    return {
      allow: false,
      reason: `[default-deny] high-privilege tool "${input.tool}" blocked: ${escape}`,
      defaultFail: true
    };
  }
  return { allow: true, defaultFail: true };
}
