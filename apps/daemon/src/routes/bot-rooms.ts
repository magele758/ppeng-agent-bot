import { resolveBotPrincipal, BotQueueCapacityError, type BotRoomService, type RawAgentRuntime } from '@ppeng/agent-core';
import { randomUUID } from 'node:crypto';
import type { RouteSpec, RouteContext } from '../routing.js';
import { json } from '../http-utils.js';
import { roomModelConfiguration } from './bot-room-models.js';

/** All operations enforce Room principal ownership, including administrator requests. */
export function botRoomsRoutes(runtime: RawAgentRuntime & { rooms: BotRoomService }): RouteSpec[] {
  const rooms=runtime.rooms;
  const principal=(ctx:RouteContext)=>resolveBotPrincipal(runtime.store,ctx.auth.user?{userId:ctx.auth.user.id,tenantId:ctx.auth.user.tenantId}:undefined);
  const body=async(ctx:RouteContext)=>await ctx.readBody() as Record<string,unknown>;
  const wake=()=>{void rooms.tick();};
  return [
    {method:'GET',pattern:'/api/bot-rooms',handler:ctx=>{json(ctx.response,200,{rooms:rooms.list(principal(ctx))});}},
    {method:'POST',pattern:'/api/bot-rooms',handler:async ctx=>{const input=await body(ctx);const room=rooms.create(principal(ctx),{title:typeof input.title==='string'?input.title:'',botIds:input.botIds as string[],hostBotId:input.hostBotId as string|undefined,maxBotTurns:input.maxBotTurns as number|undefined,maxToolCalls:input.maxToolCalls as number|undefined,maxCostUsd:input.maxCostUsd as number|undefined});json(ctx.response,201,{room});}},
    {method:'GET',pattern:'/api/bot-rooms/settings',handler:ctx=>{json(ctx.response,200,{settings:rooms.readSettings()});}},
    {method:'PATCH',pattern:'/api/bot-rooms/settings',handler:async ctx=>{const input=await body(ctx);json(ctx.response,200,{settings:rooms.writeSettings(input)});}},
    {method:'GET',pattern:'/api/bot-rooms/:id',handler:ctx=>{const owner=principal(ctx);const room=rooms.get(owner,ctx.requireParam('id'));json(ctx.response,200,{room,models:roomModelConfiguration(runtime,room,owner)});}},
    {method:'DELETE',pattern:'/api/bot-rooms/:id',handler:ctx=>{rooms.delete(principal(ctx),ctx.requireParam('id'));json(ctx.response,200,{deleted:true});}},
    {method:'PATCH',pattern:'/api/bot-rooms/:id',handler:async ctx=>{const input=await body(ctx);const room=rooms.patch(principal(ctx),ctx.requireParam('id'),input);json(ctx.response,200,{room});wake();}},
    {method:'POST',pattern:'/api/bot-rooms/:id/members',handler:async ctx=>{const input=await body(ctx);const owner=principal(ctx);const id=ctx.requireParam('id');if(typeof input.groupId==='string'&&input.groupId){json(ctx.response,200,rooms.addGroup(owner,id,input.groupId));return;}const room=rooms.addMember(owner,id,typeof input.botId==='string'?input.botId:'');json(ctx.response,200,{room});}},
    {method:'DELETE',pattern:'/api/bot-rooms/:id/members/:botId',handler:ctx=>{json(ctx.response,200,{room:rooms.removeMember(principal(ctx),ctx.requireParam('id'),ctx.requireParam('botId'))});}},
    {method:'GET',pattern:'/api/bot-rooms/:id/messages',handler:ctx=>{const limit=ctx.url.searchParams.get('limit');const beforeSeq=ctx.url.searchParams.get('beforeSeq');json(ctx.response,200,rooms.messages(principal(ctx),ctx.requireParam('id'),{...(limit?{limit:Number(limit)}:{}),...(beforeSeq?{beforeSeq:Number(beforeSeq)}:{})}));}},
    {method:'POST',pattern:'/api/bot-rooms/:id/messages',handler:async ctx=>{const input=await body(ctx);try{const owner=principal(ctx),roomId=ctx.requireParam('id'),text=typeof input.text==='string'?input.text:'';
 const requestKey=typeof input.idempotencyKey==='string'?input.idempotencyKey:randomUUID();
 const messageInput={text,mentions:input.mentions as string[]|undefined,attachmentIds:input.attachmentIds as string[]|undefined,contextSources:input.contextSources,idempotencyKey:requestKey,...(input.replyTo!==undefined?{replyTo:input.replyTo}:{})};
 if(text.trim().startsWith('/factory ')){
   // Room validation, durable human input and task acceptance commit together.
   // A rejected command cannot leave runnable work behind.
   runtime.store.db.exec('BEGIN IMMEDIATE');
   let result: ReturnType<typeof rooms.sendHandled>;
   let task: ReturnType<typeof runtime.factory.fromRoom>;
   try{
     result=rooms.sendHandled(owner,roomId,messageInput);
     task=runtime.factory.fromRoom(owner,roomId,text,result.message.id);
     runtime.store.db.exec('COMMIT');
   }catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
   if(task){runtime.factory.acknowledge(task,roomId+':'+result.message.id);void runtime.factory.tick().catch(()=>{});}
   json(ctx.response,202,{...result,task});return;
 }
 const result=rooms.sendHumanWork(owner,roomId,messageInput);
 json(ctx.response,202,result);wake();}catch(error){if(error instanceof BotQueueCapacityError){json(ctx.response,429,{error:error.message,error_code:error.code,accepted:false,retryable:true,usage:error.usage,limits:error.limits});return;}throw error;}}},
    {method:'GET',pattern:'/api/bot-rooms/:id/turns',handler:ctx=>{json(ctx.response,200,{turns:rooms.turns(principal(ctx),ctx.requireParam('id'))});}},
    {method:'POST',pattern:'/api/bot-rooms/:id/stop',handler:ctx=>{json(ctx.response,200,{room:rooms.stop(principal(ctx),ctx.requireParam('id'))});}},
    {method:'POST',pattern:'/api/bot-rooms/:id/resume',handler:ctx=>{json(ctx.response,200,{room:rooms.resume(principal(ctx),ctx.requireParam('id'))});wake();}}
  ];
}
