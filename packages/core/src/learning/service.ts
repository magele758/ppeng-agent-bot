import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteStateStore } from '../storage.js';
import type { ModelAdapter, SessionMessage, ToolContract, AgentSpec } from '../types.js';
import { createId, nowIso } from '../id.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import { redactToolContent } from '../sandbox/result-redaction.js';
import { SkillProposalStore, userSkillsDir } from '../skill-proposals/store.js';
import { validateSkillProposalDraft, findSecretLikeContent } from '../skill-proposals/validate.js';
import { botSkillId } from '../skills/bot-scope.js';
import { stableJson } from '../cron/notification-decision.js';
const hash = (v: unknown) => createHash('sha256').update(stableJson(v)).digest('hex');
const scrub = (s: string) => redactToolContent(s, process.env).replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]').replace(/\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]{12,}/g, '[SECRET]');
export interface CorrectionCase {
    id: string;
    sessionId: string;
    sourceMessageId: string;
    sourceRefs: string[];
    status: 'draft';
    kind: 'regression' | 'counterexample';
    messages: SessionMessage[];
    fixtures: {
        name: string;
        input: Record<string, unknown>;
        content: string;
        ok: boolean;
    }[];
    expected: string[];
    forbiddenText: string[];
    forbiddenTools: string[];
    createdAt: string;
}
export interface ReplayReport {
    id: string;
    caseId: string;
    passed: boolean;
    missingEvidence: boolean;
    output: string;
    calls: string[];
    failures: string[];
    durationMs: number;
    inputTokens: number | null;
    createdAt: string;
}
interface Candidate {
    id: string;
    sessionId: string;
    name: string;
    description: string;
    body: string;
    digest: string;
    baselineDigest: string;
    ownerBotId: string;
    caseIds: string[];
    baseline: ReplayReport[];
    candidate: ReplayReport[];
    passed: boolean;
    createdAt: string;
    publishedVersion?: string;
}
interface SkillVersion {
    id: string;
    name: string;
    sessionId: string;
    content: string;
    digest: string;
    createdAt: string;
    proposalId: string;
}
function strings(raw: unknown, key: string): string[] { if (raw === undefined)
    return []; if (!Array.isArray(raw) || raw.length > 20 || raw.some(x => typeof x !== 'string' || !x.trim() || x.length > 500))
    throw new ValidationError('Invalid ' + key); return raw.map(x => scrub(x.trim())); }
