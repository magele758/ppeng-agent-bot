import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { expect, it } from 'vitest';
import { StepInboxStore } from './step-inbox.js';

it('upgrades standalone legacy inbox tables and preserves context through edits [AC:composer-drag-context#AC-3]', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE session_inbox (id TEXT PRIMARY KEY, session_id TEXT, target TEXT, role TEXT, text TEXT, key TEXT, created_at TEXT, claimed_at TEXT)');
  const store = new StepInboxStore(db);
  const contextParts = [{ type: 'text' as const, text: 'fenced file body' }];
  const item = store.enqueue('s', 'read it', { contextParts });
  store.updateUnclaimed('s', item.id, 'read it carefully');
  expect(store.claim('s', 'next-step')[0]).toMatchObject({ text: 'read it carefully', contextParts });
  db.close();
});
