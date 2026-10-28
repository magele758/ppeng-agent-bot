import { test, expect, type Page } from '@playwright/test';
const machines = [{ id: 'u0', name: 'Ubuntu', sshAlias: 'ubuntu', capacity: 1, botIds: ['bot'], allowedUserIds: ['owner'], repositories: [{ id: 'core', path: '/repo' }] }, { id: 'u1', name: 'Second', sshAlias: 'second', capacity: 1, botIds: ['bot'], allowedUserIds: ['owner'], repositories: [{ id: 'core', path: '/repo' }] }];
async function setup(page: Page, enabled = true) {
    await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [{ id: 'room', title: 'Factory', botIds: [] }] } }));
    await page.route('**/api/bots', r => r.fulfill({ json: { bots: [{ id: 'bot', name: 'Coordinator' }] } }));
    await page.route('**/api/factory/settings', r => r.fulfill({ json: { settings: { owner: { userId: 'owner' }, roomId: 'room', coordinatorBotId: 'bot', patrol: { enabled: false, timezone: 'Asia/Shanghai' }, machines } } }));
    await page.route('**/api/factory/board', r => r.fulfill({ json: { tasks: [], machines: [] } }));
    await page.route('**/api/factory/patrol', r => r.fulfill({ json: { settings: { enabled: false, timezone: 'Asia/Shanghai' }, state: {} } }));
    await page.route('**/api/factory/development/*/core', r => r.fulfill({ json: { settings: { enabled, model: 'saved-model' } } }));
    await page.route('**/api/factory/development/decisions', r => r.fulfill({ json: { tasks: [] } }));
    await page.goto('/#/settings/ops/factory');
    await expect(page.getByTestId('factory-development')).toBeVisible();
}
async function readyInputs(page: Page) {
    await page.getByLabel('精确基线提交（40位 SHA）').fill('a'.repeat(40));
    await page.getByLabel('开发需求', { exact: true }).fill('Implement approved change');
}
test('development remains explicitly disabled in a readonly profile', async ({ page }) => {
    await setup(page, false);
    await expect(page.getByTestId('development-enabled')).not.toBeChecked();
    await expect(page.getByTestId('development-submit')).toBeDisabled();
});
test('persisted development policy can preflight without an unnecessary save; failed preflight blocks dispatch', async ({ page }) => {
    await setup(page);
    await readyInputs(page);
    await expect(page.getByRole('button', { name: '检查开发就绪条件', exact: true })).toBeEnabled();
    await page.route('**/api/factory/development/u0/core/preflight', r => r.fulfill({ json: { ready: false, checks: [{ id: 'isolation', ok: false, detail: 'Unavailable' }] } }));
    await page.getByRole('button', { name: '检查开发就绪条件', exact: true }).click();
    await expect(page.getByTestId('development-preflight-result')).toContainText('isolation');
    await expect(page.getByTestId('development-submit')).toBeDisabled();
});
test('ambiguous dispatch retry retains request key and refreshes task evidence', async ({ page }) => {
    await setup(page);
    await readyInputs(page);
    await page.route('**/api/factory/development/u0/core/preflight', r => r.fulfill({ json: { ready: true, checks: [{ id: 'isolation', ok: true }] } }));
    await page.getByRole('button', { name: '检查开发就绪条件', exact: true }).click();
    const keys: string[] = [];
    await page.route('**/api/factory/development/tasks', r => { keys.push(r.request().postDataJSON().requestKey); return keys.length === 1 ? r.abort() : r.fulfill({ json: { task: { id: 'dev-1', machineId: 'u0', status: 'queued', development: { stage: 'QUEUED', round: 0, delivery: 'not_pushed' } } } }); });
    await page.getByTestId('development-submit').click();
    await expect(page.getByTestId('factory-development').getByRole('alert')).toBeVisible();
    await page.getByTestId('development-submit').click();
    await expect(page.getByTestId('development-task')).toContainText('dev-1');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await page.route('**/api/factory/development/tasks/dev-1', r => r.fulfill({ json: { task: { id: 'dev-1', machineId: 'u0', status: 'succeeded', result: { commit: 'b'.repeat(40) }, development: { stage: 'READY', round: 1, delivery: 'not_pushed' } } } }));
    await page.getByTestId('development-task-refresh').click();
    await expect(page.getByTestId('development-task')).toContainText('READY');
    await expect(page.getByTestId('development-task')).toContainText('b'.repeat(40));
});
test('stale profile success cannot overwrite selection or drafts and forbidden settings stay disabled', async ({ page }) => {
    await setup(page);
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/factory/development/u1/core', async (r) => { await delayed; await r.fulfill({ json: { settings: { enabled: true, model: 'late' } } }); });
    await page.getByTestId('development-machine').selectOption('u1');
    await page.getByTestId('development-machine').selectOption('u0');
    await expect(page.getByTestId('development-model')).toHaveValue('saved-model');
    release();
    await expect(page.getByTestId('development-model')).toHaveValue('saved-model');
    await page.route('**/api/factory/development/u1/core', r => r.fulfill({ status: 403, json: { error: 'forbidden' } }));
    await page.getByTestId('development-machine').selectOption('u1');
    await expect(page.getByTestId('factory-development').getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('development-save')).toBeDisabled();
    await expect(page.getByTestId('development-submit')).toBeDisabled();
});
test('pending decisions cannot be submitted twice and reassign includes explicit target', async ({ page }) => {
    await setup(page);
    await page.route('**/api/factory/development/decisions', r => r.fulfill({ json: { tasks: [{ id: 'decision-1', machineId: 'u0', status: 'failed', development: { stage: 'WAITING_DECISION', round: 6, decisions: [] } }] } }));
    await page.getByTestId('development-decisions-refresh').click();
    const card = page.getByTestId('development-decision-decision-1');
    await expect(card).toBeVisible();
    let finish!: () => void;
    const pending = new Promise<void>(r => { finish = r; });
    let body: unknown;
    await page.route('**/api/factory/development/tasks/decision-1/decision', async (r) => { body = r.request().postDataJSON(); await pending; await r.fulfill({ json: { task: { id: 'decision-1', machineId: 'u1', status: 'queued', development: { stage: 'QUEUED', round: 6, decisions: [] } } } }); });
    await card.getByTestId('development-reassign-machine').selectOption('u1');
    await card.getByTestId('development-reassign').click();
    await expect(card.getByTestId('development-reassign')).toBeDisabled();
    await expect.poll(() => body).toEqual({ action: 'reassign', machineId: 'u1', repositoryId: 'core' });
    finish();
});
test('saved policy survives reload and edited baseline invalidates readiness [AC:multi-machine-controlled-development#AC-1] [AC:multi-machine-controlled-development#AC-2]', async ({ page }) => {
    await setup(page);
    let saved: {
        enabled: boolean;
        model: string;
    } = { enabled: true, model: 'saved-model' };
    await page.route('**/api/factory/development/u0/core', r => { if (r.request().method() === 'PATCH')
        saved = r.request().postDataJSON(); return r.fulfill({ json: { settings: saved } }); });
    const panel = page.getByTestId('factory-development');
    await page.getByTestId('development-model').fill('new-model');
    await expect(page.getByTestId('development-submit')).toBeDisabled();
    await page.getByTestId('development-save').click();
    await expect(panel.getByRole('status')).toContainText('配置已保存');
    await page.reload();
    await expect(page.getByTestId('development-model')).toHaveValue('new-model');
    await readyInputs(page);
    await page.route('**/api/factory/development/u0/core/preflight', r => r.fulfill({ json: { ready: true, checks: [{ id: 'isolation', ok: true }] } }));
    await page.getByRole('button', { name: '检查开发就绪条件', exact: true }).click();
    await expect(page.getByTestId('development-submit')).toBeEnabled();
    await page.getByLabel('精确基线提交（40位 SHA）').fill('b'.repeat(40));
    await expect(page.getByTestId('development-submit')).toBeDisabled();
});