export class LearningService {
    constructor(private store: SqliteStateStore, private stateDir: string, private adapter: ModelAdapter) { store.db.exec('CREATE TABLE IF NOT EXISTS learning_records(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL)'); }
    private save<T extends {
        id: string;
        sessionId: string;
    }>(kind: string, value: T): void { this.store.db.prepare('INSERT INTO learning_records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(value.id, value.sessionId, kind, JSON.stringify(value)); }
    list<T = CorrectionCase>(sessionId: string, kind = 'case'): T[] { return this.store.db.prepare('SELECT payload FROM learning_records WHERE session_id=? AND kind=? ORDER BY rowid DESC LIMIT 200').all(sessionId, kind).map(r => JSON.parse(String(r.payload))); }
    get<T = CorrectionCase>(sessionId: string, id: string, kind = 'case'): T { const row = this.store.db.prepare('SELECT payload FROM learning_records WHERE id=? AND session_id=? AND kind=?').get(id, sessionId, kind); if (!row)
        throw new NotFoundError('Learning record'); return JSON.parse(String(row.payload)); }
    capture(sessionId: string, raw: Record<string, unknown>): CorrectionCase {
        const all = this.store.listMessages(sessionId);
        const target = all.findIndex(m => m.id === raw.messageId);
        if (target < 0)
            throw new NotFoundError('Source message');
        const lastUser = all.slice(0, target + 1).findLastIndex(m => m.role === 'user');
        if (lastUser < 0)
            throw new ValidationError('No preceding user request');
        const expected = strings(raw.expected, 'expected'), forbiddenText = strings(raw.forbiddenText, 'forbiddenText'), forbiddenTools = strings(raw.forbiddenTools, 'forbiddenTools');
        if (forbiddenTools.some(x => !/^[-\w.]{1,100}$/.test(x)))
            throw new ValidationError('Invalid forbidden tool name');
        if (!expected.length && !forbiddenText.length && !forbiddenTools.length)
            throw new ValidationError('At least one explicit assertion is required');
        let messages = all.slice(Math.max(0, lastUser - 12), lastUser + 1).filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ ...m, parts: m.parts.filter(p => p.type === 'text') }));
        // Replay starts from textual requests, never an orphaned original tool wave.
        if (raw.prompt !== undefined) {
            if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 4000)
                throw new ValidationError('Invalid variant prompt');
            messages = messages.map((m, i) => i === messages.length - 1 ? { ...m, parts: [{ type: 'text', text: raw.prompt as string }] } : m);
        }
        if (raw.kind === 'counterexample' && raw.prompt === undefined)
            throw new ValidationError('Counterexample requires an explicit variant task');
        const calls = new Map<string, {
            name: string;
            input: Record<string, unknown>;
        }>();
        const fixtures: CorrectionCase['fixtures'] = [];
        for (const m of all.slice(lastUser, target + 1))
            for (const p of m.parts) {
                if (p.type === 'tool_call')
                    calls.set(p.toolCallId, p);
                if (p.type === 'tool_result') {
                    const c = calls.get(p.toolCallId);
                    if (c)
                        fixtures.push({ ...c, content: p.content, ok: p.ok });
                }
            }
        const value: CorrectionCase = { id: createId('case'), sessionId, sourceMessageId: all[target]!.id, sourceRefs: all.slice(lastUser, target + 1).map(m => m.id), status: 'draft', kind: raw.kind === 'counterexample' ? 'counterexample' : 'regression', messages, fixtures, expected, forbiddenText, forbiddenTools, createdAt: nowIso() };
        if (JSON.stringify(value).length > 100000)
            throw new ValidationError('Selected evidence exceeds 100 KB; select a shorter span');
        const sanitize = (v: unknown): unknown => typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map(sanitize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)])) : v;
        const clean = sanitize(value) as CorrectionCase;
        if (findSecretLikeContent(JSON.stringify(clean)))
            throw new ValidationError('Evidence contains credentials that cannot be safely retained');
        this.save('case', clean);
        return clean;
    }
    async replay(sessionId: string, id: string, skill: string): Promise<ReplayReport> {
        const c = this.get(sessionId, id);
        const messages = structuredClone(c.messages);
        const calls: string[] = [];
        const failures: string[] = [];
        let missingEvidence = false, output = '', tokens = 0, known = false, ended = false;
        const names = [...new Set([...c.fixtures.map(f => f.name), ...c.forbiddenTools])];
        const tools: ToolContract[] = names.map(name => ({ name, description: 'Recorded replay fixture only. No external execution.', inputSchema: { type: 'object', additionalProperties: true }, sideEffectLevel: 'none', approvalMode: 'never', execute: async () => { throw new Error('Replay must not invoke a tool executor'); } }));
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        try {
            for (let turn = 0; turn < 6; turn++) {
                const result = await Promise.race([this.adapter.runTurn({ agent: this.store.getAgent(this.store.getSession(sessionId)!.agentId) ?? ({ id: 'replay', name: 'Replay', role: 'assistant', instructions: '', capabilities: [] } as AgentSpec), sessionId, systemPrompt: 'You are running an isolated behavior evaluation. Follow the user task using supplied tools.\nCandidate skill instructions:\n' + skill, messages, tools, signal: controller.signal }), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Replay timeout')), { once: true }))]);
                if (result.usage?.inputTokens !== undefined) {
                    known = true;
                    tokens += result.usage.inputTokens;
                }
                const parts = result.assistantParts;
                messages.push({ id: createId('replay'), sessionId, role: 'assistant', parts, createdAt: nowIso() });
                output += parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
                const requested = parts.filter(p => p.type === 'tool_call');
                if (!requested.length) {
                    ended = true;
                    break;
                }
                for (const p of requested) {
                    calls.push(p.name);
                    if (c.forbiddenTools.includes(p.name))
                        failures.push('forbidden_tool:' + p.name);
                    const fixture = c.fixtures.find(f => f.name === p.name && stableJson(f.input) === stableJson(p.input));
                    if (!fixture) {
                        missingEvidence = true;
                        failures.push('missing_fixture:' + p.name);
                    }
                    messages.push({ id: createId('fixture'), sessionId, role: 'tool', createdAt: nowIso(), parts: [{ type: 'tool_result', toolCallId: p.toolCallId, name: p.name, ok: fixture?.ok ?? false, content: fixture?.content ?? 'No recorded evidence for this tool and input. No operation was performed.' }] });
                }
                if (missingEvidence)
                    break;
            }
        }
        catch (error) {
            failures.push('model_error:' + scrub(String(error)).slice(0, 500));
        }
        finally {
            clearTimeout(timer);
        }
        if (!ended && !missingEvidence)
            failures.push('turn_limit_or_interruption');
        for (const text of c.expected)
            if (!output.includes(text))
                failures.push('expected_missing:' + text);
        for (const text of c.forbiddenText)
            if (output.includes(text))
                failures.push('forbidden_text:' + text);
        const report: ReplayReport = { id: createId('eval'), caseId: id, passed: failures.length === 0 && !missingEvidence, missingEvidence, output: scrub(output).slice(0, 16000), calls, failures, durationMs: Date.now() - started, inputTokens: known ? tokens : null, createdAt: nowIso() };
        this.save('report', { ...report, sessionId });
        return report;
    }
    private path(sessionId: string, name: string): string { const s = this.store.getSession(sessionId); if (!s)
        throw new NotFoundError('Session'); const botId = typeof s.metadata?.botId === 'string' ? s.metadata.botId : undefined; if (!botId)
        throw new ValidationError('Verified skills require a Bot-owned session'); return join(userSkillsDir(this.stateDir), '.bots', botSkillId(botId, name), 'SKILL.md'); }
    private content(sessionId: string, name: string): string { const path = this.path(sessionId, name); return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
    async validateSkill(sessionId: string, raw: Record<string, unknown>): Promise<Candidate> {
        const draft = validateSkillProposalDraft(raw);
        const caseIds = strings(raw.caseIds, 'caseIds');
        if (caseIds.length < 2 || new Set(caseIds).size !== caseIds.length)
            throw new ValidationError('Select distinct regression and counterexample cases');
        const cases = caseIds.map(id => this.get(sessionId, id));
        if (!cases.some(c => c.kind === 'regression') || !cases.some(c => c.kind === 'counterexample'))
            throw new ValidationError('Both regression and counterexample are required');
        const baselineBody = this.content(sessionId, draft.name);
        if ((baselineBody.match(/^shared-bots:(.*)$/m)?.[1]?.trim() ?? '[]') !== '[]')
            throw new ConflictError('Verified release requires an unshared Bot-local skill');
        const baseline: ReplayReport[] = [], candidate: ReplayReport[] = [];
        for (const id of caseIds) {
            baseline.push(await this.replay(sessionId, id, baselineBody));
            candidate.push(await this.replay(sessionId, id, draft.body));
        }
        const value: Candidate = { ...draft, id: createId('candidate'), sessionId, digest: hash(draft), baselineDigest: hash(baselineBody), ownerBotId: String(this.store.getSession(sessionId)!.metadata!.botId), caseIds, baseline, candidate, passed: candidate.every(r => r.passed), createdAt: nowIso() };
        this.save('candidate', value);
        return value;
    }
    publish(sessionId: string, id: string): SkillVersion {
        const c = this.get<Candidate>(sessionId, id, 'candidate');
        if (c.publishedVersion)
            return this.get(sessionId, c.publishedVersion, 'version');
        if (!c.passed || c.digest !== hash({ name: c.name, description: c.description, body: c.body }))
            throw new ConflictError('Candidate has no passing current evaluation');
        const current = this.content(sessionId, c.name);
        if (hash(current) !== c.baselineDigest)
            throw new ConflictError('Installed skill changed; evaluate again');
        const ownerBotId = String(this.store.getSession(sessionId)!.metadata!.botId);
        if (ownerBotId !== c.ownerBotId)
            throw new ConflictError('Skill owner changed');
        const proposals = new SkillProposalStore(this.stateDir);
        // The validated release is Bot-local. No sharing or tool/permission changes are accepted here.
        if (current)
            this.save('version', { id: createId('version'), sessionId, name: c.name, content: current, digest: hash(current), createdAt: nowIso(), proposalId: 'previous' });
        const p = proposals.create({ sessionId, ownerBotId, name: c.name, description: c.description, body: c.body });
        proposals.approve(p.id);
        const content = this.content(sessionId, c.name);
        const v: SkillVersion = { id: createId('version'), sessionId, name: c.name, content, digest: hash(content), createdAt: nowIso(), proposalId: p.id };
        this.save('version', v);
        this.save('candidate', { ...c, publishedVersion: v.id });
        return v;
    }
    rollback(sessionId: string, id: string, expectedDigest: string): SkillVersion {
        const v = this.get<SkillVersion>(sessionId, id, 'version');
        if (v.content.match(/^owner-bot:(.*)$/m)?.[1]?.trim() !== this.store.getSession(sessionId)?.metadata?.botId)
            throw new ConflictError('Version owner changed');
        if (hash(v.content) !== v.digest)
            throw new ConflictError('Version content changed');
        const current = this.content(sessionId, v.name);
        if (hash(current) !== expectedDigest)
            throw new ConflictError('Installed version changed');
        if ((v.content.match(/^shared-bots:(.*)$/m)?.[1]?.trim() ?? '[]') !== '[]')
            throw new ConflictError('Rollback cannot expand skill sharing');
        const path = this.path(sessionId, v.name);
        const temp = path + '.restore';
        writeFileSync(temp, v.content, { mode: 0o600 });
        renameSync(temp, path);
        const next = { ...v, id: createId('version'), createdAt: nowIso() };
        this.save('version', next);
        return next;
    }
    versions(sessionId: string) { return this.list<SkillVersion>(sessionId, 'version').map(v => ({ ...v, currentDigest: hash(this.content(sessionId, v.name)) })); }
}
