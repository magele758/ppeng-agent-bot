/**
 * Bot / session cron jobs.
 * GET/POST /api/cron/jobs, PATCH/DELETE /api/cron/jobs/:id
 * Persistence is stateDir/cron/jobs.json. Tick always runs (no RAW_AGENT_* switch).
 */

import { ValidationError, RoutineRunStore, cancelRoutineRun, retryRoutineRun, drainRoutineRuns, routineSettings, type RoutineRun, type RequestAuth, type RawAgentRuntime, type UpdateCronJobInput } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { visibleCronJobs, sessionVisible } from '../access/visibility.js';

function publicRun(run:RoutineRun):Omit<RoutineRun,'eventBody'>{const {eventBody: _internalEventBody,...visible}=run;return visible;}

export function cronRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const host = {store:runtime.store,stateDir:runtime.stateDir,log:{warn:console.warn,info:console.info},runSession:(id:string)=>runtime.runSession(id),cancelSession:(id:string)=>runtime.cancelSession(id),isSessionRunning:(id:string)=>runtime.isSessionRunning(id),hasUnconfirmedEffects:(id:string,startedAt:string)=>runtime.connectors.software.unconfirmedForSession(id,startedAt).length>0};
  const readRun = (id:string,auth:RequestAuth):RoutineRun | undefined => {const run=new RoutineRunStore(runtime.store).get(id);return run && sessionVisible(runtime,run.mainSessionId,auth)?run:undefined};
  return [
    {method:'GET',pattern:'/api/cron/settings',handler:({response})=>json(response,200,{settings:routineSettings(runtime.store)})},
    {method:'PATCH',pattern:'/api/cron/settings',handler:async({readBody,response})=>{const body=await readBody() as {dialogToolsEnabled?:boolean};if(typeof body.dialogToolsEnabled!=='boolean'){json(response,400,{error:'dialogToolsEnabled must be boolean'});return;}json(response,200,{settings:routineSettings(runtime.store,body)});}},
    {method:'GET',pattern:'/api/cron/jobs/:id/runs',handler:({requireParam,response,auth,url})=>{const beforeText=url.searchParams.get('before');const before=beforeText===null?undefined:Number(beforeText);if(before!==undefined&&(!Number.isSafeInteger(before)||before<1)){json(response,400,{error:'before must be a positive cursor'});return;}const page=new RoutineRunStore(runtime.store).page(requireParam('id'),{before});const runs=page.runs.filter(run=>sessionVisible(runtime,run.mainSessionId,auth)).map(publicRun);json(response,200,{runs,...(page.nextCursor?{nextCursor:page.nextCursor}:{})});}},
    {method:'GET',pattern:'/api/cron/runs/:id',handler:({requireParam,response,auth})=>{const run=readRun(requireParam('id'),auth);json(response,run?200:404,run?{run:publicRun(run)}:{error:'Run not found'});}},
    {method:'POST',pattern:'/api/cron/runs/:id/retry',handler:async({requireParam,response,auth,readBody})=>{const prior=readRun(requireParam('id'),auth);if(!prior){json(response,404,{error:'Run not found'});return;}const body=(prior.status==='unknown'||(prior.sessionId&&host.hasUnconfirmedEffects(prior.sessionId,prior.startedAt??prior.createdAt)))?await readBody() as {confirmUnknown?:boolean}:{};const run=retryRoutineRun(host,prior.id,{confirmUnknown:body.confirmUnknown===true});await drainRoutineRuns(host);json(response,200,{run:publicRun(new RoutineRunStore(runtime.store).get(run.id)!)});}},
    {method:'POST',pattern:'/api/cron/runs/:id/cancel',handler:async({requireParam,response,auth})=>{const prior=readRun(requireParam('id'),auth);if(!prior){json(response,404,{error:'Run not found'});return;}json(response,200,{run:publicRun(await cancelRoutineRun(host,prior.id))});}},
    {
      method: 'GET',
      pattern: '/api/cron/jobs',
      handler: ({ url, response, auth }) => {
        const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
        const botId = url.searchParams.get('botId')?.trim() || undefined;
        const enabledRaw = url.searchParams.get('enabled');
        const enabled =
          enabledRaw === '1' || enabledRaw === 'true'
            ? true
            : enabledRaw === '0' || enabledRaw === 'false'
              ? false
              : undefined;
        json(response, 200, { jobs: visibleCronJobs(runtime, runtime.listCronJobs({ sessionId, botId, enabled }), auth) });
      }
    },
    {
      method: 'POST',
      pattern: '/api/cron/jobs',
      handler: async ({ readBody, response, auth }) => {
        const body = (await readBody()) as Record<string, unknown>;
        if ('expiresAt' in body && body.expiresAt !== null && typeof body.expiresAt !== 'string') throw new ValidationError('expiresAt must be an ISO timestamp or null');
        const cron = typeof body.cron === 'string' ? body.cron : undefined;
        const event = typeof body.event === 'string' ? body.event : undefined;
        const job = runtime.createCronJob({
          ...(auth.user ? {userId:auth.user.id,tenantId:auth.user.tenantId}:{}),
          ...('expiresAt' in body ? {expiresAt:body.expiresAt as string|null}:{}),
          ...(typeof body.onceAt === 'string' ? {onceAt:body.onceAt}:{}),
          ...(typeof body.intervalMs === 'number' ? {intervalMs:body.intervalMs}:{}),
          ...(typeof body.timezone === 'string' ? {timezone:body.timezone}:{}),
          ...(typeof body.missedPolicy === 'string' ? {missedPolicy:body.missedPolicy as 'coalesce'|'skip'|'catch_up'}:{}),
          name: typeof body.name === 'string' ? body.name : '',
          prompt: typeof body.prompt === 'string' ? body.prompt : '',
          ...(cron !== undefined ? { cron } : {}),
          ...(event !== undefined ? { event } : {}),
          ...(typeof body.secretEnv === 'string' ? { secretEnv: body.secretEnv } : {}),
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          botId: typeof body.botId === 'string' ? body.botId : undefined,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          ...('precheck' in body ? { precheck: body.precheck } : {})
        });
        json(response, 201, { job });
      }
    },
    {
      method: 'GET',
      pattern: '/api/cron/jobs/:id',
      handler: ({ requireParam, response }) => {
        json(response, 200, { job: runtime.getCronJob(requireParam('id')) });
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/cron/jobs/:id',
      handler: async ({ requireParam, readBody, response }) => {
        const body = (await readBody()) as Record<string, unknown>;
        if ('expiresAt' in body && body.expiresAt !== null && typeof body.expiresAt !== 'string') throw new ValidationError('expiresAt must be an ISO timestamp or null');
        const patch: UpdateCronJobInput = {};
        if ('expiresAt' in body) patch.expiresAt=body.expiresAt as string|null;
        if (typeof body.name === 'string') patch.name = body.name;
        if (typeof body.prompt === 'string') patch.prompt = body.prompt;
        if (typeof body.cron === 'string') patch.cron = body.cron;
        if (typeof body.onceAt === 'string') patch.onceAt=body.onceAt;
        if (typeof body.intervalMs === 'number') patch.intervalMs=body.intervalMs;
        if (typeof body.event === 'string') patch.event=body.event;
        if (typeof body.secretEnv === 'string') patch.secretEnv=body.secretEnv;
        if (typeof body.timezone === 'string') patch.timezone=body.timezone;
        if (typeof body.missedPolicy === 'string') patch.missedPolicy=body.missedPolicy as 'coalesce'|'skip'|'catch_up';
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if ('precheck' in body) patch.precheck = body.precheck;
        json(response, 200, { job: runtime.updateCronJob(requireParam('id'), patch) });
      }
    },
    {
      method: 'DELETE',
      pattern: '/api/cron/jobs/:id',
      handler: ({ requireParam, response }) => {
        runtime.deleteCronJob(requireParam('id'));
        json(response, 200, { ok: true });
      }
    }
  ];
}
