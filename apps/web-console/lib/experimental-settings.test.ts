import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUB_PAGES, parseHash, formatHash } from './nav.ts';
import { filterSettingsEntries } from './settings-search.ts';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const categoriesDir = path.resolve(here, '../components/sections/settings/categories');
const settingsSectionPath = path.resolve(here, '../components/sections/settings/SettingsSection.tsx');
const gatewayCardPath = path.resolve(here, '../components/GatewaySettingsCard.tsx');

/** 原先靠设置条目的 advanced 标记整张收起的项。 */
const EXPERIMENTAL_IDS = [
  'modelFallback',
  'compact',
  'goalVerify',
  'agentLoopEngine',
  'sandboxCloudflare',
  'dynTools',
  'discovery',
  'langfuse',
  'jev'
] as const;

interface EntryFact {
  id: string;
  category: string;
  advanced: boolean;
  file: string;
}

function parseEntries(source: string, file: string): EntryFact[] {
  const out: EntryFact[] = [];
  const re = /\bid\s*:\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    const window = source.slice(match.index ?? 0, (match.index ?? 0) + 600);
    const category = window.match(/\bcategory\s*:\s*['"]([^'"]+)['"]/);
    if (!category) continue;
    const head = window.split(/\brender\s*:/)[0] ?? window;
    out.push({
      id: match[1] ?? '',
      category: category[1] ?? '',
      advanced: /\badvanced\s*:\s*true\b/.test(head),
      file
    });
  }
  return out;
}

function allEntries(): EntryFact[] {
  const files = readdirSync(categoriesDir).filter((name) => name.endsWith('.tsx'));
  return files.flatMap((name) => parseEntries(readFileSync(path.join(categoriesDir, name), 'utf8'), name));
}

test('未开显示高级也能从设置进入实验特性 [AC:experimental-settings#AC-1]', () => {
  assert.equal(zh.settings.categories.experimental, '实验特性');
  assert.equal(en.settings.categories.experimental, 'Experimental');
  assert.equal(SUB_PAGES.settings.includes('models'), true);
  assert.equal(SUB_PAGES.settings.includes('integrations'), true);
  assert.equal(SUB_PAGES.settings.includes('experimental'), true);
  const loc = { section: 'settings' as const, sub: 'experimental', pane: null };
  assert.deepEqual(parseHash('#/settings/experimental'), loc);
  assert.equal(formatHash(loc), '#/settings/experimental');

  const section = readFileSync(settingsSectionPath, 'utf8');
  assert.match(section, /SUB_PAGES\.settings\.map/);
  assert.doesNotMatch(section, /experimental[\s\S]{0,80}advanced/);
  const listed = allEntries().filter((entry) => entry.category === 'experimental');
  const visible = filterSettingsEntries(
    listed.map((entry) => ({ id: entry.id, haystack: entry.id, advanced: entry.advanced })),
    '',
    false
  );
  assert.deepEqual(
    visible.map((entry) => entry.id),
    listed.map((entry) => entry.id)
  );
});

test('实验特性里有 Jev 评估和其余原高级项 [AC:experimental-settings#AC-2]', () => {
  const listed = allEntries().filter((entry) => entry.category === 'experimental');
  assert.deepEqual(
    listed.map((entry) => entry.id),
    [...EXPERIMENTAL_IDS]
  );
  assert.equal(listed.every((entry) => entry.advanced === false), true);
  assert.equal(zh.settingsEntries.jev.title, 'Jev 评估');
  assert.equal(en.settingsEntries.jev.title, 'Jev evaluation');
});

test('原分类不再重复这些项，显示高级仍只管其余分组 [AC:experimental-settings#AC-3]', () => {
  const entries = allEntries();
  const experimental = new Set(EXPERIMENTAL_IDS);
  for (const entry of entries) {
    if (entry.category === 'experimental') continue;
    assert.equal(experimental.has(entry.id as (typeof EXPERIMENTAL_IDS)[number]), false, entry.id);
  }
  assert.equal(entries.filter((entry) => entry.id === 'jev').length, 1);
  const gateway = readFileSync(gatewayCardPath, 'utf8');
  assert.match(gateway, /SettingsGroup advanced title=\{t\('settings\.gateway\.webhook\.title'\)\}/);
  const section = readFileSync(settingsSectionPath, 'utf8');
  assert.match(section, /<AdvancedToggle \/>/);
});

const SWITCH_CARDS: Record<(typeof EXPERIMENTAL_IDS)[number], string> = {
  modelFallback: 'components/ModelFallbackCard.tsx',
  compact: 'components/CompactSettingsCard.tsx',
  goalVerify: 'components/GoalSettingsCard.tsx',
  agentLoopEngine: 'components/AgentLoopSettingsCard.tsx',
  sandboxCloudflare: 'components/SandboxSettingsCard.tsx',
  dynTools: 'components/DynToolsSettingsCard.tsx',
  discovery: 'components/DiscoverySettingsCard.tsx',
  langfuse: 'components/LangfuseSettingsCard.tsx',
  jev: 'components/JevSettingsCard.tsx'
};

test('每一项都有名称、说明和开关 [AC:experimental-settings#AC-4]', () => {
  assert.equal(zh.settings.experimentalSwitch, '启用{name}');
  assert.equal(en.settings.experimentalSwitch, 'Enable {name}');
  const row = readFileSync(path.resolve(here, '../components/ui/ExperimentRow.tsx'), 'utf8');
  assert.match(row, /role="switch"/);
  assert.match(row, /ui-group__title/);
  assert.match(row, /ui-group__desc/);
  assert.match(row, /\{on && children/);
  assert.doesNotMatch(row, /RAW_AGENT_/);
  const webRoot = path.resolve(here, '..');
  for (const id of EXPERIMENTAL_IDS) {
    const source = readFileSync(path.join(webRoot, SWITCH_CARDS[id]), 'utf8');
    assert.match(source, new RegExp(`switchId="${id}"`), id);
  }
});
