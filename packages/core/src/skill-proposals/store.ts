/**
 * File-backed skill proposal queue: one JSON file per proposal under
 * `stateDir/skill-proposals/`, approved skills under `stateDir/skills/<name>/SKILL.md`.
 *
 * Why files (not daemon_control KV): bodies are up to ~20k chars and each decision
 * rewrites a single record; a KV row would rewrite the whole queue on every change.
 * Files keep the queue inspectable next to the installed skills and need no SQL migration.
 * Settings (tiny) stay in KV.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { botSkillId } from '../skills/bot-scope.js';
import { createId, nowIso } from '../id.js';
import {
  SKILL_PROPOSAL_MAX_PENDING,
  SkillProposalError,
  findSecretLikeContent,
  isValidSkillProposalName,
  validateSkillProposalDraft,
  type SkillProposalDraft
} from './validate.js';

export type SkillProposalStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** Outcome of deleting the installed skill directory on revoke. */
export type SkillRevokeOutcome = 'removed' | 'missing' | 'foreign';
export type SkillProposalKind = 'new' | 'update';

export interface SkillProposalRecord {
  id: string;
  captureId?: string;
  ownerBotId?: string;
  sharedBotIds?: string[];
  name: string;
  description: string;
  body: string;
  sessionId: string;
  agentId?: string;
  kind: SkillProposalKind;
  /** Existing skill this proposal updates (same name already in the catalog). */
  replaces?: { name: string; source?: string };
  status: SkillProposalStatus;
  createdAt: string;
  decidedAt?: string;
  rejectReason?: string;
  /** Set when an approved proposal is revoked (the approval time stays in `decidedAt`). */
  revokedAt?: string;
  revokeOutcome?: SkillRevokeOutcome;
  /** Path relative to stateDir, set once approved. */
  installedPath?: string;
}

export type SkillProposalSummary = Omit<SkillProposalRecord, 'body'> & { bodyPreview: string; bodyChars: number };

const ID_RE = /^sp_[0-9a-f]{32}$/;
const PREVIEW_CHARS = 400;

export function userSkillsDir(stateDir: string): string {
  return join(stateDir, 'skills');
}

export function skillProposalsDir(stateDir: string): string {
  return join(stateDir, 'skill-proposals');
}

