export interface MemoryToolServices {
  currentUserText?(sessionId: string): Promise<string>;
  upsertSessionMemory(
    sessionId: string,
    scope: 'scratch' | 'long',
    key: string,
    value: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;
  listSessionMemory(sessionId: string, scope?: 'scratch' | 'long'): Promise<unknown[]>;
  deleteSessionMemory(sessionId: string, scope: 'scratch' | 'long', key: string): Promise<boolean>;
}
