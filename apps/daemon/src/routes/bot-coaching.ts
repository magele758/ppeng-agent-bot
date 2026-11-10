import { BotCoachingService, ConflictError, ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import { json } from '../http-utils.js';
import type { RouteSpec } from '../routing.js';
export function botCoachingRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const service = new BotCoachingService(runtime.store);
  return [
    {method:'GET',pattern:'/api/bots/:id/coaching',handler:ctx=>{
      const id=ctx.requireParam('id');runtime.getBot(id);
      json(ctx.response,200,{coaching:service.read(id)});
    }},
    {method:'PUT',pattern:'/api/bots/:id/coaching',handler:async ctx=>{
      const id=ctx.requireParam('id');runtime.getBot(id);
      const input=await ctx.readBody() as Record<string,unknown>;
      if(input.revision!==service.read(id).revision)throw new ConflictError('Coaching configuration changed; refresh before saving');
      try{json(ctx.response,200,{coaching:service.save(id,input.revision,input.profile,input.lessons)});}
      catch(error){throw new ValidationError(error instanceof Error?error.message:String(error));}
    }}
  ];
}