test('common board distinguishes local READY and controls active development through its own endpoint [AC:multi-machine-controlled-development#AC-21] [AC:multi-machine-controlled-development#AC-25] [AC:multi-machine-controlled-development#AC-27]', async ({ page }) => {
    await setup(page);
    let active = true, paused = false;
    const task = () => ({ id: 'board-dev', machineId: 'u0', status: active ? 'running' : paused ? 'failed' : 'succeeded', updatedAt: new Date().toISOString(), history: [], development: { stage: active ? 'DEV' : paused ? 'PAUSED' : 'READY', round: 1 }, result: { development: { sha: 'c'.repeat(40) } } });
    await page.route('**/api/factory/board', r => r.fulfill({ json: { tasks: [task()], machines: [] } }));
    await page.getByTestId('factory-refresh').click();
    const row = page.getByRole('row').filter({ hasText: 'board-dev' });
    await expect(row.getByRole('button', { name: '暂停开发任务' })).toBeVisible();
    let control: unknown;
    await page.route('**/api/factory/development/tasks/board-dev/control', r => { control = r.request().postDataJSON(); active = false; paused = true; return r.fulfill({ json: { task: task() } }); });
    await row.getByRole('button', { name: '暂停开发任务' }).click();
    await expect.poll(() => control).toEqual({ action: 'pause' });
    await expect(row).toContainText('PAUSED');
    paused = false; await page.getByTestId('factory-refresh').click();
    await expect(row).toContainText('仅本地 READY');
    await expect(row).not.toContainText('只读任务成功');
});

test('approved baseline failure IDs preserve one item per line on load and save [AC:multi-machine-controlled-development#AC-1] [AC:multi-machine-controlled-development#AC-14]', async ({ page }) => {
    await setup(page);
    const panel = page.getByTestId('factory-development');
    await panel.getByText('高级执行策略', { exact: true }).click();
    await panel.getByLabel('已批准的基线失败标识（每行一项）').fill('existing-a\nexisting-b');
    let submitted: { baselineFailures: string[] } | undefined;
    await page.route('**/api/factory/development/u0/core', route => {
        submitted = route.request().postDataJSON();
        return route.fulfill({ json: { settings: submitted } });
    });
    await page.getByTestId('development-save').click();
    await expect.poll(() => submitted?.baselineFailures).toEqual(['existing-a', 'existing-b']);
    await expect(panel.getByLabel('已批准的基线失败标识（每行一项）')).toHaveValue('existing-a\nexisting-b');
});
