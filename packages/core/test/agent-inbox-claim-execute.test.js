import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createAgentInboxPort } from '../dist/agent-inbox/index.js';
import { createAgentInboxTools } from '../dist/agent-inbox/tools.js';

function fixture(userId) {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-inbox-claim-')), 'state.db');
  const store = new SqliteStateStore(path);
  const port = createAgentInboxPort(store);
  const claim = createAgentInboxTools(store, port).find((tool) => tool.name === 'claim_email_inbox');
  return {
    claim,
    context: { session: { id: 's1', metadata: { userId } } },
    cleanup() {
      rmSync(path, { force: true });
    }
  };
}

test('claim_email_inbox returns the inbox, the existing claim, or an invalid local part [AC:ci-zero-coverage-complexity#AC-2]', async () => {
  const owner = fixture('owner');
  const other = fixture('other');
  try {
    assert.ok(owner.claim);
    assert.ok(other.claim);

    const claimed = await owner.claim.execute(owner.context, { local_part: 'agent1' });
    assert.equal(claimed.ok, true);
    const claimedBody = JSON.parse(claimed.content);
    assert.equal(claimedBody.inbox.localPart, 'agent1');
    assert.equal(claimedBody.inbox.address, 'agent1@agent.local');

    const again = await owner.claim.execute(owner.context, { local_part: 'agent2' });
    assert.equal(again.ok, false);
    const againBody = JSON.parse(again.content);
    assert.equal(againBody.error, 'already_claimed');
    assert.equal(againBody.message, 'Already claimed agent1@agent.local');
    assert.equal(againBody.existingInbox.address, 'agent1@agent.local');

    const invalid = await other.claim.execute(other.context, { local_part: 'UPPERCASE' });
    assert.equal(invalid.ok, false);
    const invalidBody = JSON.parse(invalid.content);
    assert.equal(invalidBody.error, 'invalid_local_part');
    assert.equal(invalidBody.message, 'Invalid localPart format');
  } finally {
    owner.cleanup();
    other.cleanup();
  }
});
