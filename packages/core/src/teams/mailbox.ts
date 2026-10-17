import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createId, nowIso } from '../id.js';
import type { TeamMailboxMessage } from './types.js';
import { withFdLock } from './fd-lock.js';

const AUDIT_MAX_BYTES = 1024 * 1024;

export function sanitizeMailboxAgent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return cleaned || 'agent';
}

export function teamMailboxDir(planDir: string): string {
  return join(planDir, 'runtime', 'mailbox');
}

export interface SendTeamMailboxInput {
  planId: string;
  type: string;
  from: string;
  to: string;
  content: string;
  taskId?: string;
}

/**
 * File mailbox: `{planDir}/runtime/mailbox/<agent>.jsonl`.
 * SQLite mail-store is an optional index; the file is authoritative.
 */
export class TeamFileMailbox {
  private readonly inboxDir: string;
  private readonly auditFile: string;
  private readonly lockOptions: MailboxLockOptions;

  constructor(planDir: string, lockOptions: MailboxLockOptions = {}) {
    this.inboxDir = teamMailboxDir(planDir);
    this.auditFile = join(this.inboxDir, 'audit.jsonl');
    this.lockOptions = lockOptions;
    mkdirSync(this.inboxDir, { recursive: true });
    ensureFile(this.auditFile);
  }

  send(input: SendTeamMailboxInput): Promise<TeamMailboxMessage> {
    const message: TeamMailboxMessage = {
      id: createId('tmail'),
      planId: input.planId,
      type: input.type,
      from: sanitizeMailboxAgent(input.from),
      to: sanitizeMailboxAgent(input.to),
      content: input.content,
      taskId: input.taskId,
      createdAt: nowIso()
    };
    return withMailboxLock(this.inboxDir, () => {
      this.maybeRotateAudit();
      appendJsonLine(this.auditFile, message);
      appendJsonLine(this.inboxFile(message.to), message);
      return message;
    }, this.lockOptions);
  }

  peekInbox(agentName: string): TeamMailboxMessage[] {
    return readJsonl(this.inboxFile(sanitizeMailboxAgent(agentName)));
  }

  readInbox(agentName: string): Promise<TeamMailboxMessage[]> {
    const file = this.inboxFile(sanitizeMailboxAgent(agentName));
    return withMailboxLock(this.inboxDir, () => {
      const items = readJsonl(file);
      writeFileSync(file, '', 'utf8');
      return items;
    }, this.lockOptions);
  }

  listRecent(limit = 50): TeamMailboxMessage[] {
    return readJsonl(this.auditFile).slice(-Math.max(1, limit));
  }

  private inboxFile(agentName: string): string {
    const file = join(this.inboxDir, `${agentName}.jsonl`);
    ensureFile(file);
    return file;
  }

  private maybeRotateAudit(): void {
    try {
      if (!existsSync(this.auditFile)) return;
      const content = readFileSync(this.auditFile, 'utf8');
      if (Buffer.byteLength(content, 'utf8') <= AUDIT_MAX_BYTES) return;
      const lines = content.split('\n').filter(Boolean);
      const keep = lines.slice(Math.floor(lines.length / 2));
      writeFileSync(this.auditFile, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
    } catch {
      /* ignore rotate errors */
    }
  }
}

function ensureFile(filePath: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '', 'utf8');
}

function appendJsonLine(filePath: string, payload: unknown): void {
  ensureFile(filePath);
  appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

const MAILBOX_LOCK_WAIT_MS = 1_000;

export interface MailboxLockOptions {
  /**
   * @deprecated Ignored. The lock is an SQLite exclusive transaction on the
   * database fd, released by the kernel on close or process death. There is
   * no mtime staleness.
   */
  staleMs?: number;
  waitMs?: number;
  now?: () => number;
}

/** Serialize mailbox writers that share one plan directory under parallel load. */
export async function withMailboxLock<T>(inboxDir: string, fn: () => T | Promise<T>, options: MailboxLockOptions = {}): Promise<T> {
  mkdirSync(inboxDir, { recursive: true });
  const legacy = join(inboxDir, '.mailbox.lock');
  const dbPath = join(inboxDir, '.mailbox.lock.db');
  return withFdLock(dbPath, fn, {
    waitMs: options.waitMs ?? MAILBOX_LOCK_WAIT_MS,
    now: options.now,
    timeout: `Team mailbox lock timed out: ${legacy}`
  });
}

function readJsonl(filePath: string): TeamMailboxMessage[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  if (!content.trim()) return [];
  const out: TeamMailboxMessage[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TeamMailboxMessage);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}
