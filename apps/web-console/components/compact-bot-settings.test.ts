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

test('capabilities prioritize connections and collapse configuration [AC:compact-bot-secondary-tabs#AC-1]', () => {
  const detail = source('./sections/agents/BotDetail.tsx');
  const page = detail.slice(detail.indexOf('id={`${panelId}-page-permissions`}'));
  assert.ok(page.indexOf('<BotConnections') < page.indexOf('<BotPolicySettings'));
  assert.match(page, /<details[^>]*data-testid="bot-tools-settings"[^>]*><summary>/);
  assert.match(page, /<details[^>]*data-testid="bot-skills-settings"[^>]*><summary>/);
  assert.doesNotMatch(page, /<details[^>]*\bopen[=> ]/);
});
test('records keep history primary and fold secondary content [AC:compact-bot-secondary-tabs#AC-2]', () => {
  const detail = source('./sections/agents/BotDetail.tsx');
  const page = detail.slice(detail.indexOf('id={`${panelId}-page-history`}'), detail.indexOf('id={`${panelId}-page-permissions`}'));
  assert.match(page, /<details[^>]*data-testid="bot-memory-settings"[^>]*><summary>/);
  assert.match(detail, /<details[^>]*data-testid="bot-other-records"[^>]*><summary>/);
  assert.match(page, /<BotOtherRecords>\{records\}<\/BotOtherRecords>/);
  const history = source('./bot-work/BotHistory.tsx');
  assert.match(history, /<details[^>]*data-testid="bot-history-filters"[^>]*>/);
  assert.ok(history.indexOf('bot-history-query') < history.indexOf('bot-history-filters'));
  assert.match(history, /maxHeight: 280, overflow: "auto"/);
  assert.doesNotMatch(page, /<details[^>]*\bopen[=> ]/);
});
test('connection tools have closed counted disclosure [AC:compact-bot-secondary-tabs#AC-3]', () => {
  const connections = source('./bot-work/BotConnections.tsx');
  assert.match(connections, /<details[^>]*data-testid="connection-tools"[^>]*>\s*<summary>\{t\('botSettings.connectionTools', \{ count: c.tools.length \}\)\}/);
});
