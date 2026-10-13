import { createId } from '../id.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';

export interface BotPrincipal { userId: string; tenantId?: string }
/** An installation is a durable principal, never an anonymous user fallback. */
export function resolveBotPrincipal(store: SqliteStateStore, owner?: { userId?: string; tenantId?: string }): BotPrincipal {
  if (owner?.userId?.trim()) return { userId: owner.userId.trim(), ...(owner.tenantId?.trim() ? { tenantId: owner.tenantId.trim() } : {}) };
  let id = store.getDaemonControl<string>('bot.installationPrincipal');
  if (!id) { id = `installation:${createId('principal')}`; store.setDaemonControl('bot.installationPrincipal', id); }
  return { userId: id };
}
export function principalFromSession(store: SqliteStateStore, session: Pick<SessionRecord,'metadata'>): BotPrincipal {
  return resolveBotPrincipal(store, { userId: typeof session.metadata?.userId === 'string' ? session.metadata.userId : undefined, tenantId: typeof session.metadata?.tenantId === 'string' ? session.metadata.tenantId : undefined });
}
export function botPrincipalKey(principal: BotPrincipal): string { return JSON.stringify([principal.tenantId ?? '',principal.userId]); }
export function sameBotPrincipal(left: BotPrincipal, right: BotPrincipal): boolean { return botPrincipalKey(left) === botPrincipalKey(right); }
export function setBotDefinitionOwner(store:SqliteStateStore,botId:string,principal:BotPrincipal):void {
 store.db.exec('CREATE TABLE IF NOT EXISTS bot_definition_owners(bot_id TEXT PRIMARY KEY,principal TEXT NOT NULL)');
 store.db.prepare('INSERT INTO bot_definition_owners(bot_id,principal) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET principal=excluded.principal').run(botId,botPrincipalKey(principal));
}
export function botDefinitionOwner(store:SqliteStateStore,botId:string):BotPrincipal|undefined {
 store.db.exec('CREATE TABLE IF NOT EXISTS bot_definition_owners(bot_id TEXT PRIMARY KEY,principal TEXT NOT NULL)');
 const row=store.db.prepare('SELECT principal FROM bot_definition_owners WHERE bot_id=?').get(botId) as {principal:string}|undefined;
 if(!row)return undefined;const [tenantId,userId]=JSON.parse(row.principal) as [string,string];return {userId,...(tenantId?{tenantId}:{})};
}
