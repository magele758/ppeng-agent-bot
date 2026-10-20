import { describe, expect, it } from 'vitest';
import {
  checkShellPolicy,
  countSimilarSearchRuns,
  isCodeSearchCommand,
  isDirectoryBrowseCommand,
  isGuiLaunchCommand,
  isUnboundedFsWalk,
  searchesAreSimilar,
  shellHistoryFromFold,
  shellPolicyBlock,
  toolCallSignature,
  type HistoryEntry,
} from './shell-policy.js';

const bash = (command: string, ok = true): HistoryEntry => ({ name: 'bash', args: { command }, ok });

describe('shell-policy static checks', () => {
  it('blocks GUI launchers but not ordinary open-ended commands', () => {
    expect(isGuiLaunchCommand('open ~/Downloads')).toBe(true);
    expect(isGuiLaunchCommand('open -a Safari')).toBe(true);
    expect(isGuiLaunchCommand('xdg-open report.pdf')).toBe(true);
    expect(isGuiLaunchCommand('git open-pr')).toBe(false);
    expect(isGuiLaunchCommand('echo open')).toBe(false);
    expect(shellPolicyBlock('open /Applications').blocked).toBe(true);
  });

  it('flags unbounded filesystem walks only on system-wide roots without a depth cap', () => {
    expect(isUnboundedFsWalk('find / -name "*.log"')).toBe(false);
    expect(isUnboundedFsWalk('find /usr -name "*.so"')).toBe(true);
    expect(isUnboundedFsWalk('find /usr -maxdepth 2 -name "*.so"')).toBe(false);
    expect(isUnboundedFsWalk('du -sh ~/')).toBe(true);
    expect(isUnboundedFsWalk('du --max-depth=1 ~/')).toBe(false);
    expect(isUnboundedFsWalk('ls src')).toBe(false);
    expect(shellPolicyBlock('find /home -type f').reason).toMatch(/maxdepth/);
  });

  it('classifies browse vs search commands', () => {
    expect(isDirectoryBrowseCommand('ls -la src')).toBe(true);
    expect(isDirectoryBrowseCommand('tree -L 2')).toBe(true);
    expect(isDirectoryBrowseCommand('cat README.md')).toBe(false);
    expect(isCodeSearchCommand('rg foo src')).toBe(true);
    expect(isCodeSearchCommand('git grep TODO')).toBe(true);
    expect(isCodeSearchCommand('pnpm run build')).toBe(false);
  });
});

describe('shell-policy history gating', () => {
  it('lets a fresh command through', () => {
    expect(checkShellPolicy('rg createId src', [])).toEqual({ blocked: false });
  });

  it('blocks a directory browse loop after dirBrowseLimit', () => {
    const history = Array.from({ length: 8 }, (_, i) => bash(`ls src/dir${i}`));
    const decision = checkShellPolicy('ls src/another', history);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/Directory browse limit/);
    expect(checkShellPolicy('ls src/another', history.slice(0, 7)).blocked).toBe(false);
  });

  it('blocks repeated similar searches before the global search cap', () => {
    const history = [bash('rg "foldSurface" src'), bash('grep foldSurface -r src')];
    expect(countSimilarSearchRuns(history, 'rg foldSurface packages')).toBe(2);
    const decision = checkShellPolicy('rg foldSurface packages', history);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/Similar search repeated/);
    // A genuinely different query is still allowed under the cap.
    expect(checkShellPolicy('rg RiskEngine packages', history).blocked).toBe(false);
  });

  it('blocks once the total search budget is exhausted regardless of similarity', () => {
    const history = [bash('rg a'), bash('rg b'), bash('rg c'), bash('rg d')];
    const decision = checkShellPolicy('rg zzz', history);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/Code search limit/);
  });

  it('does not treat ssh payloads as local browsing [AC:bypass-remote-shell#AC-3]', () => {
    const heredoc = "ssh -o BatchMode=yes Win4090 \"wsl -d Ubuntu -e bash --norc --noprofile\" <<'EOF'\nfind /home/shinemo -type d\nEOF";
    const quoted = 'ssh -o BatchMode=yes Win4090 "find /home/shinemo -iname agent"';
    const history = Array.from({ length: 12 }, () => bash(heredoc));
    expect(isUnboundedFsWalk(heredoc)).toBe(false);
    expect(isDirectoryBrowseCommand(heredoc)).toBe(false);
    expect(isUnboundedFsWalk(quoted)).toBe(false);
    expect(checkShellPolicy(heredoc, history)).toEqual({ blocked: false });
    expect(checkShellPolicy(quoted, history)).toEqual({ blocked: false });
    expect(checkShellPolicy("ssh host 'ls /usr && du ~/'", history).blocked).toBe(false);
  });

  it('still blocks local directory browsing and unbounded walks [AC:bypass-remote-shell#AC-4]', () => {
    const history = Array.from({ length: 8 }, (_, i) => bash(`ls src/dir${i}`));
    const decision = checkShellPolicy('ls src/another', history);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toMatch(/Directory browse limit/);
    expect(isUnboundedFsWalk('find /home -type d')).toBe(true);
    expect(shellPolicyBlock('find /usr -type f').reason).toMatch(/maxdepth/);
    expect(isUnboundedFsWalk("find /home -type d && ssh host 'echo ok'")).toBe(true);
    expect(checkShellPolicy('ls src/ok', history.slice(0, 7)).blocked).toBe(false);
  });

  it('respects a custom config', () => {
    const history = [bash('ls a'), bash('ls b')];
    expect(checkShellPolicy('ls c', history, {
      repeatToolLimit: 2,
      dirBrowseLimit: 2,
      blockedShellStreak: 3,
      searchShellLimit: 4,
      archiveSearchStreak: 2,
      similarSearchLimit: 2,
    }).blocked).toBe(true);
  });
});

describe('shell-policy helpers', () => {
  it('searchesAreSimilar matches by quoted or bare keyword containment', () => {
    expect(searchesAreSimilar('rg "foo"', 'grep foobar src')).toBe(true);
    expect(searchesAreSimilar('rg foo', 'rg bar')).toBe(false);
    expect(searchesAreSimilar('ls', 'rg foo')).toBe(false);
  });

  it('toolCallSignature is key-order independent', () => {
    expect(toolCallSignature('bash', { b: 1, a: 2 })).toBe(toolCallSignature('bash', { a: 2, b: 1 }));
    expect(toolCallSignature('bash', { a: 1 })).not.toBe(toolCallSignature('exec', { a: 1 }));
  });

  it('shellHistoryFromFold only picks bash/exec tool_call parts', () => {
    const history = shellHistoryFromFold([
      { parts: [{ type: 'text' }] },
      { parts: [{ type: 'tool_call', name: 'bash', input: { command: 'ls' } }] },
      { parts: [{ type: 'tool_call', name: 'read_file', input: { path: 'x' } }] },
      { parts: [{ type: 'tool_call', name: 'exec', input: { command: 'rg x' } }] },
    ]);
    expect(history.map((h) => h.args.command)).toEqual(['ls', 'rg x']);
    expect(history.every((h) => h.ok)).toBe(true);
  });
});