export function isSkillProposalId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function summarizeSkillProposal(record: SkillProposalRecord): SkillProposalSummary {
  const { body, ...rest } = record;
  return { ...rest, bodyPreview: body.slice(0, PREVIEW_CHARS), bodyChars: body.length };
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export function renderSkillMarkdown(record: SkillProposalRecord): string {
  const skillName = record.replaces?.name ?? record.name;
  const description = record.description.replace(/"/g, "'");
  return [
    '---',
    `name: ${skillName}`,
    `description: "${description}"`,
    `proposed-by-session: ${record.sessionId}`,
    `approved-at: ${record.decidedAt ?? nowIso()}`,
    `proposal-id: ${record.id}`,
    ...(record.ownerBotId ? [`owner-bot: ${record.ownerBotId}`, `shared-bots: ${JSON.stringify(record.sharedBotIds ?? [])}`] : []),
    '---',
    '',
    record.body,
    ''
  ].join('\n');
}

export interface CreateSkillProposalInput extends SkillProposalDraft {
  captureId?: string;
  ownerBotId?: string;
  sharedBotIds?: string[];
  sessionId: string;
  agentId?: string;
  replaces?: { name: string; source?: string };
}

export class SkillProposalStore {
  constructor(private readonly stateDir: string) {
    const directory = skillProposalsDir(stateDir);
    if (!existsSync(directory)) return;
    for (const file of readdirSync(directory).filter(f => /^sp_[a-f0-9]{32}\.revoking$/.test(f))) {
      const record = this.get(file.replace(/\.revoking$/, ''));
      if (!record || !isValidSkillProposalName(record.name)) continue;
      const backup = join(directory, file);
      const target = join(userSkillsDir(stateDir), record.ownerBotId ? join('.bots', botSkillId(record.ownerBotId, record.name)) : record.name);
      if (record.status === 'approved' && !existsSync(target)) renameSync(backup, target);
      else if (record.status === 'revoked') rmSync(backup, {recursive:true,force:true});
    }
  }

  private recordPath(id: string): string {
    return join(skillProposalsDir(this.stateDir), `${id}.json`);
  }

  private write(record: SkillProposalRecord): void {
    mkdirSync(skillProposalsDir(this.stateDir), { recursive: true });
    atomicWrite(this.recordPath(record.id), JSON.stringify(record, null, 2));
  }

  list(filter?: { status?: SkillProposalStatus }): SkillProposalRecord[] {
    let files: string[];
    try {
      files = readdirSync(skillProposalsDir(this.stateDir));
    } catch {
      return [];
    }
    const out: SkillProposalRecord[] = [];
    for (const file of files) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!isSkillProposalId(id)) continue;
      const rec = this.get(id);
      if (rec && (!filter?.status || rec.status === filter.status)) out.push(rec);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): SkillProposalRecord | undefined {
    if (!isSkillProposalId(id)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.recordPath(id), 'utf8')) as SkillProposalRecord;
      return parsed && parsed.id === id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  create(input: CreateSkillProposalInput): SkillProposalRecord {
    const draft = validateSkillProposalDraft(input);
    const pending = this.list({ status: 'pending' });
    const sameName = pending.find((p) => p.name === draft.name && p.ownerBotId === input.ownerBotId);
    if (sameName) {
      if (sameName.sessionId !== input.sessionId) {
        throw new SkillProposalError(
          `a pending proposal named "${draft.name}" from another session already exists; choose a different name`,
          'conflict'
        );
      }
      rmSync(this.recordPath(sameName.id), { force: true });
    } else if (pending.length >= SKILL_PROPOSAL_MAX_PENDING) {
      throw new SkillProposalError(
        `review queue is full (${SKILL_PROPOSAL_MAX_PENDING} pending); a human must approve or reject some first`,
        'limit'
      );
    }
    const record: SkillProposalRecord = {
      id: createId('sp'),
      ...(input.captureId ? { captureId: input.captureId } : {}),
      ...draft,
      ...(input.ownerBotId ? { ownerBotId: input.ownerBotId, sharedBotIds: input.sharedBotIds ?? [] } : {}),
      sessionId: input.sessionId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      kind: input.replaces ? 'update' : 'new',
      ...(input.replaces ? { replaces: input.replaces } : {}),
      status: 'pending',
      createdAt: nowIso()
    };
    this.write(record);
    return record;
  }

  private requirePending(id: string): SkillProposalRecord {
    const record = this.get(id);
    if (!record) throw new SkillProposalError(`skill proposal ${String(id)} not found`, 'not_found');
    if (record.status !== 'pending') {
      throw new SkillProposalError(`skill proposal is already ${record.status}`, 'conflict');
    }
    return record;
  }

  /** Install into stateDir/skills/<name>/SKILL.md. Never touches repo `skills/` or ~/.agents. */
  approve(id: string): SkillProposalRecord {
    const record = this.requirePending(id);
    // Stored files can be edited out-of-band; re-check before writing anything.
    if (!isValidSkillProposalName(record.name) || basename(record.name) !== record.name) {
      throw new SkillProposalError('stored proposal has an invalid name');
    }
    const secret = findSecretLikeContent(`${record.description}\n${record.body}`);
    if (secret) {
      throw new SkillProposalError(`stored proposal looks like it contains a secret (${secret})`, 'secret');
    }
    const root = resolve(userSkillsDir(this.stateDir));
    const relativeDir = record.ownerBotId ? join('.bots', botSkillId(record.ownerBotId, record.name)) : basename(record.name);
    const dir = resolve(root, relativeDir);
    if (!dir.startsWith(root + sep)) {
      throw new SkillProposalError('resolved skill path escapes the user skills directory');
    }
    const decided: SkillProposalRecord = {
      ...record,
      status: 'approved',
      decidedAt: nowIso(),
      installedPath: join('skills', relativeDir, 'SKILL.md')
    };
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    atomicWrite(path, renderSkillMarkdown(decided));
    try {
      this.write(decided);
    } catch (error) {
      if (previous !== undefined) atomicWrite(path, previous);
      else rmSync(path, { force: true });
      throw error;
    }
    return decided;
  }

  isInstalled(record: SkillProposalRecord): boolean {
    if (!isValidSkillProposalName(record.name)) return false;
    const path = join(this.stateDir, 'skills', record.ownerBotId ? join('.bots', botSkillId(record.ownerBotId, record.name)) : record.name, 'SKILL.md');
    try {
      const head = readFileSync(path, 'utf8').split('\n').slice(0, 8);
      return head.includes(`approved-at: ${record.decidedAt}`) && head.includes(`proposed-by-session: ${record.sessionId}`) && (!head.some(line => line.startsWith('proposal-id:')) || head.includes(`proposal-id: ${record.id}`));
    } catch { return false; }
  }

  setSharing(id: string, ownerBotId: string, sharedBotIds: string[], validate: (owner: string, ids: string[]) => void): SkillProposalRecord {
    const record = this.get(id);
    if (!record || record.status !== 'approved') throw new SkillProposalError('Approved skill not found', 'not_found');
    if (!isValidSkillProposalName(record.name)) throw new SkillProposalError('Invalid skill name');
    if (record.ownerBotId && record.ownerBotId !== ownerBotId) throw new SkillProposalError('Skill owner cannot be changed', 'conflict');
    if (!Array.isArray(sharedBotIds) || sharedBotIds.some(id => typeof id !== 'string') || !ownerBotId) throw new SkillProposalError('Invalid sharing scope');
    const recipients = [...new Set(sharedBotIds)].filter(id => id !== ownerBotId);
    validate(ownerBotId, recipients);
    const oldPath = join(this.stateDir, 'skills', record.ownerBotId ? join('.bots', botSkillId(record.ownerBotId, record.name)) : record.name, 'SKILL.md');
    const before = readFileSync(oldPath, 'utf8');
    if (!this.isInstalled(record)) throw new SkillProposalError('Skill was changed by another approval', 'conflict');
    const relativeDir = join('skills', '.bots', botSkillId(ownerBotId, record.name));
    const newPath = join(this.stateDir, relativeDir, 'SKILL.md');
    if (oldPath !== newPath && existsSync(newPath)) throw new SkillProposalError('This Bot already owns a skill with that name', 'conflict');
    const next = { ...record, ownerBotId, sharedBotIds: recipients, installedPath: join(relativeDir, 'SKILL.md') };
    mkdirSync(join(this.stateDir, relativeDir), { recursive: true });
    atomicWrite(newPath, renderSkillMarkdown(next));
    try {
      if (oldPath !== newPath) rmSync(oldPath);
      this.write(next);
    } catch (error) {
      atomicWrite(oldPath, before);
      if (oldPath !== newPath) rmSync(newPath, { force: true });
      throw error;
    }
    return next;
  }

  reject(id: string, reason?: string): SkillProposalRecord {
    const record = this.requirePending(id);
    const trimmed = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    const decided: SkillProposalRecord = {
      ...record,
      status: 'rejected',
      decidedAt: nowIso(),
      ...(trimmed ? { rejectReason: trimmed } : {})
    };
    this.write(decided);
    return decided;
  }

  /**
   * Undo an approval: delete the `stateDir/skills/<name>` directory this proposal wrote and keep
   * the record as `revoked`. Only the user layer is touched, so a repo skill of the same name
   * (update proposal) becomes visible again. A directory that is gone counts as success
   * (`missing`); one whose SKILL.md no longer carries this proposal's approval stamp (edited by
   * hand or overwritten by a later approval of the same name) is left alone (`foreign`).
   */
  revoke(id: string): { proposal: SkillProposalRecord; outcome: SkillRevokeOutcome } {
    const record = this.get(id);
    if (!record) throw new SkillProposalError(`skill proposal ${String(id)} not found`, 'not_found');
    if (record.status !== 'approved') {
      throw new SkillProposalError(`only approved proposals can be revoked (this one is ${record.status})`, 'conflict');
    }
    if (!isValidSkillProposalName(record.name) || basename(record.name) !== record.name) {
      throw new SkillProposalError('stored proposal has an invalid name');
    }
    const root = resolve(userSkillsDir(this.stateDir));
    const dir = resolve(root, record.ownerBotId ? join('.bots', botSkillId(record.ownerBotId, record.name)) : record.name);
    if (!dir.startsWith(root + sep)) {
      throw new SkillProposalError('resolved skill path escapes the user skills directory');
    }
    let outcome: SkillRevokeOutcome = 'missing';
    const backup = join(skillProposalsDir(this.stateDir), `${id}.revoking`);
    if (existsSync(dir)) {
      const ours = this.isInstalled(record);
      if (ours) {
        renameSync(dir, backup);
        outcome = 'removed';
      } else {
        outcome = 'foreign';
      }
    }
    const revoked: SkillProposalRecord = {
      ...record,
      status: 'revoked',
      revokedAt: nowIso(),
      revokeOutcome: outcome
    };
    try { this.write(revoked); } catch (error) {
      if (outcome === 'removed') renameSync(backup, dir);
      throw error;
    }
    if (outcome === 'removed') {
      try { rmSync(backup, { recursive: true, force: true }); } catch { /* Already revoked; retry journal cleanup when the store reopens. */ }
    }
    return { proposal: revoked, outcome };
  }
}
