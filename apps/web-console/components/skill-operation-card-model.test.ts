import assert from 'node:assert/strict';
import test from 'node:test';
import {
  skillOperationCardIsBar,
  skillOperationCardStatus,
  visibleSkillOperationCards,
  type SkillOperationCardRow,
} from './skill-operation-card-model.ts';

function row(partial: Partial<SkillOperationCardRow> & Pick<SkillOperationCardRow, 'id' | 'name' | 'status'>): SkillOperationCardRow {
  return { input: { action: 'create' }, ...partial };
}

test('confirming a suggestion becomes one in-progress bar [AC:skill-operation-confirm-bar#AC-1]', () => {
  const pending = row({ id: 'slow', name: 'test2-release', status: 'pending' });
  const confirming = new Set(['slow']);
  assert.deepEqual(visibleSkillOperationCards([pending], new Set(), confirming).map((item) => item.id), ['slow']);
  assert.equal(skillOperationCardIsBar(pending, confirming), true);
  assert.equal(skillOperationCardStatus(pending, confirming), 'processing');
});

test('closing a bar drops that prompt and does not invent success [AC:skill-operation-confirm-bar#AC-2] [AC:skill-operation-confirm-bar#AC-5]', () => {
  const failed = row({ id: 'bad', name: 'test2-release', status: 'failed' });
  const processing = row({ id: 'run', name: 'other', status: 'processing' });
  assert.equal(skillOperationCardIsBar(failed, new Set()), true);
  assert.equal(skillOperationCardStatus(failed, new Set()), 'failed');
  assert.deepEqual(
    visibleSkillOperationCards([failed, processing], new Set(['bad']), new Set()).map((item) => item.id),
    ['run'],
  );
  assert.equal(skillOperationCardStatus(processing, new Set()), 'processing');
});

test('an unconfirmed suggestion stays a prompt until reject [AC:skill-operation-confirm-bar#AC-3]', () => {
  const pending = row({ id: 'ask', name: 'other-skill', status: 'pending' });
  assert.equal(skillOperationCardIsBar(pending, new Set()), false);
  assert.equal(skillOperationCardStatus(pending, new Set()), 'pending');
  const rejected = { ...pending, status: 'rejected' as const };
  assert.equal(skillOperationCardIsBar(rejected, new Set()), true);
  assert.equal(skillOperationCardStatus(rejected, new Set()), 'rejected');
});

test('a finished skill keeps one bar and a different suggestion stays pending [AC:skill-operation-confirm-bar#AC-4]', () => {
  const saved = row({ id: 'done', name: 'test2-release', status: 'saved' });
  const failed = row({ id: 'dup', name: 'test2-release', status: 'failed' });
  const pending = row({ id: 'again', name: 'test2-release', status: 'pending' });
  const other = row({ id: 'other', name: 'other-skill', status: 'pending' });
  assert.deepEqual(
    visibleSkillOperationCards([saved, failed, pending, other], new Set(), new Set()).map((item) => item.id),
    ['done', 'other'],
  );
  assert.deepEqual(
    visibleSkillOperationCards([saved, failed], new Set(['done']), new Set()).map((item) => item.id),
    [],
  );
  const again = row({ id: 'again', name: 'test2-release', status: 'pending' });
  assert.deepEqual(
    visibleSkillOperationCards([saved, again], new Set(), new Set(['again'])).map((item) => item.id),
    ['again'],
  );
  assert.deepEqual(
    visibleSkillOperationCards([saved, again], new Set(['again']), new Set(['again'])).map((item) => item.id),
    ['done'],
  );
});
