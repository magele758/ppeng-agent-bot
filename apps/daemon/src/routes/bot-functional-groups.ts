import { BotFunctionalGroupService, ValidationError, resolveBotPrincipal, type BotPrincipal, type BotSharedScope, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteContext, RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

import { prepareBotDeletion } from '../bot-delete.js';
import { checkOwnerRef } from '../access/enforce.js';
import { botDefinitionRef } from '../access/owners.js';

function deleteGroupMembers(
  runtime: RawAgentRuntime,
  service: BotFunctionalGroupService,
  principal: BotPrincipal,
  ctx: RouteContext,
  confirmed: unknown
): void {
  const id = ctx.requireParam('id');
  runtime.store.transaction(() => {
    const { botIds } = service.get(principal, id);
    if (!Array.isArray(confirmed) || confirmed.length !== botIds.length || botIds.some(id => !confirmed.includes(id))) {
      throw new ValidationError('Group membership changed. Refresh and confirm again.');
    }
    const deletions = botIds.map(botId => {
      if (ctx.auth.isolate) checkOwnerRef(botDefinitionRef(runtime, botId), { resource: 'bot', unowned: 'admin' }, ctx.auth);
      return prepareBotDeletion(runtime, botId);
    });
    service.delete(principal, id);
    for (const remove of deletions) remove();
  });
}

/** All group memberships and shared facts belong to the request's principal. */
export function botFunctionalGroupRoutes(runtime: RawAgentRuntime): RouteSpec[] {
 const service=new BotFunctionalGroupService(runtime.store,id=>runtime.cancelSession(id));
 const principal=(ctx:RouteContext)=>resolveBotPrincipal(runtime.store,ctx.auth.user?{userId:ctx.auth.user.id,tenantId:ctx.auth.user.tenantId}:undefined);
 const body=async(ctx:RouteContext)=>await ctx.readBody() as Record<string,unknown>;
 const target=(ctx:RouteContext):BotSharedScope=>{
   const scope=ctx.url.searchParams.get('scope');
   if(scope!=='global'&&scope!=='group'&&scope!=='room')throw new ValidationError('Invalid shared scope');
   return {scope,id:ctx.url.searchParams.get('id')??undefined};
 };
 return [
  {method:'GET',pattern:'/api/bot-functional-groups',handler:ctx=>json(ctx.response,200,{groups:service.list(principal(ctx))})},
  {method:'POST',pattern:'/api/bot-functional-groups',handler:async ctx=>{const input=await body(ctx);json(ctx.response,201,{group:service.create(principal(ctx),input.name as string)});}},
  {method:'PATCH',pattern:'/api/bot-functional-groups/:id',handler:async ctx=>{const input=await body(ctx);json(ctx.response,200,{group:service.rename(principal(ctx),ctx.requireParam('id'),input.name as string)});}},
  {method:'DELETE',pattern:'/api/bot-functional-groups/:id',handler:async ctx=>{
    if(ctx.url.searchParams.get('deleteBots')==='1')deleteGroupMembers(runtime,service,principal(ctx),ctx,(await body(ctx)).botIds);
    else service.delete(principal(ctx),ctx.requireParam('id'));
    json(ctx.response,200,{ok:true});
  }},
  {method:'PUT',pattern:'/api/bots/:id/functional-group',handler:async ctx=>{
    const input=await body(ctx);
    if(input.groupId!==null&&typeof input.groupId!=='string')throw new ValidationError('groupId must be a group id or null');
    const id=ctx.requireParam('id'),owner=principal(ctx);
    service.move(owner,id,input.groupId as string|null);
    json(ctx.response,200,{bot:{...runtime.getBot(id),functionalGroupId:service.groupIdForBot(owner,id)}});
  }},
  {method:'PUT',pattern:'/api/bot-rooms/:id/functional-group',handler:async ctx=>{
    const input=await body(ctx);
    if(input.groupId!==null&&typeof input.groupId!=='string')throw new ValidationError('groupId must be a group id or null');
    const id=ctx.requireParam('id'),owner=principal(ctx);
    service.moveRoom(owner,id,input.groupId as string|null);
    json(ctx.response,200,{roomId:id,groupId:service.groupIdForRoom(owner,id)});
  }},
  {method:'GET',pattern:'/api/bot-shared-context',handler:ctx=>json(ctx.response,200,{entries:service.getShared(principal(ctx),target(ctx))})},
  {method:'PUT',pattern:'/api/bot-shared-context',handler:async ctx=>{const input=await body(ctx);json(ctx.response,200,{entries:service.setShared(principal(ctx),target(ctx),input.entries)});}}
 ];
}
