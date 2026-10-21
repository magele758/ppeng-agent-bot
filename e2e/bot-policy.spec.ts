import { test, expect, type Page } from '@playwright/test';

/** Bot 设置在「Bots 与 Agents → Bots」详情面板里；工具/技能名单收在「高级」折叠区。 */
async function openBotSettings(page: Page, name: string) {
  await page.goto('/#/agents/bots');
  await page.getByRole('listitem').filter({ hasText: name }).first().click();
  const detail = page.getByTestId('bot-detail');
  await detail.getByRole('tab', { name: '能力与权限', exact: true }).click();
  await expect(detail.getByLabel('Bot 权限档')).toBeVisible();
}

async function openAllowlists(page: Page) {
  const detail = page.getByTestId('bot-detail');
  if ((await detail.getByLabel('允许使用的工具').count()) === 0) {
    await detail.getByRole('button', { name: '工具与技能名单' }).click();
  }
}

test.describe('Bot permission settings', () => {
  test('permission tier saves, bypass asks for confirmation, and reload shows the stored value [AC:bots#AC-5]', async ({
    page,
    request
  }) => {
    const name = `E2E Policy ${Date.now()}`;
    const created = await request.post('/api/bots', { data: { name } });
    expect(created.status()).toBe(201);
    const { bot } = (await created.json()) as { bot: { id: string; canonicalSessionId: string } };
    const opened = await request.post(`/api/bots/${bot.id}/open`);
    const { session } = (await opened.json()) as { session: { id: string } };

    await openBotSettings(page, name);
    const select = page.getByLabel('Bot 权限档');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('auto');
    await expect(select.locator('option')).toHaveCount(5);

    await select.selectOption('ask');
    await expect
      .poll(async () => {
        const res = await request.get(`/api/sessions/${session.id}`);
        return ((await res.json()) as { session: { metadata: { permissionMode?: string } } }).session
          .metadata.permissionMode;
      })
      .toBe('ask');

    await select.selectOption('bypass');
    const confirm = page.getByRole('alertdialog', { name: '把这个 Bot 切到 bypass？' });
    await expect(confirm).toBeVisible();
    const stillAsk = await request.get(`/api/sessions/${session.id}`);
    expect(
      ((await stillAsk.json()) as { session: { metadata: { permissionMode?: string } } }).session
        .metadata.permissionMode
    ).toBe('ask');

    await confirm.getByRole('button', { name: '取消' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(select).toHaveValue('ask');

    await select.selectOption('bypass');
    await page.getByRole('button', { name: '确认使用 bypass' }).click();
    await expect(page.getByText('这条 Bot 会话处于 bypass')).toBeVisible();

    await request.post(`/api/bots/${bot.id}/open`);
    await openBotSettings(page, name);
    await expect(page.getByLabel('Bot 权限档')).toHaveValue('bypass');
  });

  test('allowlist warnings are saved, then still shown after a reload; clearing the list clears them', async ({
    page,
    request
  }) => {
    const name = `E2E Tools ${Date.now()}`;
    const created = await request.post('/api/bots', { data: { name } });
    expect(created.status()).toBe(201);
    const { bot } = (await created.json()) as { bot: { id: string } };
    const tools = ((await (await request.get('/api/tools')).json()) as { tools: { name: string }[] }).tools;
    const required = ['TodoWrite', 'load_skill', 'message_agent'];
    const narrow = tools.map((tool) => tool.name).find((n) => !required.includes(n))!;

    await openBotSettings(page, name);
    await openAllowlists(page);
    await expect(page.getByRole('alert').filter({ hasText: 'TodoWrite' })).toHaveCount(0);
    const list = page.getByLabel('允许使用的工具');
    await list.selectOption([narrow]);
    await page.getByRole('button', { name: '保存允许名单' }).click();
    for (const tool of required) {
      await expect(page.getByRole('alert').filter({ hasText: tool })).toBeVisible();
    }

    await page.reload();
    await openBotSettings(page, name);
    for (const tool of required) {
      await expect(page.getByRole('alert').filter({ hasText: tool })).toBeVisible();
    }
    const read = await request.get(`/api/bots/${bot.id}`);
    const { warnings } = (await read.json()) as { warnings: { code: string; tools: string[] }[] };
    expect(warnings).toEqual([{ code: 'missing_required_tools', tools: required }]);

    const cleared = await request.patch(`/api/bots/${bot.id}`, { data: { allowedTools: [] } });
    expect(cleared.ok()).toBe(true);
    await page.reload();
    await openBotSettings(page, name);
    await expect(page.getByRole('alert').filter({ hasText: 'TodoWrite' })).toHaveCount(0);
  });

  test('a deleted dynamic tool left in the allowlist is flagged, and one click removes only the stale name', async ({
    page,
    request
  }) => {
    const name = `E2E Stale ${Date.now()}`;
    const created = await request.post('/api/bots', { data: { name } });
    expect(created.status()).toBe(201);
    const { bot } = (await created.json()) as { bot: { id: string; canonicalSessionId: string } };
    const tools = ((await (await request.get('/api/tools')).json()) as { tools: { name: string }[] }).tools;
    const required = ['TodoWrite', 'load_skill', 'message_agent'];
    const keep = tools.map((tool) => tool.name).find((n) => !required.includes(n))!;
    const dynName = `e2e_stale_${Date.now()}`;

    const record = await request.post('/api/memory', {
      data: {
        scope: 'session.scratch',
        namespace: 'dyn-tools',
        key: dynName,
        sessionId: bot.canonicalSessionId,
        value: JSON.stringify({
          name: dynName,
          description: 'e2e',
          scope: 'session.scratch',
          status: 'active',
          source: { code: 'return 1' }
        })
      }
    });
    expect(record.status()).toBe(201);
    const { entry } = (await record.json()) as { entry: { id: string } };

    const saved = await request.patch(`/api/bots/${bot.id}`, {
      data: { allowedTools: [keep, dynName, 'mcp_s0_search'] }
    });
    expect(saved.ok()).toBe(true);
    const live = (await saved.json()) as { warnings: { code: string; tools: string[] }[] };
    expect(live.warnings.map((w) => w.code)).toEqual(['missing_required_tools']);

    await openBotSettings(page, name);
    await expect(page.getByRole('alert').filter({ hasText: '已经失效' })).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'TodoWrite' })).toContainText('MCP 工具名');

    const removed = await request.delete(`/api/memory/${entry.id}`);
    expect(removed.ok()).toBe(true);
    await page.reload();
    await openBotSettings(page, name);
    const stale = page.getByRole('alert').filter({ hasText: '已经失效' });
    await expect(stale).toBeVisible();
    await expect(stale).toContainText(dynName);
    await expect(stale).not.toContainText(keep);
    const flagged = (await (await request.get(`/api/bots/${bot.id}`)).json()) as {
      warnings: { code: string; tools: string[] }[];
    };
    expect(flagged.warnings.find((w) => w.code === 'stale_allowed_tools')?.tools).toEqual([dynName]);

    await stale.getByRole('button', { name: '一键移除失效项' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '已经失效' })).toHaveCount(0);
    const session = (await (await request.get(`/api/sessions/${bot.canonicalSessionId}`)).json()) as {
      session: { metadata: { allowedTools?: string[] } };
    };
    expect(session.session.metadata.allowedTools).toEqual([keep, 'mcp_s0_search']);
    await expect(page.getByRole('alert').filter({ hasText: 'TodoWrite' })).toBeVisible();
  });

  test('an old bypass Bot gets a confirmed one-click switch to auto, and nothing migrates on its own [AC:bots#AC-6]', async ({
    page,
    request
  }) => {
    const name = `E2E Legacy ${Date.now()}`;
    const other = `E2E Legacy Other ${Date.now()}`;
    const created = await request.post('/api/bots', { data: { name } });
    const { bot } = (await created.json()) as { bot: { id: string } };
    const otherCreated = await request.post('/api/bots', { data: { name: other } });
    const { bot: otherBot } = (await otherCreated.json()) as { bot: { id: string } };
    const sessionOf = async (id: string) => {
      const opened = await request.post(`/api/bots/${id}/open`);
      return ((await opened.json()) as { session: { id: string } }).session.id;
    };
    const sid = await sessionOf(bot.id);
    const otherSid = await sessionOf(otherBot.id);
    for (const id of [sid, otherSid]) {
      const set = await request.patch(`/api/sessions/${id}`, { data: { permissionMode: 'bypass', confirmBypass: true } });
      expect(set.ok()).toBe(true);
    }
    const modeOf = async (id: string) =>
      ((await (await request.get(`/api/sessions/${id}`)).json()) as {
        session: { metadata: { permissionMode?: string } };
      }).session.metadata.permissionMode;

    await openBotSettings(page, name);
    await expect(page.getByText('这条 Bot 会话处于 bypass')).toBeVisible();
    expect(await modeOf(sid)).toBe('bypass');

    await page.getByRole('button', { name: '改为 auto', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: '把这个 Bot 改回 auto？' });
    await expect(confirm).toBeVisible();
    expect(await modeOf(sid)).toBe('bypass');

    await confirm.getByRole('button', { name: '取消' }).click();
    await expect(confirm).toHaveCount(0);
    expect(await modeOf(sid)).toBe('bypass');

    await page.getByRole('button', { name: '改为 auto', exact: true }).click();
    await page.getByRole('button', { name: '确认改为 auto' }).click();
    await expect.poll(() => modeOf(sid)).toBe('auto');
    await expect(page.getByLabel('Bot 权限档')).toHaveValue('auto');
    await expect(page.getByText('这条 Bot 会话处于 bypass')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '改为 auto', exact: true })).toHaveCount(0);
    expect(await modeOf(otherSid)).toBe('bypass');
  });
  test('the daemon refuses bypass without confirmBypass and Bot policy in create-time metadata [AC:bots#AC-5]', async ({
    request
  }) => {
    const created = await request.post('/api/bots', { data: { name: `E2E Guard ${Date.now()}` } });
    const { bot } = (await created.json()) as { bot: { id: string } };
    const opened = await request.post(`/api/bots/${bot.id}/open`);
    const { session } = (await opened.json()) as { session: { id: string } };

    const unconfirmed = await request.patch(`/api/sessions/${session.id}`, {
      data: { permissionMode: 'bypass' }
    });
    expect(unconfirmed.status()).toBe(400);
    const cleared = await request.patch(`/api/sessions/${session.id}`, {
      data: { permissionMode: null }
    });
    expect(cleared.status()).toBe(400);
    const viaCreate = await request.post('/api/sessions', {
      data: { botId: bot.id, autoRun: false, metadata: { permissionMode: 'bypass', allowedTools: [] } }
    });
    expect(viaCreate.status()).toBe(400);
    const stored = await request.get(`/api/sessions/${session.id}`);
    const { session: after } = (await stored.json()) as {
      session: { metadata: { permissionMode?: string } };
    };
    expect(after.metadata.permissionMode).toBe('auto');
  });
});
