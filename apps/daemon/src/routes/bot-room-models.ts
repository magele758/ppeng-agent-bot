import {
  publicCatalogPayload, readModelCatalog, resolveSessionPreferredRef, resolveModelRoute,
  principalFromSession, sameBotPrincipal,
  type BotPrincipal, type BotRoom, type RawAgentRuntime, type ModelRef
} from '@ppeng/agent-core';

/** Names and routing source only. Never returns credentials or private session metadata. */
export function roomModelConfiguration(runtime: RawAgentRuntime, room: BotRoom, principal: BotPrincipal) {
  const payload=publicCatalogPayload(runtime.store,process.env);
  const catalog=readModelCatalog(runtime.store);
  const label=(ref:ModelRef|undefined) => {
    if(!ref)return null;
    const option=payload.options.find(item=>item.providerId===ref.providerId&&item.modelId===ref.modelId&&item.kind!=='heuristic');
    if(!option)return null;
    const provider=payload.catalog.providers.find(item=>item.id===ref.providerId);
    if(!provider?.hasApiKey||!provider.baseUrl.trim())return null;
    return {providerId:ref.providerId,modelId:ref.modelId,providerName:option.providerName};
  };
  const defaultModel=label(resolveModelRoute({store:runtime.store,env:process.env,fallbackAdapter:runtime.modelAdapter}).primaryRef);
  return {
    defaultModel,
    members:room.botIds.map(botId=>{
      const bot=runtime.store.getBot(botId);
      const canonical=bot&&(runtime.store.listSessions().find(session=>session.metadata?.canonicalBotChat===true&&session.metadata?.botId===botId&&sameBotPrincipal(principalFromSession(runtime.store,session),principal))??runtime.store.getSession(bot.canonicalSessionId));
      // Match Room execution: inherit the Bot pin, never its private composer selection.
      const session=canonical?{...canonical,metadata:{modelOverride:canonical.metadata?.modelOverride}}:undefined;
      const preferred=resolveSessionPreferredRef(catalog,session,process.env);
      const route=resolveModelRoute({store:runtime.store,session,env:process.env,fallbackAdapter:runtime.modelAdapter});
      const model=label(route.primaryRef);
      const pinned=preferred.source==='override'&&model&&preferred.ref?.providerId===model.providerId&&preferred.ref?.modelId===model.modelId;
      return {botId,model,source:!model?'unconfigured' as const:pinned?'bot' as const:'global' as const};
    })
  };
}
