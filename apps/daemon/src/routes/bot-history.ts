import type { RawAgentRuntime } from '@ppeng/agent-core';
import { readBotContextSettings, writeBotContextSettings } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import { wrapSessionIdRoutes } from '../session-guard.js';
export function botHistoryRoutes(runtime: RawAgentRuntime): RouteSpec[] {
 return wrapSessionIdRoutes(runtime,[
 {method:'GET',pattern:'/api/sessions/:id/history',handler:({requireParam,url,response})=>{
  const value=(key:string)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):undefined;
  try { json(response,200,runtime.store.listHistory(requireParam('id'),{limit:value('limit'),beforeSeq:value('beforeSeq'),query:url.searchParams.get('query')??undefined,from:url.searchParams.get('from')??undefined,to:url.searchParams.get('to')??undefined})); }
  catch(error){json(response,400,{error:error instanceof Error?error.message:String(error)});}
 }},
 {method:'GET',pattern:'/api/sessions/:id/history/:seq',handler:({requireParam,url,response})=>{
  try { const data=runtime.store.readHistory(requireParam('id'),Number(requireParam('seq')),Number(url.searchParams.get('before')??5),Number(url.searchParams.get('after')??5));json(response,data?200:404,data??{error:'History message not found'});}
  catch(error){json(response,400,{error:error instanceof Error?error.message:String(error)});}
 }},
 {method:'GET',pattern:'/api/bot-context-settings',handler:({response})=>json(response,200,{settings:readBotContextSettings(runtime.store)})},
 {method:'PATCH',pattern:'/api/bot-context-settings',handler:async({readBody,response,auth})=>{
  if(auth.isolate&&!auth.admin){json(response,403,{error:'Administrator access required'});return;}
  try{json(response,200,{settings:writeBotContextSettings(runtime.store,await readBody())});}catch(error){json(response,400,{error:error instanceof Error?error.message:String(error)});}
 }}
 ]);
}
