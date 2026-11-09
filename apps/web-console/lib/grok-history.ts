const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const replica = /^sand\.client\.slice\.account\..+\.transcript\.replicas\.([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;

export function grokReplicaId(filename: string): string | null {
  if (!/^[a-z2-7]+\.blob$/i.test(filename)) return null;
  let key = '';
  let bits = 0;
  let buffer = 0;
  for (const char of filename.slice(0, -5).toLowerCase()) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return replica.exec(key)?.[1] ?? null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

export interface GrokMessage {
  role: 'user' | 'assistant';
  text: string;
  attachment?: boolean;
  timestamp?: number;
}

function sentMessage(raw: unknown): GrokMessage | null {
  const message = record(raw);
  if (message.type === 'text' && typeof message.content === 'string') return {role: 'assistant', text: message.content};
  if (message.type !== 'attachment') return null;
  return {role: 'assistant', attachment: true, text: String(message.file_name ?? '')};
}

function isChatRole(role: unknown): role is GrokMessage['role'] {
  return role === 'user' || role === 'assistant';
}

function chatMessage(raw: unknown): GrokMessage | null {
  const entry = record(raw);
  if (entry.kind === 'send-message') return sentMessage(entry.message);
  if (entry.kind !== 'message' || typeof entry.content !== 'string') return null;
  if (!isChatRole(entry.role)) return null;
  return {role: entry.role, text: entry.content};
}

function transcriptEntries(raw: unknown): unknown[] {
  const envelope = record(raw);
  const entries = record(envelope.value).entries;
  if (envelope.schemaVersion !== 1 || !Array.isArray(entries)) throw new Error('invalid_transcript');
  return entries;
}

export function readGrokHistory(raw: unknown): GrokMessage[] {
  const entries = transcriptEntries(raw);
  const messages: GrokMessage[] = [];
  for (const entry of entries) {
    const message = chatMessage(entry);
    if (!message) continue;
    const timestamp = record(entry).timestampMs;
    if (typeof timestamp === 'number') message.timestamp = timestamp;
    messages.push(message);
  }
  return messages;
}

export interface GrokSession {
  file: File;
  id: string;
  title: string;
}

export async function listGrokSessions(files: File[]) {
  const sessions: GrokSession[] = [];
  let failed = 0;
  for (const file of files) {
    const id = grokReplicaId(file.name);
    if (!id) continue;
    try {
      const messages = readGrokHistory(JSON.parse(await file.text()));
      const title = messages.find(message => message.role === 'user')?.text.trim().slice(0, 80) || id;
      sessions.push({file, id, title});
    } catch {
      failed++;
    }
  }
  sessions.sort((a, b) => b.file.lastModified - a.file.lastModified);
  return {sessions, failed};
}
