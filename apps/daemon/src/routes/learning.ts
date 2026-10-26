import { LearningService, SourceLedger, StepInboxStore, ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
export function learningRoutes(runtime: RawAgentRuntime): RouteSpec[] {
    const svc = new LearningService(runtime.store, runtime.stateDir, runtime.modelAdapter), sources = new SourceLedger(runtime.store), queue = new StepInboxStore(runtime.store.db);
    const busy = new Set<string>();
    return [
        { method: 'GET', pattern: '/api/sessions/:id/learning', handler: ({ requireParam, response }) => { const sid = requireParam('id'); runtime.getSession(sid); json(response, 200, { cases: svc.list(sid), reports: svc.list(sid, 'report'), candidates: svc.list(sid, 'candidate'), versions: svc.versions(sid), sources: sources.entries(sid), scope: sources.settings(sid), queue: queue.history(sid), queueSettings: queue.settings(sid) }); } },
        { method: 'POST', pattern: '/api/sessions/:id/learning', handler: async ({ requireParam, readBody, response }) => {
                const sid = requireParam('id');
                if (!runtime.getSession(sid))
                    throw new ValidationError('Session not found');
                const raw = await readBody() as Record<string, unknown>;
                if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                    throw new ValidationError('Invalid learning action');
                if (busy.has(sid))
                    throw new ValidationError('An evaluation is already running');
                busy.add(sid);
                try {
                    let result: unknown;
                    switch (raw.action) {
                        case 'capture':
                            result = svc.capture(sid, raw);
                            break;
                        case 'replay':
                            if (typeof raw.id !== 'string' || typeof raw.skill !== 'string' || raw.skill.length > 20000)
                                throw new ValidationError('Invalid replay');
                            result = await svc.replay(sid, raw.id, raw.skill);
                            break;
                        case 'validate':
                            result = await svc.validateSkill(sid, raw);
                            break;
                        case 'publish':
                            result = svc.publish(sid, String(raw.id));
                            await runtime.reloadWorkspaceSkills();
                            break;
                        case 'rollback':
                            result = svc.rollback(sid, String(raw.id), String(raw.expectedDigest));
                            await runtime.reloadWorkspaceSkills();
                            break;
                        case 'scope':
                            result = sources.configure(sid, raw);
                            break;
                        case 'queue':
                            result = queue.configure(sid, raw);
                            break;
                        default: throw new ValidationError('Unknown learning action');
                    }
                    json(response, 200, result);
                }
                finally {
                    busy.delete(sid);
                }
            } }
    ];
}
