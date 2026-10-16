import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamFileMailbox } from '../dist/teams/mailbox.js';

test('mailbox 文件追加 jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-mbox-'));
  try {
    const box = new TeamFileMailbox(join(dir, 'plan-a'));
    const msg = box.send({
      planId: 'plan-a',
      type: 'task',
      from: 'team-coordinator',
      to: 'worker-1',
      content: 'hello-dag',
      taskId: 'analyze'
    });
    const file = join(dir, 'plan-a', 'runtime', 'mailbox', 'worker-1.jsonl');
    assert.equal(existsSync(file), true);
    const line = readFileSync(file, 'utf8').trim();
    assert.match(line, /hello-dag/);
    assert.equal(JSON.parse(line).id, msg.id);
    assert.equal(box.peekInbox('worker-1').length, 1);
    assert.equal(box.readInbox('worker-1')[0]?.content, 'hello-dag');
    assert.equal(box.peekInbox('worker-1').length, 0);
    assert.equal(box.listRecent(10).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parallel mailbox sends keep every line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-mbox-race-'));
  try {
    const plan = join(dir, 'plan-a');
    const n = 24;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        Promise.resolve().then(() =>
          new TeamFileMailbox(plan).send({
            planId: 'plan-a',
            type: 'task',
            from: 'team-coordinator',
            to: 'worker-1',
            content: `race-${i}`,
            taskId: `t${i}`
          })
        )
      )
    );
    const box = new TeamFileMailbox(plan);
    const inbox = box.peekInbox('worker-1');
    assert.equal(inbox.length, n);
    assert.equal(new Set(inbox.map((item) => item.content)).size, n);
    assert.equal(box.listRecent(n).length, n);
    assert.equal(box.readInbox('worker-1').length, n);
    assert.equal(box.peekInbox('worker-1').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
