/** Connector grants, Bot-scoped executable bindings, probes and durable attempts. */
import { type RawAgentRuntime, parseOpenApiSpec, NotFoundError, ValidationError } from '@ppeng/agent-core';
import type { RouteSpec, RouteContext } from '../routing.js';
import { json } from '../http-utils.js';
import { visibleBots } from '../access/visibility.js';
import { enforceRouteAccess } from '../access/enforce.js';
export function connectorRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const software=runtime.connectors.software;
  const scope=(ctx:RouteContext)=>{
    const botId=ctx.requireParam('id');const bot=runtime.getBot(botId);
    if(!visibleBots(runtime,[bot],ctx.auth).length)throw new NotFoundError('Bot',botId);
    return {botId,principal:software.principal(ctx.auth.user?{userId:ctx.auth.user.id,tenantId:ctx.auth.user.tenantId}:undefined)};
  };
  const credentialGate=async(ctx:RouteContext, principal:string, botId:string, connectorId:string, proposed?:Record<string,unknown>)=>{
    const current=software.list(principal,botId).find(c=>c.connectorId===connectorId);
    if(current?.secretEnv||current?.credRef||proposed?.secretEnv||proposed?.credRef)await enforceRouteAccess({kind:'admin'},ctx);
  };
  return [
    {method:'GET',pattern:'/api/connectors',handler:({response})=>json(response,200,{connectors:runtime.connectors.listPublic()})},
    {method:'POST',pattern:'/api/connectors/:id/grant',handler:async({requireParam,readBody,response})=>{const c=runtime.connectors.grantConnector(requireParam('id'),await readBody());json(response,200,{connector:runtime.connectors.toPublic(c)});}},
    {method:'POST',pattern:'/api/connectors/:id/revoke',handler:({requireParam,response})=>json(response,200,{connector:runtime.connectors.toPublic(runtime.connectors.revokeConnector(requireParam('id')))})},
    {method:'GET',pattern:'/api/bots/:id/connections',handler:ctx=>{const {principal,botId}=scope(ctx);json(ctx.response,200,{connections:software.list(principal,botId)});}},
    {method:'PUT',pattern:'/api/bots/:id/connections/:connectorId',handler:async ctx=>{
      const {principal,botId}=scope(ctx);const body=runtime.connectors.softwareBindingInput(ctx.requireParam('connectorId'),await ctx.readBody());await credentialGate(ctx,principal,botId,ctx.requireParam('connectorId'),body);
      if(body.createOnly===true&&software.list(principal,botId).some(connection=>connection.connectorId===ctx.requireParam('connectorId')))throw new ValidationError('Connection already exists');
      const connection=runtime.connectors.bindSoftware(principal,botId,ctx.requireParam('connectorId'),body);runtime.syncConnectorTools();json(ctx.response,200,{connection});
    }},
    {method:'DELETE',pattern:'/api/bots/:id/connections/:connectorId',handler:ctx=>{const {principal,botId}=scope(ctx);software.revoke(principal,botId,ctx.requireParam('connectorId'));runtime.syncConnectorTools();json(ctx.response,200,{ok:true});}},
    {method:'POST',pattern:'/api/bots/:id/connections/:connectorId/probe',handler:async ctx=>{const {principal,botId}=scope(ctx);await credentialGate(ctx,principal,botId,ctx.requireParam('connectorId'));json(ctx.response,200,{connection:await software.probe(principal,botId,ctx.requireParam('connectorId'))});}},
    {method:'GET',pattern:'/api/bots/:id/connections/:connectorId/invocations',handler:ctx=>{const {principal,botId}=scope(ctx);const limit=Number(ctx.url.searchParams.get('limit')??100);if(!Number.isInteger(limit)||limit<1||limit>200)throw new ValidationError('Invalid invocation page size');const before=ctx.url.searchParams.get('beforeSeq');const page=software.invocations(principal,botId,ctx.requireParam('connectorId'),{limit:limit+1,...(before?{beforeSeq:Number(before)}:{})});const hasMore=page.length>limit;const invocations=page.slice(0,limit);json(ctx.response,200,{invocations,hasMore,nextCursor:hasMore?invocations.at(-1)?.seq??null:null});}},
    {method:'POST',pattern:'/api/bots/:id/connections/:connectorId/invocations/:invocationId/resolve',handler:async ctx=>{const {principal,botId}=scope(ctx);const body=await ctx.readBody() as Record<string,unknown>;json(ctx.response,200,{invocation:software.resolveInvocation(principal,botId,ctx.requireParam('connectorId'),ctx.requireParam('invocationId'),body.state,body.note)});}},
    {method:'POST',pattern:'/api/bots/:id/connections/import',handler:async ctx=>{
      const {principal,botId}=scope(ctx);
      const body=await ctx.readBody() as Record<string,unknown>;
      const parsed=parseOpenApiSpec(body.spec);
      const connectorId=String(body.connectorId??parsed.capability.name);
      await credentialGate(ctx,principal,botId,connectorId,body);
      if(body.createOnly===true&&software.list(principal,botId).some(connection=>connection.connectorId===connectorId))throw new ValidationError('Connection already exists');
      const tools=body.readOnlyOnly===true ? parsed.tools.filter(tool=>['GET','HEAD','OPTIONS'].includes(tool.method)) : parsed.tools;
      const connection=software.bind(principal,botId,connectorId,{tools,secretEnv:body.secretEnv,credRef:body.credRef});
      runtime.syncConnectorTools();json(ctx.response,200,{connection,unsupported:parsed.unsupported});
    }}
  ];
}
