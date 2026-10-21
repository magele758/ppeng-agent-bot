/** Retain acceptance identity when a response is lost after the server commits. */
export function createBotDispatchIdentity(newId: () => string = () => crypto.randomUUID()) {
  let pending: { input: string; key: string } | undefined;
  return {
    forInput(botId: string, message: string): string {
      const input = JSON.stringify([botId, message]);
      if (pending?.input !== input) pending = { input, key: newId() };
      return pending.key;
    },
    accepted(): void { pending = undefined; },
  };
}
