/** Markers from `fenceExternalContent`. Outbound IM must not carry them. */
const FENCE_START = /«external\b[^»]*»/g;
const FENCE_END = '«end external»';

export interface ChannelDeliveryResult {
  ok: boolean;
  status: number;
  text: string;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Drop fence markers. The text inside the fence stays; a human already approved the draft. */
export function stripOutboundFenceMarkers(text: string): string {
  return text.replace(FENCE_START, '').replaceAll(FENCE_END, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function channelMessageText(body: Record<string, unknown>): string {
  if (typeof body.text === 'string') return body.text;
  if (typeof body.summary === 'string') return body.summary;
  return JSON.stringify(body);
}

export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < 4) continue;
    out = out.split(value).join('[REDACTED]');
  }
  return out;
}
