import { domainCatalog, readRuntimeCapabilities, writeRuntimeCapabilities, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
export function runtimeCapabilitiesRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const payload = () => ({settings:readRuntimeCapabilities(runtime.store), availableDomains:domainCatalog(runtime.store).map(({id,label})=>({id,label})), effective:{applyAt:'next-step',scope:'global', availableDomains:domainCatalog(runtime.store).map(({id,label})=>({id,label}))}});
  return [
    {method:'GET',pattern:'/api/runtime-capabilities',handler:({response})=>json(response,200,payload())},
    {method:'PATCH',pattern:'/api/runtime-capabilities',handler:async({readBody,response})=>{
      writeRuntimeCapabilities(runtime.store,await readBody() as Record<string,unknown>);
      json(response,200,payload());
    }}
  ];
}
