/**
 * Skill self-authoring review queue.
 *   GET/PATCH /api/skill-proposals/settings   persisted in daemon_control KV (no env switch)
 *   GET       /api/skill-proposals[?status=]  summaries (body preview)
 *   GET       /api/skill-proposals/:id        full record incl. complete body
 *   POST      /api/skill-proposals/:id/approve  install into stateDir/skills/<name>/SKILL.md
 *   POST      /api/skill-proposals/:id/reject   keep the record, mark rejected (optional body.reason)
 *   POST      /api/skill-proposals/:id/revoke   approved only: delete the installed skill, mark revoked
 */

import type { RawAgentRuntime } from '@ppeng/agent-core';
import {
  ConflictError,
  readBotSkillSelection, botSkillSelectionKey,
  type SkillManagementInput,
  filterSkillsByScope,
  requestedSkillNames,
  runProfileFromSession,
  NotFoundError,
  SKILL_PROPOSAL_REMIND_MAX,
  SkillProposalError,
  SkillProposalStore,
  ValidationError,
  hasPersistedSkillProposalSettings,
  isSkillProposalId,
  parseRemindEvery,
  readSkillProposalSettings,
  summarizeSkillProposal,
  writeSkillProposalSettings,
  type SkillProposalSettingsPatch,
  type SkillProposalStatus
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { guardSession } from '../session-guard.js';

const STATUSES: readonly SkillProposalStatus[] = ['pending', 'approved', 'rejected', 'revoked'];

function mapError(error: unknown): never {
  if (error instanceof SkillProposalError) {
    if (error.code === 'not_found') throw new NotFoundError('skill proposal');
    if (error.code === 'conflict') throw new ConflictError(error.message);
    throw new ValidationError(error.message);
  }
  throw error;
}

export function skillProposalRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const store = () => new SkillProposalStore(runtime.stateDir);
  const validateSharing = (owner: string, recipients: string[]) => {
    if ([owner, ...recipients].some(id => !runtime.store.getBot(id))) throw new ValidationError('Unknown Bot in sharing scope');
  };
  const blockedBots = async (name: string, recipients: string[], skillId?: string) => {
    const results = await Promise.all(recipients.map(async id => {
      const bot = runtime.store.getBot(id); const session = bot ? runtime.store.getSession(bot.canonicalSessionId) : undefined;
      if (!session) return id;
      const effective = await runtime.promptBuilder.skillsForSession(session.id);
      const allowed = runtime.promptBuilder.getAllowedSkills(session.id);
      const available = effective.some(s => (skillId ? s.id === skillId : s.name === name) && (!allowed?.length || allowed.some(a=>[s.id,s.name].includes(a))));
      return available ? undefined : id;
    }));
    return results.filter((id): id is string => !!id);
  };
  const settingsPayload = () => {
    const settings = readSkillProposalSettings(runtime.store);
    return {
      settings,
      effective: {
        enabled: settings.enabled,
        remindEveryNToolCalls: settings.remindEveryNToolCalls,
        source: hasPersistedSkillProposalSettings(runtime.store) ? ('ui' as const) : ('default' as const)
      }
    };
  };
  const requireId = (raw: string): string => {
    if (!isSkillProposalId(raw)) throw new NotFoundError('skill proposal');
    return raw;
  };

  const botSession = (id: string) => { const bot = runtime.store.getBot(id); if (!bot) throw new NotFoundError('Bot'); return bot.canonicalSessionId; };
  const catalog = async (id: string) => {
    const sid = botSession(id);
    const skills = await runtime.skillManagement.catalog(sid);
    const effective = await runtime.promptBuilder.skillsForSession(sid);
    const allowed = runtime.promptBuilder.getAllowedSkills(sid);
    const operations = runtime.skillManagement.listForBot(id);
    const captures = runtime.listSessions().filter(s=>s.metadata?.botId===id).flatMap(s=>runtime.skillCaptures.list(s.id)).filter(c=>!operations.some(o=>o.captureId===c.id)).map(c=>({id:c.id,name:c.name,ownerBotId:id,input:{action:c.kind==='new'?'create':'update'},authorization:c.status==='pending'||c.status==='rejected'?'pending':'confirmation',status:c.status,updatedAt:c.updatedAt,error:c.error}));
    return { skills: await Promise.all(skills.map(async s => ({...s, enabled: effective.some(e => e.id === s.id) && (!allowed?.length || allowed.some(a => [s.name,s.id].includes(a))), blockedBotIds: await blockedBots(s.name,s.sharedBotIds ?? [],s.id)}))), policy: readBotSkillSelection(runtime.store,id), operations: [...operations,...captures].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)), revision: JSON.stringify([readBotSkillSelection(runtime.store,id),skills.map(s=>[s.id,s.revision])]) };
  };
  return [
    {method:'GET',pattern:'/api/bots/:id/skills',handler:async({requireParam,response})=>json(response,200,await catalog(requireParam('id')))},
    {method:'PATCH',pattern:'/api/bots/:id/skills',handler:async({requireParam,readBody,response})=>{
      const id=requireParam('id');const current=await catalog(id);const body=await readBody() as {policy:{mode:string;ids:string[]};revision:string};
      if(body.revision!==current.revision)throw new ConflictError('Skill settings changed; refresh before saving');
      if(!body.policy||!['all','selected'].includes(body.policy.mode)||!Array.isArray(body.policy.ids)||body.policy.ids.some(id=>typeof id!=='string'||!current.skills.some(s=>s.id===id)))throw new ValidationError('Invalid skill selection');
      runtime.store.setDaemonControl(botSkillSelectionKey(id),{mode:body.policy.mode,ids:body.policy.mode==='all'?[]:[...new Set(body.policy.ids)]});json(response,200,await catalog(id));
    }},
    {method:'POST',pattern:'/api/bots/:id/skills/manage',handler:async({requireParam,readBody,response})=>{
      const sid=botSession(requireParam('id'));const input=await readBody() as SkillManagementInput;
      try{const result=await runtime.skillManagement.request(sid,'human',input,'user');json(response,result.status==='failed'?409:200,result);}catch(e){throw new ValidationError(e instanceof Error?e.message:String(e));}
    }},
    {method:'GET',pattern:'/api/sessions/:id/skill-operations',handler:({requireParam,response,auth})=>{const sid=requireParam('id');guardSession(runtime,sid,auth);json(response,200,{operations:runtime.skillManagement.list(sid)});}},
    {method:'POST',pattern:'/api/sessions/:id/skill-operations/:operationId/confirm',handler:async({requireParam,response,auth})=>{const sid=requireParam('id');guardSession(runtime,sid,auth);json(response,200,{operation:await runtime.skillManagement.confirm(sid,requireParam('operationId'))});}},
    {method:'POST',pattern:'/api/sessions/:id/skill-operations/:operationId/reject',handler:({requireParam,response,auth})=>{const sid=requireParam('id');guardSession(runtime,sid,auth);json(response,200,{operation:runtime.skillManagement.reject(sid,requireParam('operationId'))});}},
    {
      method: 'GET',
      pattern: '/api/sessions/:id/skill-captures',
      handler: ({ requireParam, response, auth }) => {
        const id = requireParam('id');
        guardSession(runtime, id, auth);
        response.setHeader('cache-control', 'no-store');
        json(response, 200, { captures: runtime.skillCaptures.list(id).filter(c=>!runtime.skillManagement.list(id).some(o=>o.captureId===c.id)) });
      }
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/skill-captures/:captureId/confirm',
      handler: async ({ requireParam, response, auth, readBody }) => {
        const id = requireParam('id');
        guardSession(runtime, id, auth);
        try {
          const body = ((await readBody()) ?? {}) as { sharedBotIds?: string[] };
          const capture = await runtime.skillCaptures.confirm(id, requireParam('captureId'), body);
          json(response, 200, { capture });
        } catch (error) { mapError(error); }
      }
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/skill-captures/:captureId/reject',
      handler: ({ requireParam, response, auth }) => {
        const id = requireParam('id');
        guardSession(runtime, id, auth);
        try {
          const capture = runtime.skillCaptures.reject(id, requireParam('captureId'));
          json(response, 200, { capture });
        } catch (error) { mapError(error); }
      }
    },
    {
      method: 'GET',
      pattern: '/api/skill-proposals/settings',
      handler: ({ response }) => json(response, 200, settingsPayload())
    },
    {
      method: 'PATCH',
      pattern: '/api/skill-proposals/settings',
      handler: async ({ readBody, response }) => {
        const body = ((await readBody()) ?? {}) as Record<string, unknown>;
        const patch: SkillProposalSettingsPatch = {};
        if ('enabled' in body) {
          if (typeof body.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
          patch.enabled = body.enabled;
        }
        if ('remindEveryNToolCalls' in body) {
          const n = parseRemindEvery(body.remindEveryNToolCalls);
          if (n === undefined) {
            throw new ValidationError(
              `remindEveryNToolCalls must be an integer from 0 to ${SKILL_PROPOSAL_REMIND_MAX}`
            );
          }
          patch.remindEveryNToolCalls = n;
        }
        writeSkillProposalSettings(runtime.store, patch);
        json(response, 200, settingsPayload());
      }
    },
    {
      method: 'GET',
      pattern: '/api/skill-proposals',
      handler: async ({ url, response }) => {
        const raw = url.searchParams.get('status');
        if (raw && !STATUSES.includes(raw as SkillProposalStatus)) {
          throw new ValidationError('status must be pending, approved, rejected, or revoked');
        }
        const proposals = store().list(raw ? { status: raw as SkillProposalStatus } : undefined);
        json(response, 200, { proposals: await Promise.all(proposals.map(async p => ({ ...summarizeSkillProposal(p), installed: store().isInstalled(p), blockedBotIds: await blockedBots(p.name, p.sharedBotIds ?? []) }))) });
      }
    },
    {
      method: 'GET',
      pattern: '/api/skill-proposals/:id',
      handler: ({ requireParam, response }) => {
        const record = store().get(requireId(requireParam('id')));
        if (!record) throw new NotFoundError('skill proposal');
        json(response, 200, { proposal: record });
      }
    },
    {
      method: 'POST',
      pattern: '/api/skill-proposals/:id/approve',
      handler: async ({ requireParam, response }) => {
        const id = requireId(requireParam('id'));
        try {
          const proposal = store().approve(id);
          const skills = await runtime.reloadWorkspaceSkills();
          const shadowedBy = skills.some(
            (s) => s.source === 'agents' && s.name === (proposal.replaces?.name ?? proposal.name)
          )
            ? ('agents' as const)
            : undefined;
          json(response, 200, { proposal, ...(shadowedBy ? { shadowedBy } : {}) });
        } catch (error) {
          mapError(error);
        }
      }
    },
    {
      method: 'POST',
      pattern: '/api/skill-proposals/:id/reject',
      handler: async ({ requireParam, readBody, response }) => {
        const id = requireId(requireParam('id'));
        const body = ((await readBody()) ?? {}) as { reason?: unknown };
        try {
          const proposal = store().reject(id, typeof body.reason === 'string' ? body.reason : undefined);
          json(response, 200, { proposal });
        } catch (error) {
          mapError(error);
        }
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/skill-proposals/:id/sharing',
      handler: async ({ requireParam, readBody, response }) => {
        const body = ((await readBody()) ?? {}) as { ownerBotId: string; sharedBotIds: string[] };
        try {
          const proposal = store().setSharing(requireId(requireParam('id')), body.ownerBotId, body.sharedBotIds, validateSharing);
          await runtime.reloadWorkspaceSkills();
          json(response, 200, { proposal, blockedBotIds: await blockedBots(proposal.name, proposal.sharedBotIds ?? []) });
        } catch (error) { mapError(error); }
      }
    },
    {
      method: 'POST',
      pattern: '/api/skill-proposals/:id/revoke',
      handler: async ({ requireParam, response }) => {
        const id = requireId(requireParam('id'));
        try {
          const { proposal, outcome } = store().revoke(id);
          await runtime.reloadWorkspaceSkills();
          const hint =
            outcome === 'missing'
              ? 'skill directory was already gone; marked revoked'
              : outcome === 'foreign'
                ? 'skill directory no longer matches this approval (edited or overwritten by a later approval); left in place'
                : undefined;
          json(response, 200, { proposal, outcome, ...(hint ? { hint } : {}) });
        } catch (error) {
          mapError(error);
        }
      }
    }
  ];
}
