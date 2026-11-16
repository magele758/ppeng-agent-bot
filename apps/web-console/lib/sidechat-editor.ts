import type { SidechatAnchor } from '@ppeng/api-types';

export type SidechatPanelRequest =
  | { kind: 'draft'; anchor: SidechatAnchor; messageId: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'list'; threadIds?: string[] };

export type SidechatEditorTarget = Exclude<SidechatPanelRequest, { kind: 'list' }>;

export function draftAddress(sessionId: string, target: SidechatEditorTarget): string {
  if (target.kind === 'thread') return JSON.stringify([sessionId, 'thread', target.threadId]);
  const a = target.anchor;
  return JSON.stringify([sessionId, 'draft', target.messageId, a.kind, a.start, a.end, a.quote]);
}

type Submission = { requestId: string; question: string };
export function sidechatRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Kept by the chat shell so closing the rail doesn't drop an unacknowledged send. */
export class SidechatDraftBook {
  private texts = new Map<string, string>();
  private requests = new Map<string, Submission>();
  private busy = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }
  text(key: string) {
    return this.texts.get(key) ?? '';
  }
  sending(key: string) {
    return this.busy.has(key);
  }
  edit(key: string, text: string) {
    if (text) this.texts.set(key, text);
    else this.texts.delete(key);
    this.changed();
  }
  begin(key: string): Submission | null {
    const question = this.text(key).trim();
    if (!question || this.busy.has(key)) return null;
    const prior = this.requests.get(key);
    const req = prior?.question === question ? prior : { question, requestId: sidechatRequestId() };
    this.busy.add(key);
    this.requests.set(key, req);
    this.changed();
    return req;
  }
  failed(key: string, req: Submission) {
    if (this.requests.get(key) !== req) return;
    this.busy.delete(key);
    this.changed();
  }
  private moveDraft(key: string, destination: string) {
    const remainder = this.text(key);
    if (!remainder || this.text(destination)) return;
    this.texts.set(destination, remainder);
    this.texts.delete(key);
  }
  sent(key: string, req: Submission, destination = key) {
    if (this.requests.get(key) !== req) return;
    this.busy.delete(key);
    this.requests.delete(key);
    if (this.text(key).trim() === req.question) this.texts.delete(key);
    else if (key !== destination) this.moveDraft(key, destination);
    this.changed();
  }
}
