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
  const canonicalByBot = new Map<string, NonNullable<ReturnType<typeof runtime.store.getSession>>>();
  const ids = runtime.store.db.prepare(`
    SELECT id FROM sessions WHERE json_extract(metadata_json,'$.canonicalBotChat')=1
      AND json_extract(metadata_json,'$.botId') IN (SELECT value FROM json_each(?))
    ORDER BY updated_at DESC
  `).all(JSON.stringify(room.botIds)) as {id:string}[];
  for (const {id} of ids) {
    const session = runtime.store.getSession(id);
    const botId = session?.metadata.botId;
    if (session && typeof botId === 'string' && !canonicalByBot.has(botId) && sameBotPrincipal(principalFromSession(runtime.store,session),principal)) {
      canonicalByBot.set(botId, session);
    }
  }
  return {
    defaultModel,
    members:room.botIds.map(botId=>{
      const bot=runtime.store.getBot(botId);
      const canonical=bot&&(canonicalByBot.get(botId)??runtime.store.getSession(bot.canonicalSessionId));
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
