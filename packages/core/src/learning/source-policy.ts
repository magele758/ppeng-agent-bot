import { ValidationError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import { principalFromSession, sameBotPrincipal } from '../bots/bot-identity.js';
import { stableJson } from '../cron/notification-decision.js';

export interface SourceCallGrant { tool: string; args: Record<string, unknown> }
export interface SourcePolicy { allowedEffects: string[]; allowedCalls?: SourceCallGrant[] }
const toolName = /^[-\w.]{1,100}$/;

export function normalizeSourcePolicy(raw: Record<string, unknown>, previous: SourcePolicy): SourcePolicy {
  const effects = raw.allowedEffects;
  if (!Array.isArray(effects) || effects.length > 100 || effects.some(x => typeof x !== 'string' || !toolName.test(x))) throw new ValidationError('Invalid allowedEffects');
  const calls = raw.allowedCalls ?? previous.allowedCalls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 50 || JSON.stringify(calls).length > 32768
    || calls.some(x => !x || typeof x !== 'object' || typeof x.tool !== 'string' || !toolName.test(x.tool)
      || !x.args || typeof x.args !== 'object' || Array.isArray(x.args)))) throw new ValidationError('Invalid allowedCalls');
  return { allowedEffects: [...new Set(effects)] as string[], ...(calls === undefined ? {} : { allowedCalls: calls as SourceCallGrant[] }) };
}

export function sourcePolicyAllows(policy: SourcePolicy, name: string, args: unknown): boolean {
  return policy.allowedEffects.includes(name)
    || args !== undefined && (policy.allowedCalls ?? []).some(call => call.tool === name && stableJson(call.args) === stableJson(args));
}

/** Follow real ownership/ancestry; caller-supplied child identity cannot select a grant. */
export function effectiveSourcePolicy(store: SqliteStateStore, sid: string): SourcePolicy {
  const visited = new Set<string>();
  let session = store.getSession(sid);
  while (session && !visited.has(session.id) && visited.size < 32) {
    visited.add(session.id);
    const saved = store.getDaemonControl<SourcePolicy>('source-policy:' + session.id);
    if (saved) return saved;
    if (session.mode === 'subagent' || session.mode === 'teammate' || session.metadata?.routineParentSessionId) {
      const parentId = session.parentSessionId ?? session.metadata?.routineParentSessionId;
      const parent = typeof parentId === 'string' ? store.getSession(parentId) : undefined;
      if (!parent || !sameBotPrincipal(principalFromSession(store, session), principalFromSession(store, parent))) break;
      session = parent;
      continue;
    }
    const id = session.metadata?.botId;
    const bot = typeof id === 'string' ? store.getBot(id) : undefined;
    if (!bot || session.agentId !== bot.agentId && session.agentId !== bot.id) break;
    if (session.metadata?.canonicalBotChat === true) break;
    const canonical = store.listSessions().find(candidate => candidate.metadata?.canonicalBotChat === true
      && candidate.metadata.botId === bot.id && sameBotPrincipal(principalFromSession(store, candidate), principalFromSession(store, session!)));
    if (!canonical || canonical.id === session.id) break;
    session = canonical;
  }
  return { allowedEffects: [] };
}
