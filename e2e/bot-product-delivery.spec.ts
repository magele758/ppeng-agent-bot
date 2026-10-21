import { test, expect } from '@playwright/test';

test('failed task retains a readable report and downloadable artifact without a verification claim [AC:bot-product-p0#AC-6] [AC:bot-product-p0#AC-7]', async ({ page }) => {
  const task = { id: 'delivery-task', targetBotId: 'super-bot', input: 'Research delivery', status: 'failed',
    result: '# Partial report\nA useful finding.', failureReason: 'Second source unavailable',
    delivery: { taskId: 'delivery-task', sessionId: 'delivery-session', attempt: 1, executionStatus: 'failed',
      createdAt: new Date().toISOString(), report: '# Partial report\nA useful finding.',
      failureReason: 'Second source unavailable', verification: 'unverified',
      artifacts: [{ id: 'delivery-file', fileName: 'report.md', mimeType: 'text/markdown', totalBytes: 16 }],
      receipts: [{ id: 'receipt-1', connectorId: 'research', toolName: 'fetch_source', state: 'completed', result: { ok: true, content: 'Source collected' } }] } };
  await page.route('**/api/bot-work/tasks?*', route => route.fulfill({ json: { tasks: [task], activeTasks: [], historyTasks: [task] } }));
  await page.route('**/api/bot-work/tasks/delivery-task', route => route.fulfill({ json: { task } }));
  await page.route('**/api/artifact/delivery-file/download', route => route.fulfill({ contentType: 'text/markdown', body: 'Actual file body' }));
  await page.goto('/#/tasks/bots');
  await page.getByTestId('bot-team-work').getByRole('button', { name: '详情', exact: true }).click();
  const delivery = page.getByTestId('bot-task-delivery');
  await expect(delivery.getByRole('heading', { name: 'Partial report' })).toBeVisible();
  await expect(delivery).toContainText('Second source unavailable');
  await expect(delivery).toContainText('尚未验证');
  await expect(delivery).toContainText('fetch_source');
  await expect(delivery.getByRole('link', { name: '下载 report.md' })).toHaveAttribute('href', '/api/artifact/delivery-file/download');
  await delivery.getByRole('button', { name: '预览 report.md' }).click();
  await expect(delivery.getByTestId('artifact-preview')).toHaveText('Actual file body');
});
