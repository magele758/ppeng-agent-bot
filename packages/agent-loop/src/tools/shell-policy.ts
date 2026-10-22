/**
 * Shell Policy — from chrome-plugin-gemini lib/agent/shell-policy.js
 *
 * Hard stops for shell commands: GUI launchers, unbounded filesystem walks,
 * browse loops, and repeated identical searches.
 * Prevents agent from spinning in low-value exploration.
 */

export interface ShellPolicyConfig {
  repeatToolLimit: number;
  dirBrowseLimit: number;
  blockedShellStreak: number;
  searchShellLimit: number;
  archiveSearchStreak: number;
  similarSearchLimit: number;
}

export const DEFAULT_SHELL_POLICY_CONFIG: ShellPolicyConfig = {
  repeatToolLimit: 2,
  dirBrowseLimit: 8,
  blockedShellStreak: 3,
  searchShellLimit: 4,
  archiveSearchStreak: 2,
  similarSearchLimit: 2,
};

export interface PolicyDecision {
  blocked: boolean;
  reason?: string;
}

export interface HistoryEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

// ============================================================================
// GUI Launch Detection
// ============================================================================

const GUI_OPEN_RE = /(?:^|[\s;&|`($'"])(?:\/(?:usr\/)?bin\/)?open\s+(?:(?:-[A-Za-z]+|--)\s+)*['"]?(?:\/|~|\.|\.\.\/|\$HOME)/i;
const GUI_OPEN_FLAG_RE = /(?:^|[\s;&|`($'"])(?:\/(?:usr\/)?bin\/)?open\s+-[WwAa]/i;
const GUI_XDG_RE = /\bxdg-open\b|\bgio\s+open\b|\bnautilus\b|\bdolphin\b|\bnemo\b|\bexplorer(?:\.exe)?\b/i;

export function isGuiLaunchCommand(cmd: string): boolean {
  return GUI_OPEN_RE.test(cmd) || GUI_OPEN_FLAG_RE.test(cmd) || GUI_XDG_RE.test(cmd);
}

// ============================================================================
// Unbounded Filesystem Walk Detection
// ============================================================================

const DIR_CMD_RE = /(?:^|[\s;&|`($])(?:\/(?:usr\/)?bin\/)?(?:ls|find|tree|du)\b/i;

/**
 * Directory walks inside an ssh command run on the other machine.
 * Local browse limits only look at the part that stays on this machine.
 */
function commandWithoutRemoteShell(command: string): string {
  const src = String(command ?? '');
  let out = '';
  let i = 0;
  let quote: "'" | '"' | '`' | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\' && quote !== "'" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    const word = sshWordLength(src, i);
    if (word > 0) {
      const skipped = skipSshInvocation(src, i + word);
      out += skipped.localBetween;
      i = skipped.next;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function sshWordLength(src: string, i: number): number {
  if (i > 0 && /[A-Za-z0-9_]/.test(src[i - 1]!)) return 0;
  const matched = /^(?:\/(?:usr\/)?bin\/)?ssh(?![A-Za-z0-9_])/.exec(src.slice(i));
  return matched ? matched[0].length : 0;
}

function skipSshInvocation(src: string, i: number): { next: number; localBetween: string } {
  let quote: "'" | '"' | '`' | null = null;
  const heredocs: string[] = [];
  while (i < src.length) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\' && quote !== "'" && i + 1 < src.length) {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<') {
      const parsed = readHeredocDelim(src, i);
      if (parsed) {
        heredocs.push(parsed.delim);
        i = parsed.next;
        continue;
      }
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') break;
    i += 1;
  }
  if (heredocs.length === 0) return { next: i, localBetween: '' };
  let localBetween = '';
  if (src[i] !== '\n' && i < src.length) {
    const lineEnd = src.indexOf('\n', i);
    if (lineEnd === -1) return { next: src.length, localBetween: '' };
    localBetween = src.slice(i, lineEnd + 1);
    i = lineEnd + 1;
  } else if (src[i] === '\n') {
    i += 1;
  }
  for (const delim of heredocs) i = skipHeredocBody(src, i, delim);
  return { next: i, localBetween };
}

function readHeredocDelim(src: string, i: number): { delim: string; next: number } | null {
  let j = i + 2;
  if (src[j] === '<') return null;
  if (src[j] === '-') j += 1;
  while (src[j] === ' ' || src[j] === '\t') j += 1;
  const opener = src[j];
  const quoted = opener === "'" || opener === '"';
  if (quoted) j += 1;
  const start = j;
  while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
  if (j === start) return null;
  if (quoted) {
    if (src[j] !== opener) return null;
    j += 1;
  }
  return { delim: src.slice(start, j), next: j };
}

function skipHeredocBody(src: string, i: number, delim: string): number {
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const end = nl === -1 ? src.length : nl;
    const line = src.slice(i, end).replace(/\r$/, '');
    i = nl === -1 ? src.length : nl + 1;
    if (line.trim() === delim) return i;
  }
  return i;
}

export function isUnboundedFsWalk(cmd: string): boolean {
  const local = commandWithoutRemoteShell(cmd);
  if (!DIR_CMD_RE.test(local)) return false;
  // Penalize when no depth/maxdepth limit is present
  const hasDepthLimit = /--max-depth\s*=?\s*\d|-maxdepth\s+\d|-depth\s+\d/i.test(local);
  const hasPathSpecifier = /(?:\/(?:usr|etc|var|opt|home|root)\b|~\/|\$HOME\b)/.test(local);
  return hasPathSpecifier && !hasDepthLimit;
}

export function isDirectoryBrowseCommand(cmd: string): boolean {
  return DIR_CMD_RE.test(commandWithoutRemoteShell(String(cmd ?? '')));
}

// ============================================================================
// Code Search Detection
// ============================================================================

const SEARCH_BIN_RE = /(?:^|[\s;&|`($])(?:\/(?:usr\/)?bin\/)?(?:rg|grep|egrep|fgrep|ag|ack|mdfind)\b|\bgit\s+grep\b/i;

export function isCodeSearchCommand(cmd: string): boolean {
  return SEARCH_BIN_RE.test(String(cmd ?? ''));
}

export function searchKeywords(cmd: string): string[] {
  const match = /(?:rg|grep|ag|ack)\s+(?:['"](.*?)['"]|(\S+))/.exec(cmd);
  if (!match) return [];
  const kw = match[1] ?? match[2] ?? '';
  return kw ? [kw.toLowerCase()] : [];
}

export function searchesAreSimilar(a: string, b: string): boolean {
  const kwA = searchKeywords(a);
  const kwB = searchKeywords(b);
  if (!kwA.length || !kwB.length) return false;
  return kwA.some((k) => kwB.includes(k) || kwB.some((kb) => kb.includes(k) || k.includes(kb)));
}

// ============================================================================
// Tool Call Fingerprinting
// ============================================================================

export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  try {
    const sorted = Object.keys(args)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => { acc[k] = args[k]; return acc; }, {});
    return `${name}:${JSON.stringify(sorted)}`;
  } catch {
    return `${name}:{}`;
  }
}

// ============================================================================
// History Counting
// ============================================================================

export function countCompletedToolRuns(
  history: HistoryEntry[],
  name: string,
  args?: Record<string, unknown>
): number {
  if (!args) return history.filter((h) => h.name === name).length;
  const sig = toolCallSignature(name, args);
  return history.filter((h) => toolCallSignature(h.name, h.args) === sig).length;
}

export function countDirectoryBrowseRuns(history: HistoryEntry[]): number {
  return history.filter((h) => {
    const cmd = String(h.args?.['command'] ?? '');
    return isDirectoryBrowseCommand(cmd);
  }).length;
}

export function countCodeSearchRuns(history: HistoryEntry[]): number {
  return history.filter((h) => {
    const cmd = String(h.args?.['command'] ?? '');
    return isCodeSearchCommand(cmd);
  }).length;
}

export function countSimilarSearchRuns(history: HistoryEntry[], currentCmd: string): number {
  return history.filter((h) => {
    const cmd = String(h.args?.['command'] ?? '');
    return isCodeSearchCommand(cmd) && searchesAreSimilar(cmd, currentCmd);
  }).length;
}

/** Fold bash/exec tool_call parts into shell-policy history. */
export function shellHistoryFromFold(
  messages: Array<{ parts: ReadonlyArray<{ type: string; name?: string; input?: Record<string, unknown> }> }>
): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool_call') continue;
      const name = part.name ?? '';
      if (name !== 'bash' && name !== 'exec') continue;
      out.push({
        name,
        args: part.input ?? {},
        ok: true,
      });
    }
  }
  return out;
}

// ============================================================================
// Policy Check
// ============================================================================

export function shellPolicyBlock(cmd: string): PolicyDecision {
  if (isGuiLaunchCommand(cmd)) {
    return { blocked: true, reason: 'GUI launch commands are not allowed in the agent sandbox' };
  }
  if (isUnboundedFsWalk(cmd)) {
    return { blocked: true, reason: 'Unbounded filesystem walk — add --max-depth or -maxdepth N' };
  }
  return { blocked: false };
}

export interface ShellPolicyOptions {
  /** Directory browse / code search caps. GUI launch and unbounded walks always block. Default true. */
  historyLimits?: boolean;
}

export function checkShellPolicy(
  cmd: string,
  history: HistoryEntry[],
  config: ShellPolicyConfig = DEFAULT_SHELL_POLICY_CONFIG,
  options: ShellPolicyOptions = {}
): PolicyDecision {
  // Static command checks
  const staticCheck = shellPolicyBlock(cmd);
  if (staticCheck.blocked) return staticCheck;
  if (options.historyLimits === false) return { blocked: false };

  // Directory browse loop
  if (isDirectoryBrowseCommand(cmd)) {
    const count = countDirectoryBrowseRuns(history);
    if (count >= config.dirBrowseLimit) {
      return { blocked: true, reason: `Directory browse limit reached (${count}/${config.dirBrowseLimit}) — stop exploring, read what you have` };
    }
  }

  // Repeated similar code searches
  if (isCodeSearchCommand(cmd)) {
    const totalSearches = countCodeSearchRuns(history);
    if (totalSearches >= config.searchShellLimit) {
      return { blocked: true, reason: `Code search limit reached (${totalSearches}/${config.searchShellLimit}) — read existing results before searching again` };
    }
    const similarSearches = countSimilarSearchRuns(history, cmd);
    if (similarSearches >= config.similarSearchLimit) {
      return { blocked: true, reason: `Similar search repeated ${similarSearches} times — use a different query or read existing results` };
    }
  }

  return { blocked: false };
}
