import { join } from 'node:path';
import {
  createAgentInboxPort,
  resolveBotPrincipal,
  type RawAgentRuntime
} from '@ppeng/agent-core';
import {
  createUserDeliveryPort,
  loadGatewayFileConfig,
  parseGatewayEnv,
  readQuietHours,
  type UserDeliveryPort
} from '@ppeng/agent-capability-gateway';

/** The daemon's UserDeliveryPort: gateway channels from file config, quiet hours from the Lab setting. */
export async function createDaemonDeliveryPort(
  runtime: RawAgentRuntime,
  repoRoot: string,
  owner?: { userId?: string; tenantId?: string }
): Promise<UserDeliveryPort> {
  const { configPath } = parseGatewayEnv(repoRoot);
  const cfg = configPath ? await loadGatewayFileConfig(configPath) : undefined;
  const principal = resolveBotPrincipal(runtime.store, owner);
  const inboxPort = createAgentInboxPort(runtime.store);
  return createUserDeliveryPort({
    gatewayDir: join(runtime.stateDir, 'gateway'),
    channels: cfg?.channels ?? [],
    quietHours: () => readQuietHours(runtime.store),
    // Empty ChannelSpec.from → claimed localPart@productDomain; no claim → undefined (do not invent).
    claimedFrom: () => inboxPort.list(principal)?.address
  });
}

/** Release drafts deferred by quiet hours once the window is over. Overlapping ticks are skipped. */
export function startDeliveryFlushTicker(
  runtime: RawAgentRuntime,
  repoRoot: string,
  onError: (error: unknown) => void,
  intervalMs = 60_000
): ReturnType<typeof setInterval> {
  let inFlight = false;
  return setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    createDaemonDeliveryPort(runtime, repoRoot)
      .then((port) => port.flushDeferred())
      .catch(onError)
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
}
