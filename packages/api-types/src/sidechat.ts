/** A range uses UTF-16 offsets in the rendered reply text and neighboring text for relocation. */
export interface SidechatAnchor {
  kind: 'range' | 'message';
  quote: string;
  start?: number;
  end?: number;
  prefix?: string;
  suffix?: string;
}

export type SidechatStatus = 'generating' | 'complete' | 'failed' | 'stopped';
export type SidechatGrasp = 'thinking' | 'mastered';

export interface SidechatThread {
  id: string;
  sessionId: string;
  messageId: string;
  agentId: string;
  botId?: string;
  ordinal: number;
  title: string;
  anchor: SidechatAnchor;
  status: SidechatStatus;
  grasp: SidechatGrasp;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface SidechatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  requestId: string;
  status: SidechatStatus;
  createdAt: string;
  error?: string;
  generationId?: string;
}

export interface SidechatDetail extends SidechatThread {
  messages: SidechatMessage[];
}

export interface SidechatMatch {
  field: 'quote' | 'title' | 'user' | 'assistant' | 'note';
  snippet: string;
  messageId?: string;
}

export interface SidechatSearchHit {
  thread: SidechatThread;
  sessionTitle: string;
  matches: SidechatMatch[];
}
