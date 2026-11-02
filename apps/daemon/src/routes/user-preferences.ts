import { resolveBotPrincipal, ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteContext, RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { mergePreferences, isUserPreferenceKey, type UserPreferences } from '../user-preferences.js';
export function userPreferenceRoutes(runtime: RawAgentRuntime): RouteSpec[] {
 const key = (ctx: RouteContext) => {
  const user = ctx.auth.user;
  const owner = resolveBotPrincipal(runtime.store,user ? {userId:user.id,tenantId:user.tenantId} : undefined);
  return `user_preferences:${JSON.stringify([owner.tenantId,owner.userId])}`;
 };
 return [
  {method:'GET',pattern:'/api/user/preferences',handler:ctx=>json(ctx.response,200,{scope:key(ctx),values:runtime.store.getDaemonControl(key(ctx)) ?? {}})},
  {method:'PATCH',pattern:'/api/user/preferences',handler:async ctx=>{
   const body = await ctx.readBody() as {values:UserPreferences;initialize?:boolean};
   validate(body.values);
   const storageKey = key(ctx);
   const values = mergePreferences(runtime.store.getDaemonControl<UserPreferences>(storageKey) ?? {},body.values,body.initialize === true);
   if (JSON.stringify(values).length > 500000) throw new ValidationError('Preferences too large');
   runtime.store.setDaemonControl(storageKey,values);
   json(ctx.response,200,{values});
  }}
 ];
}
function validate(values: unknown): asserts values is UserPreferences {
 if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ValidationError('Invalid preferences');
 for (const [key,value] of Object.entries(values)) {
  if (!isUserPreferenceKey(key) || key.length > 250) throw new ValidationError('Unknown preference');
  if (value !== null && typeof value !== 'string') throw new ValidationError('Invalid preference value');
 }
}
