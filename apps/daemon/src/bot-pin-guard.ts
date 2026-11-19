/**
 * Lab HTTP side of the Bot pin rule (core `permittedBotPinPatch`): changing a Bot's
 * model or thinking effort pin needs its owner or an administrator. Repeating the
 * saved values, or leaving them out, stays open to anyone who may open the Bot.
 */

import {
  botChatCommandPinPatch,
  canonicalBotIdFromSession,
  permittedBotPinPatch,
  type BotPinCaller,
  type RawAgentRuntime,
  type RequestAuth,
  type UpdateBotInput
} from '@ppeng/agent-core';

/** With Lab login off the caller is the operator. */
function pinCaller(auth: RequestAuth): BotPinCaller {
  return { userId: auth.user?.id, admin: !auth.isolate || auth.admin === true };
}

/** Pin edits in `patch` this caller may apply; 403 when one would change a pin it may not. */
export function guardBotPins<T extends UpdateBotInput>(
  runtime: RawAgentRuntime,
  auth: RequestAuth,
  botId: string,
  patch: T
): T {
  return permittedBotPinPatch(runtime.store, botId, patch, pinCaller(auth));
}

/** Create-time metadata naming a Bot claims to be that Bot's: it may only repeat the saved pins. */
export function guardBotTaggedMetadata(
  runtime: RawAgentRuntime,
  auth: RequestAuth,
  metadata: Record<string, unknown>
): void {
  const botId = typeof metadata.botId === 'string' ? metadata.botId.trim() : '';
  if (!botId) return;
  guardBotPins(runtime, auth, botId, {
    modelOverride: metadata.modelOverride,
    thinkingEffort: metadata.thinkingEffort
  });
}

/** `/model` in a Bot chat rewrites that Bot's model pin for every chat. */
export function guardBotChatCommand(
  runtime: RawAgentRuntime,
  auth: RequestAuth,
  sessionId: string,
  text: string
): void {
  const botId = canonicalBotIdFromSession(runtime.getSession(sessionId));
  if (!botId) return;
  guardBotPins(runtime, auth, botId, botChatCommandPinPatch(runtime.store, text));
}
