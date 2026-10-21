import { BotGoalService, ValidationError, AuthorizationError, type RawAgentRuntime, type GoalSettings } from '@ppeng/agent-core';
import type { RouteContext, RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { sessionVisible } from '../access/visibility.js';

export function botGoalsRoutes(runtime:RawAgentRuntime):RouteSpec[] {
 const scope=(ctx:RouteContext,input?:Record<string,unknown>)=>{
  const id=ctx.requireParam('id');
  const sid=typeof input?.sessionId==='string'?input.sessionId:ctx.url.searchParams.get('sessionId');
  if(!sid)throw new ValidationError('sessionId is required');
  const session=runtime.getSession(sid);
  if(!session||session.metadata.botId!==id||session.metadata.canonicalBotChat!==true)throw new ValidationError('Bot session not found');
  if(!sessionVisible(runtime,sid,ctx.auth))throw new AuthorizationError('Session access denied');
  return {id,sid,service:new BotGoalService(runtime.store,Date.now,sid)};
 };
 return [
  {method:'GET',pattern:'/api/bots/:id/goals',handler:ctx=>{const {id,service}=scope(ctx);ctx.response.setHeader('cache-control','no-store');json(ctx.response,200,{goals:service.list(id),settings:service.readSettings()});}},
  {method:'PATCH',pattern:'/api/bots/:id/goals/settings',handler:async ctx=>{
   const input=await ctx.readBody() as Record<string,unknown>;const {service}=scope(ctx,input);
   const {sessionId:_,...patch}=input;
   try{json(ctx.response,200,{settings:service.updateSettings(patch as Partial<GoalSettings>)});}catch(error){throw new ValidationError(String(error));}
  }},
  {method:'POST',pattern:'/api/bots/:id/goals/:goalId/actions',handler:async ctx=>{
   const input=await ctx.readBody() as Record<string,unknown>;const {id,service}=scope(ctx,input);const gid=ctx.requireParam('goalId');
   if(!service.get(id,gid))throw new ValidationError('Goal not found');
   const action=input.action;
   if(action!=='pause'&&action!=='resume'&&action!=='cancel'&&action!=='reprioritize')throw new ValidationError('Invalid goal action');
   try{
    const goal=action==='reprioritize'?service.reprioritize(id,gid,Number(input.priority)):service.control(id,gid,action);
    if(action==='pause'||action==='cancel')for(const execution of service.executions(id,gid))if(execution.status==='running'&&execution.sessionId)runtime.cancelSession(execution.sessionId);
    json(ctx.response,200,{goal});
   }catch(error){throw new ValidationError(String(error));}
  }}
 ];
}
