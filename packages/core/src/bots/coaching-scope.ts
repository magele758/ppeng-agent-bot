import { BotCoachingService } from './bot-coaching.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';
import type { BotRecord } from './types.js';
import { botDefinitionOwner, principalFromSession, resolveBotPrincipal, sameBotPrincipal } from './bot-identity.js';
function mayUseContract(store: SqliteStateStore, session: SessionRecord, bot: BotRecord): boolean {
  const owner=botDefinitionOwner(store,bot.id);
  if(owner)return sameBotPrincipal(owner,resolveBotPrincipal(store))||sameBotPrincipal(owner,principalFromSession(store,session));
  const canonical=store.getSession(bot.canonicalSessionId);
  if(!canonical)return false;
  const legacy=principalFromSession(store,canonical);
  return sameBotPrincipal(legacy,resolveBotPrincipal(store))||sameBotPrincipal(legacy,principalFromSession(store,session));
}
function sessionIdentity(session?: SessionRecord): string|undefined {
  if(!session)return undefined;
  const id=session.metadata?.botId;
  return typeof id==='string'&&session.agentId===id?id:undefined;
}
/** Metadata is caller-controlled on task creation; it cannot confer another Bot's contract. */
export function coachingBotId(store: SqliteStateStore, session?: SessionRecord): string|undefined {
  const id=sessionIdentity(session);
  if(!id)return undefined;
  if(!new BotCoachingService(store).read(id).revision)return undefined;
  const bot=store.getBot(id);
  if(!bot)return undefined;
  return mayUseContract(store,session!,bot)?id:undefined;
}
