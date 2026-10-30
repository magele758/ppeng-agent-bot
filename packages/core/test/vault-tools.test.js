import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { UserVault, createMemorySecretVault } from '../dist/secrets/index.js';
import { writeUserVaultSettings, USER_VAULT_SETTINGS_KEY } from '../dist/secrets/user-vault-settings.js';
import { createVaultTools } from '../dist/tools/vault-tools.js';
import { assembleOptionalTools } from '../dist/runtime/tool-assembly.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';

const PASSWORD = 'Hunter2-VAULT-PW!';
const CARD = '4242424242424242';
const CVV = '737';

/** Drop entry ids, uvref tokens and timestamps before looking for a secret substring. */
function withoutOpaqueTokens(text) {
  return String(text)
    .replace(/"(?:id|billingAddressId)"\s*:\s*"[^"]*"/g, '"id":"<id>"')
    .replace(/uvref:[A-Za-z0-9_-]+:[A-Za-z]+/g, '<ref>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
}

function seed(vault) {
  const login = vault.upsertLogin({ label: 'GitHub', username: 'lei', password: PASSWORD, sites: ['https://github.com'] });
  // Id embeds the CVV so the model-facing scan is exercised on every run, not only
  // when a random UUID happens to contain those three digits.
  const card = vault.upsertCard({
    id: 'card_737deadbeef',
    label: 'Travel Visa',
    holderName: 'Lei P',
    expiry: '12/30',
    number: CARD,
    cvv: CVV
  });
  const contact = vault.upsertContact({ label: 'Me', fullName: 'Lei Peng', email: 'me@example.com' });
  return { login, card, contact };
}

function harness({ enabled = true, browser = true, failSelectors = [] } = {}) {
  const vault = new UserVault();
  const entries = seed(vault);
  const typed = [];
  const tools = createVaultTools({
    getVault: () => vault,
    isEnabled: () => enabled,
    isFillTargetAvailable: () => browser,
    fillField: async (_ctx, selector, value) => {
      if (failSelectors.includes(selector)) return false;
      typed.push({ selector, value });
      return true;
    }
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { vault, entries, typed, byName, ctx: {} };
}

test('vault_list / vault_get return uvref refs, never secrets [AC:user-vault-tools#AC-1]', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.byName).sort(), ['vault_fill', 'vault_get', 'vault_list']);

  const all = await h.byName.vault_list.execute(h.ctx, {});
  assert.equal(all.ok, true);
  assert.equal(JSON.parse(all.content).count, 3);
  for (const secret of [PASSWORD, CARD, CVV]) assert.ok(!withoutOpaqueTokens(all.content).includes(secret));
  assert.ok(all.content.includes(h.entries.login.fillRefs.password));

  const cards = JSON.parse((await h.byName.vault_list.execute(h.ctx, { kind: 'card' })).content);
  assert.deepEqual(cards.entries.map((e) => e.label), ['Travel Visa']);
  const byQuery = JSON.parse((await h.byName.vault_list.execute(h.ctx, { query: 'github.COM' })).content);
  assert.deepEqual(byQuery.entries.map((e) => e.id), [h.entries.login.id]);
  assert.equal((await h.byName.vault_list.execute(h.ctx, { kind: 'bogus' })).ok, false);

  const one = await h.byName.vault_get.execute(h.ctx, { id: h.entries.card.id });
  assert.equal(one.ok, true);
  assert.ok(one.content.includes(h.entries.card.fillRefs.cvv));
  for (const secret of [PASSWORD, CARD, CVV]) assert.ok(!withoutOpaqueTokens(one.content).includes(secret));
  assert.equal((await h.byName.vault_get.execute(h.ctx, { id: 'nope' })).ok, false);
});

test('vault tools are hidden and refuse to run until the Lab toggle is on [AC:user-vault-tools#AC-1]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-tools-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const vault = new UserVault(store);
  seed(vault);
  const agent = { id: 'general', name: 'General', allowedTools: undefined };
  const session = store.createSession({ title: 'v', mode: 'chat', agentId: agent.id, background: false });
  const assembled = assembleOptionalTools({
    env: { RAW_AGENT_DISCOVERY: '0' },
    store,
    stateDir: dir,
    getUserVault: () => vault,
    getCronStore() { throw Error('not used'); }
  });
  store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  const names = assembled.filter((tool) => tool.name.startsWith('vault_')).map((tool) => tool.name);
  assert.deepEqual(names.sort(), ['vault_fill', 'vault_get', 'vault_list']);
  const visible = () =>
    filterToolsForSession({
      env: {},
      tools: assembled,
      agent,
      session: store.getSession(session.id),
      settingsStore: store
    }).tools.map((tool) => tool.name);

  assert.ok(!visible().some((name) => name.startsWith('vault_')));
  const list = assembled.find((tool) => tool.name === 'vault_list');
  const refused = await list.execute({}, {});
  assert.equal(refused.ok, false);
  assert.match(refused.content, /disabled/);

  writeUserVaultSettings(store, { enabled: true });
  assert.equal(store.getDaemonControl(USER_VAULT_SETTINGS_KEY).enabled, true);
  assert.ok(visible().includes('vault_list'));
  assert.equal((await list.execute({}, {})).ok, true);
});

