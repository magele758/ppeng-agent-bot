import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface OutboundDraft {
  id: string;
  channelId: string;
  text: string;
  event?: string;
  createdAt: string;
  status: 'pending_approval';
}

function draftsPath(gatewayDir: string): string {
  return join(gatewayDir, 'outbound-drafts.json');
}

export async function readOutboundDrafts(gatewayDir: string): Promise<OutboundDraft[]> {
  try {
    const raw = await readFile(draftsPath(gatewayDir), 'utf8');
    const parsed = JSON.parse(raw) as { items?: OutboundDraft[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/** Hold an IM / digest outbound until a human approves a real send. Does not POST. */
export async function appendOutboundDraft(
  gatewayDir: string,
  input: { channelId: string; text: string; event?: string }
): Promise<OutboundDraft> {
  await mkdir(gatewayDir, { recursive: true });
  const items = await readOutboundDrafts(gatewayDir);
  const draft: OutboundDraft = {
    id: `draft_${randomUUID().replace(/-/g, '')}`,
    channelId: input.channelId,
    text: input.text,
    event: input.event,
    createdAt: new Date().toISOString(),
    status: 'pending_approval'
  };
  items.push(draft);
  await writeFile(draftsPath(gatewayDir), JSON.stringify({ items }, null, 2));
  return draft;
}
