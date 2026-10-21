/**
 * Sibling file access for bot sub-tasks.
 * The decision is pure. A ledger of newly written paths is stored by the caller.
 *
 * Files a sibling creates in the shared workspace are private until that sibling
 * marks them in metadata `forkSharedFiles` or the ledger `shared` flag.
 * Files with no sibling claim stay readable: the parent workspace, parent
 * attachments, and materials the parent bot already generated.
 * Session trees (artifacts, attachments, working-logs, images, spills) belong
 * to the session id in the path.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SIBLING_FILE_REFUSAL = 'Refused: sibling file is not shared';
export const OTHER_BOT_FILE_REFUSAL = 'Refused: other bot private file';
export const FORK_SHARED_FILES_META = 'forkSharedFiles';

const SESSION_TREES = new Set(['artifacts', 'attachments', 'working-logs', 'images', '.agent-spills']);

export interface ForkFileSession {
  id: string;
  mode?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown> | null;
}

export interface ForkFileClaim {
  path: string;
  sessionId: string;
  parentSessionId: string;
  botId?: string;
  shared?: boolean;
}

export interface ForkSiblingFileFacts {
  reader: ForkFileSession;
  sessions: readonly ForkFileSession[];
  claims: readonly ForkFileClaim[];
  workspaceRoot: string;
  stateDir: string;
  parentAttachmentPaths: readonly string[];
  parentMaterialPaths: readonly string[];
}

export type ForkFileDecision =
  | {
      allow: true;
      kind: 'not-subtask' | 'own' | 'shared' | 'parent-file' | 'parent-attachment' | 'parent-material';
    }
  | { allow: false; kind: 'sibling-private' | 'other-bot-private' };

export interface ForkSiblingStore {
  getDaemonControl?(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
  listSessions(): readonly ForkFileSession[];
  listAttachmentsForSession?(sessionId: string): readonly { localRelPath?: string }[];
  listArtifactsForSession?(sessionId: string): readonly { localRelPath?: string }[];
}

export function forkSiblingLedgerKey(parentSessionId: string): string {
  return `bot.forkSiblingFiles:${parentSessionId}`;
}

export function sessionBotId(session: ForkFileSession): string {
  const raw = session.metadata?.botId;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function parentIdOf(session: ForkFileSession): string {
  if (session.parentSessionId?.trim()) return session.parentSessionId.trim();
  const fromMeta = session.metadata?.parentSessionId;
  return typeof fromMeta === 'string' ? fromMeta.trim() : '';
}

export function normalizeClaimPath(input: string): string | undefined {
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0') || raw.startsWith('/')) return undefined;
  const parts = raw.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return undefined;
  return parts.join('/');
}

/** Realpath existing prefixes so a symlink workspace root matches a resolved tool path. */
function canonicalPath(input: string): string {
  let cur = resolve(input);
  const tail: string[] = [];
  while (true) {
    if (existsSync(cur)) {
      try {
        const real = realpathSync(cur);
        return tail.length ? join(real, ...tail) : real;
      } catch {
        return tail.length ? join(cur, ...tail) : cur;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return resolve(input);
    tail.unshift(basename(cur));
    cur = parent;
  }
}

export function relativeTo(root: string, absolutePath: string): string | undefined {
  if (!root) return undefined;
  const rel = relative(canonicalPath(root), canonicalPath(absolutePath));
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return normalizeClaimPath(rel.split(sep).join('/'));
}

export function parseForkSiblingClaims(raw: unknown): ForkFileClaim[] {
  const rows =
    raw && typeof raw === 'object' && Array.isArray((raw as { claims?: unknown }).claims)
      ? (raw as { claims: unknown[] }).claims
      : Array.isArray(raw)
        ? raw
        : [];
  const claims: ForkFileClaim[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const path = typeof item.path === 'string' ? normalizeClaimPath(item.path) : undefined;
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
    const parentSessionId = typeof item.parentSessionId === 'string' ? item.parentSessionId.trim() : '';
    if (!path || !sessionId || !parentSessionId) continue;
    const botId = typeof item.botId === 'string' && item.botId.trim() ? item.botId.trim() : undefined;
    claims.push({
      path,
      sessionId,
      parentSessionId,
      ...(botId ? { botId } : {}),
      shared: item.shared === true
    });
  }
  return claims;
}

export function claimSiblingWrite(claims: readonly ForkFileClaim[], claim: ForkFileClaim): ForkFileClaim[] {
  const path = normalizeClaimPath(claim.path);
  if (!path || !claim.sessionId || !claim.parentSessionId) return [...claims];
  const prior = claims.find((item) => item.path === path);
  const botId = claim.botId?.trim() || prior?.botId;
  const next: ForkFileClaim = {
    path,
    sessionId: claim.sessionId,
    parentSessionId: claim.parentSessionId,
    ...(botId ? { botId } : {}),
    shared: Boolean(prior?.shared || claim.shared)
  };
  return [...claims.filter((item) => item.path !== path), next];
}

export function shareSiblingPath(claims: readonly ForkFileClaim[], path: string): ForkFileClaim[] {
  const normal = normalizeClaimPath(path);
  if (!normal) return [...claims];
  return claims.map((claim) => (claim.path === normal ? { ...claim, shared: true } : claim));
}

function listedShared(session: ForkFileSession | undefined, path: string): boolean {
  const listed = session?.metadata?.[FORK_SHARED_FILES_META];
  if (!Array.isArray(listed)) return false;
  return listed.some((item) => typeof item === 'string' && normalizeClaimPath(item) === path);
}

function claimIsShared(claim: ForkFileClaim, sessions: readonly ForkFileSession[]): boolean {
  if (claim.shared) return true;
  return listedShared(
    sessions.find((session) => session.id === claim.sessionId),
    claim.path
  );
}

function foreignKind(reader: ForkFileSession, other: ForkFileSession): 'sibling-private' | 'other-bot-private' {
  const readerBot = sessionBotId(reader);
  const otherBot = sessionBotId(other);
  if (readerBot && otherBot && readerBot !== otherBot) return 'other-bot-private';
  return 'sibling-private';
}

function denialKind(facts: ForkSiblingFileFacts, claim: ForkFileClaim): 'sibling-private' | 'other-bot-private' {
  const owner = facts.sessions.find((session) => session.id === claim.sessionId);
  if (owner) return foreignKind(facts.reader, owner);
  const readerBot = sessionBotId(facts.reader);
  if (claim.botId && readerBot && claim.botId !== readerBot) return 'other-bot-private';
  return 'sibling-private';
}

function sessionFromRelative(rel: string | undefined, sessions: readonly ForkFileSession[]): ForkFileSession | undefined {
  if (!rel) return undefined;
  const parts = rel.split('/');
  const head = parts[0];
  const sessionId = parts[1];
  if (!head || !sessionId || !SESSION_TREES.has(head)) return undefined;
  return sessions.find((session) => session.id === sessionId);
}

function boundSession(facts: ForkSiblingFileFacts, absolutePath: string): ForkFileSession | undefined {
  const rels = [relativeTo(facts.stateDir, absolutePath), relativeTo(facts.workspaceRoot, absolutePath)];
  for (const rel of rels) {
    const found = sessionFromRelative(rel, facts.sessions);
    if (found) return found;
  }
  return undefined;
}

function matchesListed(listed: readonly string[], absolutePath: string, roots: readonly string[]): boolean {
  const rels = roots
    .map((root) => relativeTo(root, absolutePath))
    .filter((rel): rel is string => Boolean(rel));
  for (const item of listed) {
    const path = normalizeClaimPath(item);
    if (path && rels.includes(path)) return true;
  }
  return false;
}

function claimFor(facts: ForkSiblingFileFacts, absolutePath: string): ForkFileClaim | undefined {
  const rels = [relativeTo(facts.workspaceRoot, absolutePath), relativeTo(facts.stateDir, absolutePath)].filter(
    (rel): rel is string => Boolean(rel)
  );
  return facts.claims.find((claim) => rels.includes(claim.path));
}

export function decideForkSiblingFileRead(facts: ForkSiblingFileFacts, absolutePath: string): ForkFileDecision {
  if (facts.reader.mode !== 'subagent') return { allow: true, kind: 'not-subtask' };
  const claim = claimFor(facts, absolutePath);
  if (claim?.sessionId === facts.reader.id) return { allow: true, kind: 'own' };
  if (claim && claimIsShared(claim, facts.sessions)) return { allow: true, kind: 'shared' };
  if (claim) return { allow: false, kind: denialKind(facts, claim) };
  if (matchesListed(facts.parentAttachmentPaths, absolutePath, [facts.stateDir, facts.workspaceRoot])) {
    return { allow: true, kind: 'parent-attachment' };
  }
  if (matchesListed(facts.parentMaterialPaths, absolutePath, [facts.stateDir, facts.workspaceRoot])) {
    return { allow: true, kind: 'parent-material' };
  }
  const bound = boundSession(facts, absolutePath);
  if (bound) {
    if (bound.id === facts.reader.id) return { allow: true, kind: 'own' };
    const parent = parentIdOf(facts.reader);
    if (parent && bound.id === parent) {
      const rel = relativeTo(facts.stateDir, absolutePath) ?? relativeTo(facts.workspaceRoot, absolutePath) ?? '';
      if (rel.startsWith('attachments/') || rel.startsWith('images/')) return { allow: true, kind: 'parent-attachment' };
      return { allow: true, kind: 'parent-material' };
    }
    return { allow: false, kind: foreignKind(facts.reader, bound) };
  }
  return { allow: true, kind: 'parent-file' };
}

export function grepLinePath(line: string): string | undefined {
  const match = /:\d+:|-\d+-/.exec(line);
  if (!match || match.index <= 0) return undefined;
  return line.slice(0, match.index);
}

export function filterGrepContent(content: string, facts: ForkSiblingFileFacts, cwd: string): string {
  if (!content || content === '(no matches)') return content || '(no matches)';
  const deniedClaims = facts.claims.filter(
    (claim) => !decideForkSiblingFileRead(facts, join(resolve(facts.workspaceRoot), claim.path)).allow
  );
  const kept = content.split('\n').filter((line) => {
    if (!line) return true;
    if (deniedClaims.some((claim) => line.includes(claim.path))) return false;
    const parsed = grepLinePath(line);
    if (!parsed) return true;
    const absolutePath = isAbsolute(parsed) ? resolve(parsed) : resolve(cwd, parsed);
    return decideForkSiblingFileRead(facts, absolutePath).allow;
  });
  const text = kept.join('\n').trim();
  return text || '(no matches)';
}

export function redactHelpMessage(message: string, fragments: readonly string[]): string {
  const ordered = [...new Set(fragments.filter((fragment) => fragment.length > 1))].sort((a, b) => b.length - a.length);
  let out = message;
  for (const fragment of ordered) {
    if (!out.includes(fragment)) continue;
    out = out.split(fragment).join('[private file omitted]');
  }
  return out;
}

export function privateFileFragments(facts: ForkSiblingFileFacts): string[] {
  if (facts.reader.mode !== 'subagent') return [];
  const found = new Set<string>();
  const parent = parentIdOf(facts.reader);
  const workspace = resolve(facts.workspaceRoot);
  const state = resolve(facts.stateDir);
  for (const claim of facts.claims) {
    const absolutePath = join(workspace, claim.path);
    if (decideForkSiblingFileRead(facts, absolutePath).allow) continue;
    found.add(claim.path);
    found.add(absolutePath);
  }
  for (const session of facts.sessions) {
    if (session.id === facts.reader.id || (parent && session.id === parent)) continue;
    for (const tree of SESSION_TREES) {
      found.add(`${tree}/${session.id}`);
      found.add(join(state, tree, session.id));
      found.add(join(workspace, tree, session.id));
    }
  }
  return [...found].filter((fragment) => fragment.length > 1);
}

export function loadForkSiblingFileFacts(
  store: ForkSiblingStore,
  session: ForkFileSession,
  workspaceRoot: string,
  stateDir: string
): ForkSiblingFileFacts {
  const parent = parentIdOf(session);
  const claims = parent ? parseForkSiblingClaims(store.getDaemonControl?.(forkSiblingLedgerKey(parent))) : [];
  const attachments = parent ? store.listAttachmentsForSession?.(parent) ?? [] : [];
  const artifacts = parent ? store.listArtifactsForSession?.(parent) ?? [] : [];
  return {
    reader: session,
    sessions: [...store.listSessions()],
    claims,
    workspaceRoot,
    stateDir,
    parentAttachmentPaths: attachments.flatMap((row) => (row.localRelPath ? [row.localRelPath] : [])),
    parentMaterialPaths: artifacts.flatMap((row) => (row.localRelPath ? [row.localRelPath] : []))
  };
}

export function recordForkSiblingWrite(
  store: ForkSiblingStore,
  session: ForkFileSession,
  workspaceRoot: string,
  absolutePath: string
): void {
  if (session.mode !== 'subagent') return;
  const parentSessionId = parentIdOf(session);
  if (!parentSessionId || !store.getDaemonControl || !store.setDaemonControl) return;
  const path = relativeTo(workspaceRoot, absolutePath);
  if (!path) return;
  const botId = sessionBotId(session);
  const next = claimSiblingWrite(parseForkSiblingClaims(store.getDaemonControl(forkSiblingLedgerKey(parentSessionId))), {
    path,
    sessionId: session.id,
    parentSessionId,
    ...(botId ? { botId } : {}),
    shared: false
  });
  store.setDaemonControl(forkSiblingLedgerKey(parentSessionId), { claims: next });
}
