import { clearToolExposure, inspectToolExposure, readToolExposure, writeToolExposure, TOOL_GROUPS, NotFoundError, ValidationError, type RawAgentRuntime, type SessionRecord } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { wrapSessionIdRoutes } from '../session-guard.js';
export function toolExposureRoutes(runtime: RawAgentRuntime): RouteSpec[] {
    const detail = (session: SessionRecord) => {
        runtime.syncConnectorTools();
        const agent = runtime.store.getAgent(session.agentId);
        if (!agent)
            throw new NotFoundError('Agent');
        return inspectToolExposure({ env: process.env, tools: runtime.tools, agent, session, settingsStore: runtime.store });
    };
    return [
        { method: 'GET', pattern: '/api/tool-exposure/settings', handler: ({ url, response }) => {
                const agentId = url.searchParams.get('agentId') || 'general';
                const session = { id: 'preview', agentId, mode: 'chat', metadata: {}, status: 'idle' } as SessionRecord;
                json(response, 200, { settings: readToolExposure(runtime.store), groups: [...TOOL_GROUPS, { id: 'extensions', tier: 3, labelZh: '未分类扩展', labelEn: 'Unclassified extensions', tools: [] }], agents: runtime.listAgents().map(a => ({ id: a.id, name: a.name })), ...detail(session) });
            } },
        { method: 'PATCH', pattern: '/api/tool-exposure/settings', handler: async ({ readBody, response }) => {
                const body = await readBody() as {
                    mode?: unknown;
                    agentId?: unknown;
                    groups?: unknown;
                };
                if (!body || typeof body !== 'object')
                    throw new ValidationError('Settings object required');
                if (body.groups !== undefined && (typeof body.agentId !== 'string' || !runtime.store.getAgent(body.agentId)))
                    throw new NotFoundError('Agent');
                json(response, 200, { settings: writeToolExposure(runtime.store, body) });
            } },
        ...wrapSessionIdRoutes(runtime, [
            { method: 'GET', pattern: '/api/sessions/:id/tool-exposure', handler: ({ requireParam, response }) => { const session = runtime.getSession(requireParam('id')); if (!session)
                    throw new NotFoundError('Session'); json(response, 200, detail(session)); } },
            { method: 'DELETE', pattern: '/api/sessions/:id/tool-exposure', handler: ({ requireParam, response }) => { clearToolExposure(runtime.store, requireParam('id')); json(response, 200, { ok: true }); } }
        ])
    ];
}