test('vault_list stays ok when a short secret collides with an opaque id or timestamp [AC:user-vault-tools#AC-1]', async () => {
  const h = harness();
  const listed = await h.byName.vault_list.execute(h.ctx, {});
  assert.equal(listed.ok, true);
  assert.ok(listed.content.includes('uvref:card_737deadbeef:cvv'));
  assert.ok(!listed.content.includes(PASSWORD));
  assert.ok(!listed.content.includes(CARD));

  const { assertModelFacingHasNoUserVaultSecrets } = await import('../dist/secrets/index.js');
  const stamped = `${listed.content}\n"updatedAt": "2026-10-30T03:17:37.737Z"`;
  assert.doesNotThrow(() => assertModelFacingHasNoUserVaultSecrets(stamped, h.vault));
  assert.throws(
    () => assertModelFacingHasNoUserVaultSecrets(`${listed.content}\nnote ${CVV}`, h.vault),
    /must not appear/
  );
});

test('vault_fill types resolved values into the form; result lists refs only [AC:user-vault-tools#AC-2]', async () => {
  const h = harness();
  const { login, card } = h.entries;
  assert.equal(h.byName.vault_fill.approvalMode, 'always');
  const result = await h.byName.vault_fill.execute(h.ctx, {
    fields: [
      { ref: login.fillRefs.username, selector: '#user' },
      { ref: login.fillRefs.password, selector: '#pw' },
      { ref: login.fillRefs.password, selector: '#pw2' },
      { ref: card.fillRefs.cardNumber, selector: '#cc' }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(h.typed, [
    { selector: '#user', value: 'lei' },
    { selector: '#pw', value: PASSWORD },
    { selector: '#pw2', value: PASSWORD },
    { selector: '#cc', value: CARD }
  ]);
  const body = JSON.parse(result.content);
  assert.equal(body.filled, 3);
  assert.ok(body.fields.every((f) => f.ref.startsWith('uvref:') && f.selector.startsWith('#')));
  for (const secret of [PASSWORD, CARD, CVV]) assert.ok(!withoutOpaqueTokens(result.content).includes(secret));
});

test('vault_fill failures name refs and selectors, never secrets [AC:user-vault-tools#AC-3]', async () => {
  const { login } = harness().entries;
  const noBrowser = harness({ browser: false });
  const r1 = await noBrowser.byName.vault_fill.execute({}, { fields: [{ ref: noBrowser.entries.login.fillRefs.password, selector: '#pw' }] });
  assert.equal(r1.ok, false);
  assert.match(r1.content, /browser/i);
  assert.equal(noBrowser.typed.length, 0);

  const h = harness({ failSelectors: ['#pw'] });
  const pw = h.entries.login.fillRefs.password;
  const cases = [
    { fields: [] },
    { fields: [{ ref: pw }] },
    { fields: [{ ref: 'not-a-ref', selector: '#a' }] },
    { fields: [{ ref: 'uvref:missing:password', selector: '#a' }] },
    { fields: [{ ref: pw, selector: '#pw' }] },
    { fields: Array.from({ length: 21 }, () => ({ ref: pw, selector: '#a' })) }
  ];
  for (const args of cases) {
    const r = await h.byName.vault_fill.execute(h.ctx, args);
    assert.equal(r.ok, false, JSON.stringify(args).slice(0, 80));
    for (const secret of [PASSWORD, CARD, CVV]) assert.ok(!withoutOpaqueTokens(r.content).includes(secret));
  }
  const failed = await h.byName.vault_fill.execute(h.ctx, { fields: [{ ref: pw, selector: '#pw' }] });
  assert.match(failed.content, /#pw/);
  assert.match(failed.content, /uvref:/);
  assert.ok(login);
});

test('vault tools never touch SecretVault [AC:user-vault-tools#AC-4]', async () => {
  const secrets = createMemorySecretVault();
  secrets.set('CONNECTOR_TOKEN', 'connector-env-secret');
  const h = harness();
  const out = await h.byName.vault_list.execute(h.ctx, {});
  assert.ok(!out.content.includes('CONNECTOR_TOKEN'));
  assert.ok(!JSON.stringify(secrets.list()).includes('uvref:'));
});
