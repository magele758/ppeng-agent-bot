import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('overview places existing routines ahead of optional configuration [AC:compact-bot-settings#AC-1]', () => {
  const detail = source('./sections/agents/BotDetail.tsx');
  const overview = detail.slice(detail.indexOf('id={`${panelId}-page-overview`}'), detail.indexOf('id={`${panelId}-page-history`}'));
  assert.match(overview, /<BotOverviewInfo /);
  assert.match(overview, /<BotCronPanel /);
  assert.ok(overview.indexOf('<BotCronPanel ') < overview.indexOf('<BotModelSetting'));
  assert.doesNotMatch(detail.slice(0, detail.indexOf('className="bot-settings-tabs"')), /<p className="ag-panel__lead">\{bot.description\}/);
});
test('optional settings remain accessible in closed disclosures [AC:compact-bot-settings#AC-3]', () => {
  const detail = source('./sections/agents/BotDetail.tsx');
  assert.match(detail, /<details[^>]*><summary>\{t\('botSettings.modelAndExecution'\)\}/);
  assert.match(detail, /revealBotSetting/);
  assert.match(source('./BotCronPanel.tsx'), /<details[^>]*><summary>\{t\('botSettings.routineOptions'\)\}/);
});
