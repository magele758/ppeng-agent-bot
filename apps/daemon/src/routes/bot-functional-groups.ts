import { BotFunctionalGroupService, ValidationError, resolveBotPrincipal, type BotSharedScope, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteContext, RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

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
  {method:'DELETE',pattern:'/api/bot-functional-groups/:id',handler:ctx=>{service.delete(principal(ctx),ctx.requireParam('id'));json(ctx.response,200,{ok:true});}},
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
