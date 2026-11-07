import type { RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { createClientErrorWriter } from '../client-errors.js';
import { json } from '../http-utils.js';
export function clientErrorRoutes(runtime: RawAgentRuntime): RouteSpec[] {
 const write = createClientErrorWriter(runtime.stateDir);
 return [{method:'POST',pattern:'/api/client-errors',handler:async ctx=>{
  await write(await ctx.readBody());
  json(ctx.response,202,{ok:true});
 }}];
}
