import { resolveBotPrincipal, ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteContext, RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

export function botPinSettingsRoutes(runtime: RawAgentRuntime): RouteSpec[] {
 const key = (ctx: RouteContext) => {
  const user = ctx.auth.user;
  const owner = resolveBotPrincipal(runtime.store, user ? {userId:user.id,tenantId:user.tenantId} : undefined);
  return `bot_pin_settings:${JSON.stringify([owner.tenantId,owner.userId])}`;
 };
 return [
  {method:'GET',pattern:'/api/bot-pin-settings',handler:ctx=>json(ctx.response,200,{state:runtime.store.getDaemonControl(key(ctx)) ?? null})},
  {method:'PUT',pattern:'/api/bot-pin-settings',handler:async ctx=>{
   const body = await ctx.readBody() as {state:unknown;initialize?:boolean};
   validateState(body.state);
   const storageKey = key(ctx);
   const existing = runtime.store.getDaemonControl(storageKey);
   const state = body.initialize && existing !== undefined ? existing : body.state;
   runtime.store.setDaemonControl(storageKey,state);
   json(ctx.response,200,{state});
  }}
 ];
}
function validateState(value: unknown): void {
 if (!value || typeof value !== 'object') throw new ValidationError('Invalid pin settings');
 const state = value as Record<string,unknown>;
 if (typeof state.customized !== 'boolean') throw new ValidationError('Invalid customized flag');
 for (const field of ['ids','roomIds']) validateIds(state[field]);
 if (JSON.stringify(value).length > 100000) throw new ValidationError('Pin settings too large');
}
function validateIds(value: unknown): void {
 if (!Array.isArray(value) || !value.every(id=>typeof id==='string')) throw new ValidationError('Invalid pin ids');
}
