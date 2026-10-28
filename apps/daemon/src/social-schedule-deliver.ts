import {
  appendOutboundDraft,
  loadGatewayFileConfig,
  parseGatewayEnv,
  releaseOutboundDraft,
  type ChannelSpec
} from '@ppeng/agent-capability-gateway';
import { join } from 'node:path';
import type { SocialPostDeliverFn } from '@ppeng/agent-core';

/**
 * Social-post delivery: Draft → Confirm → Send.
 * Human schedule approval is the Confirm authority; we still materialize a draft
 * and release it explicitly — never call transport as a silent send.
 */
export async function makeSocialPostDeliver(repoRoot: string): Promise<SocialPostDeliverFn> {
  const { configPath } = parseGatewayEnv(repoRoot);
  const cfg = configPath ? await loadGatewayFileConfig(configPath) : undefined;
  const byId = new Map<string, ChannelSpec>();
  for (const c of cfg?.channels ?? []) {
    if (c?.id) byId.set(c.id, c);
  }
  const gatewayDir = join(repoRoot, '.agent-state', 'gateway');

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
    const channels = [...byId.values()];

    async function draftConfirmSend(text: string): Promise<{ ok: boolean; detail: string }> {
      const draft = await appendOutboundDraft(gatewayDir, {
        channelId: ch!.id,
        text,
        event: 'social_post.schedule'
      });
      try {
        const sent = await releaseOutboundDraft({
          gatewayDir,
          id: draft.id,
          decision: 'approve',
          channels
        });
        if (sent.status !== 'sent') {
          return { ok: false, detail: `draft ${draft.id} ended as ${sent.status}` };
        }
        return { ok: true, detail: `draft ${draft.id} sent` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    }

    const main = await draftConfirmSend(body);
    if (!main.ok) return main;
    const fc = firstComment?.trim();
    if (fc) {
      const c2 = await draftConfirmSend(fc);
      if (!c2.ok) {
        return { ok: false, detail: `main post ok but first_comment failed: ${c2.detail}` };
      }
    }
    return main;
  };
}
