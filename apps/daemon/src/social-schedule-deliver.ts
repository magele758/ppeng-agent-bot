import {
  deliverToChannel,
  loadGatewayFileConfig,
  parseGatewayEnv,
  type ChannelSpec
} from '@ppeng/agent-capability-gateway';
import type { SocialPostDeliverFn } from '@ppeng/agent-core';

export async function makeSocialPostDeliver(repoRoot: string): Promise<SocialPostDeliverFn> {
  const { configPath } = parseGatewayEnv(repoRoot);
  const cfg = configPath ? await loadGatewayFileConfig(configPath) : undefined;
  const byId = new Map<string, ChannelSpec>();
  for (const c of cfg?.channels ?? []) {
    if (c?.id) byId.set(c.id, c);
  }

  return async (channel: string, body: string, firstComment?: string) => {
    if (!channel.startsWith('webhook:')) {
      return {
        ok: false,
        detail: `no outbound adapter for "${channel}"; use webhook:<gateway channel id> in schedule targets`
      };
    }
    const id = channel.slice('webhook:'.length).trim();
    const ch = byId.get(id);
    if (!ch) {
      return { ok: false, detail: `gateway channel id not found: ${id}` };
    }
    const main = await deliverToChannel(ch, { text: body, summary: body }, { approval: 'approved' });
    if (!main.ok) {
      return { ok: false, detail: main.text };
    }
    const fc = firstComment?.trim();
    if (fc) {
      const c2 = await deliverToChannel(ch, { text: fc, summary: fc }, { approval: 'approved' });
      if (!c2.ok) {
        return { ok: false, detail: `main post ok but first_comment failed: ${c2.text}` };
      }
    }
    return { ok: true, detail: main.text };
  };
}
