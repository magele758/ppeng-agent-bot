import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkillProposalStore } from '../packages/core/dist/skill-proposals/index.js';

const stateDir = process.env.PLAYWRIGHT_E2E_STATE_DIR;

test.describe('Skill proposals card', () => {
  test.skip(!stateDir, 'needs the e2e-run.mjs managed daemon state dir');

  test('enable switch, queued proposal shows up, approve installs the skill [AC:skill-proposals#AC-1] [AC:skill-proposals#AC-2] [AC:skill-proposals#AC-3]', async ({ page }) => {
    const store = new SkillProposalStore(stateDir!);
    store.create({
      name: 'e2e-release-checklist',
      description: 'Release checklist distilled from an e2e run',
      body: '# Release checklist\n\n1. Run the unit tests.\n2. Tag the release.\n',
      sessionId: 'sess_e2e_smoke'
    });

    await page.goto('/#/agents/skills');
    const card = page.locator('#card-skill-proposals');
    await expect(card.getByRole('heading', { name: '技能提案' })).toBeVisible({ timeout: 15_000 });

    const toggle = card.getByRole('checkbox', { name: /skill_propose/ });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(card.getByText('已保存，立即生效')).toBeVisible();
    await expect(toggle).toBeChecked();

    const row = card.getByTestId('skill-proposal-e2e-release-checklist');
    await expect(row).toBeVisible();
    await expect(row.getByText('来源会话：sess_e2e_smoke')).toBeVisible();
    const approve = row.getByRole('button', { name: '批准' });
    await expect(approve).toBeDisabled();

    await row.getByRole('button', { name: '查看完整内容' }).click();
    await expect(row.getByTestId('skill-proposal-body-e2e-release-checklist')).toContainText('Tag the release.');
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect(card.getByText('已批准「e2e-release-checklist」', { exact: false })).toBeVisible();
    await expect(row).toHaveCount(0);

    const installed = join(stateDir!, 'skills', 'e2e-release-checklist', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf8')).toContain('Tag the release.');

    const skills = await page.request.get('/api/skills');
    const body = (await skills.json()) as { skills?: Array<{ name: string; source?: string }> };
    expect(body.skills?.find((s) => s.name === 'e2e-release-checklist')?.source).toBe('user');
  });

  test('revoke an approved skill (with confirm) and reject with a reason [AC:skill-proposals#AC-4] [AC:skill-proposals#AC-5]', async ({ page }) => {
    const store = new SkillProposalStore(stateDir!);
    const body = '# Runbook\n\n1. Do the thing.\n';
    store.create({ name: 'e2e-revoke-me', description: 'Will be revoked', body, sessionId: 'sess_e2e_revoke' });
    store.create({ name: 'e2e-reject-me', description: 'Will be rejected', body, sessionId: 'sess_e2e_revoke' });

    await page.goto('/#/agents/skills');
    const card = page.locator('#card-skill-proposals');
    await expect(card.getByRole('heading', { name: '技能提案' })).toBeVisible({ timeout: 15_000 });

    const rejectRow = card.getByTestId('skill-proposal-e2e-reject-me');
    await rejectRow.getByRole('textbox', { name: '拒绝原因（可选）' }).fill('过于宽泛');
    await rejectRow.getByRole('button', { name: '拒绝' }).click();
    await expect(card.getByText('已拒绝「e2e-reject-me」', { exact: false })).toBeVisible();
    await expect(card.getByTestId('skill-decided-e2e-reject-me')).toContainText('原因：过于宽泛');
    expect(store.list({ status: 'rejected' }).find((p) => p.name === 'e2e-reject-me')?.rejectReason).toBe('过于宽泛');

    const row = card.getByTestId('skill-proposal-e2e-revoke-me');
    await row.getByRole('button', { name: '查看完整内容' }).click();
    await row.getByRole('button', { name: '批准' }).click();
    const approvedRow = card.getByTestId('bot-skill-manager').locator('article').filter({ has: page.getByRole('heading', { name: 'e2e-revoke-me', exact: true }) });
    await expect(approvedRow).toBeVisible();
    const installed = join(stateDir!, 'skills', 'e2e-revoke-me', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);

    const skillNames = async () => {
      const res = await page.request.get('/api/skills');
      const data = (await res.json()) as { skills?: Array<{ name: string }> };
      return (data.skills ?? []).map((x) => x.name);
    };
    expect(await skillNames()).toContain('e2e-revoke-me');

    page.once('dialog', (dialog) => void dialog.dismiss());
    await approvedRow.getByRole('button', { name: '撤销' }).click();
    await expect(approvedRow).toBeVisible();
    expect(existsSync(installed)).toBe(true);

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('e2e-revoke-me');
      void dialog.accept();
    });
    await approvedRow.getByRole('button', { name: '撤销' }).click();
    await expect.poll(() => store.list({ status: 'revoked' }).some(proposal => proposal.name === 'e2e-revoke-me')).toBe(true);
    await expect(approvedRow).toHaveCount(0);
    await expect(card.getByTestId('skill-decided-e2e-revoke-me')).toContainText('已撤销');
    expect(existsSync(join(stateDir!, 'skills', 'e2e-revoke-me'))).toBe(false);
    expect(await skillNames()).not.toContain('e2e-revoke-me');
    expect(store.list({ status: 'revoked' }).some((p) => p.name === 'e2e-revoke-me')).toBe(true);
  });
});
