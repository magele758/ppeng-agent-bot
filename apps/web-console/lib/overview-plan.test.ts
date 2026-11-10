import test from 'node:test';
import assert from 'node:assert/strict';
import { settleList, type LabListKey } from './list-load.ts';
import { AGENTS_REFRESH_MS, META_REFRESH_MS, createOverviewCadence, overviewListsFor, refreshForPage } from './overview-plan.ts';

const ALL: LabListKey[] = ['tasks', 'socialSchedules', 'approvals', 'outboundDrafts', 'jobs', 'workspaces', 'mail', 'swarmRuns', 'orchestrationRuns'];
const chat = { section: 'bot', sub: null };
const queue = { section: 'tasks', sub: 'queue' };

function harness() {
  let now = 1_000;
  const fresh: string[] = [];
  const shared: string[] = [];
  const cadence = createOverviewCadence(
    { fresh: async (path) => { fresh.push(path); return { via: 'fresh' }; }, shared: async (path) => { shared.push(path); return { via: 'shared' }; } },
    () => now
  );
  /** Runs one refresh the way the console does and reports which lists were requested. */
  async function refresh(location: { section: string; sub: string | null }) {
    const plan = cadence.plan(location);
    const requested: LabListKey[] = [];
    const results = await Promise.all(ALL.map((key) => plan.list(key, async () => { requested.push(key); return [key]; })));
    await plan.agents();
    return { plan, requested, results };
  }
  return { cadence, fresh, shared, refresh, advance: (ms: number) => { now += ms; } };
}

test('on a chat page only pending approvals are read; lists shown elsewhere are left alone [AC:lab-startup-request-load#AC-7]', async () => {
  const h = harness();
  h.cadence.markTimer();
  const { requested, results } = await h.refresh(chat);
  assert.deepEqual(requested, ['approvals']);
  for (const section of ['bot', 'chat', 'knowledge', 'settings']) {
    assert.deepEqual([...overviewListsFor({ section, sub: null })], ['approvals'], section);
  }

  const tasksResult = results[ALL.indexOf('tasks')];
  const kept = settleList(['old row'], { loaded: true, error: false }, tasksResult);
  assert.deepEqual(kept, { items: ['old row'], state: { loaded: true, error: false } }, 'a skipped list keeps its rows and is not marked failed');
  const never = settleList([], { loaded: false, error: false }, tasksResult);
  assert.deepEqual(never.state, { loaded: false, error: false }, 'a list never loaded still shows as not loaded');
});

test('each page reads the lists it displays [AC:lab-startup-request-load#AC-8]', () => {
  const lists = (section: string, sub: string | null) => [...overviewListsFor({ section, sub })].sort();
  assert.deepEqual(lists('tasks', 'queue'), ['approvals', 'jobs', 'socialSchedules', 'tasks']);
  assert.deepEqual(lists('tasks', null), lists('tasks', 'queue'), 'the tasks section opens on the queue');
  assert.deepEqual(lists('tasks', 'runs'), ['approvals', 'orchestrationRuns', 'swarmRuns']);
  assert.deepEqual(lists('tasks', 'inbox'), ['approvals', 'mail', 'outboundDrafts', 'workspaces']);
  assert.deepEqual(lists('tasks', 'bots'), ['approvals']);
  assert.deepEqual(lists('agents', 'teams'), ['approvals', 'mail', 'swarmRuns']);
  assert.deepEqual(lists('agents', 'agents'), ['approvals']);
});

test('arriving on a page loads its lists, and timer refreshes keep them current while it is open [AC:lab-startup-request-load#AC-8]', async () => {
  const h = harness();
  h.cadence.markTimer();
  await h.refresh(chat);
  assert.equal(h.cadence.missed(queue), true, 'the queue lists were not part of the chat refresh');
  assert.equal(h.cadence.missed(chat), false);

  let location = chat;
  let refreshes = 0;
  location = queue;
  await refreshForPage(async () => {
    refreshes += 1;
    // The first refresh was already under way for the chat page.
    await h.refresh(refreshes === 1 ? chat : location);
  }, h.cadence, () => location);
  assert.equal(refreshes, 2, 'a refresh planned for the old page is followed by one for the new page');
  assert.equal(h.cadence.missed(queue), false);

  refreshes = 0;
  await refreshForPage(async () => { refreshes += 1; await h.refresh(location); }, h.cadence, () => location);
  assert.equal(refreshes, 1, 'one refresh is enough when it covered the page');

  h.cadence.markTimer();
  const onTimer = await h.refresh(queue);
  assert.deepEqual(onTimer.requested.sort(), ['approvals', 'jobs', 'socialSchedules', 'tasks']);
});

test('version, health and agents are re-read by the timer at most every thirty seconds [AC:lab-startup-request-load#AC-9]', async () => {
  const h = harness();
  h.cadence.markTimer();
  assert.equal(h.cadence.metaDue(), true, 'the first refresh reads them');
  await h.refresh(chat);
  assert.deepEqual(h.shared, ['/api/agents']);

  h.advance(2800);
  h.cadence.markTimer();
  assert.equal(h.cadence.metaDue(), false);
  await h.refresh(chat);
  assert.deepEqual(h.shared, ['/api/agents'], 'agents are not read again yet');

  h.advance(Math.max(META_REFRESH_MS, AGENTS_REFRESH_MS));
  h.cadence.markTimer();
  assert.equal(h.cadence.metaDue(), true);
  await h.refresh(chat);
  assert.deepEqual(h.shared, ['/api/agents', '/api/agents']);
});

test('a refresh asked for by the user or an action reads everything with new requests [AC:lab-startup-request-load#AC-9] [AC:lab-startup-request-load#AC-6]', async () => {
  const h = harness();
  h.cadence.markTimer();
  h.cadence.metaDue();
  const timed = await h.refresh(chat);
  assert.deepEqual(await timed.plan.read('/api/bots'), { via: 'shared' }, 'timer refreshes may join a pending timer read');

  h.advance(1000);
  assert.equal(h.cadence.metaDue(), true, 'not marked as a timer refresh: version and health are read');
  const asked = await h.refresh(chat);
  assert.deepEqual(await asked.plan.read('/api/bots'), { via: 'fresh' });
  assert.deepEqual(h.fresh, ['/api/agents', '/api/bots']);

  h.cadence.markTimer();
  h.cadence.clearTimer();
  assert.equal(h.cadence.metaDue(), true, 'a timer mark does not leak into a later refresh');
});

test('pages that list agents read them on every refresh', async () => {
  const h = harness();
  h.cadence.markTimer();
  await h.refresh({ section: 'agents', sub: 'agents' });
  h.cadence.markTimer();
  await h.refresh({ section: 'tasks', sub: 'inbox' });
  assert.deepEqual(h.shared, ['/api/agents', '/api/agents']);
});
