import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { getMessage, interpolate } from './i18n/t.ts';
import {
  KIND_FIELDS,
  SECRET_FORM_FIELDS,
  emptyForm,
  entryFillRefs,
  entryPayload,
  entrySubtitle,
  fillRefsText,
  type VaultEntry
} from './user-vault.ts';

const login: VaultEntry = {
  id: 'login_1',
  kind: 'login',
  label: 'GitHub',
  fillRefs: { username: 'uvref:login_1:username', password: 'uvref:login_1:password' },
  login: { username: 'lei', sites: ['https://github.com'] }
};
const card: VaultEntry = {
  id: 'card_1',
  kind: 'card',
  label: 'Visa',
  fillRefs: { cardNumber: 'uvref:card_1:cardNumber' },
  card: { last4: '4242' }
};

describe('Lab User Vault card model', () => {
  test('picking an entry yields a fill instruction naming its uvref refs, no secrets [AC:user-vault-tools#AC-5]', () => {
    assert.deepEqual(entryFillRefs(login), ['uvref:login_1:username', 'uvref:login_1:password']);
    for (const messages of [en, zh]) {
      const template = getMessage(messages, 'settingsEntries.userVault.fillInstruction');
      assert.ok(template);
      const text = interpolate(template, { label: login.label, refs: fillRefsText(login) });
      assert.ok(text.includes('vault_fill'));
      assert.ok(text.includes('uvref:login_1:password'));
      assert.ok(text.includes('GitHub'));
    }
    assert.equal(entrySubtitle(card), '•••• 4242');
    assert.equal(entrySubtitle(login), 'lei');
  });

  test('form payload carries only filled fields of the chosen kind; secrets are write-only inputs [AC:user-vault-tools#AC-5]', () => {
    const form = { ...emptyForm('login'), label: ' GitHub ', username: 'lei', sites: 'https://a.com, https://b.com', password: 'pw', cvv: 'ignored' };
    assert.deepEqual(entryPayload(form), {
      kind: 'login',
      label: 'GitHub',
      username: 'lei',
      sites: ['https://a.com', 'https://b.com'],
      password: 'pw'
    });
    assert.deepEqual(SECRET_FORM_FIELDS, ['password', 'number', 'cvv']);
    for (const field of SECRET_FORM_FIELDS) {
      assert.ok(Object.values(KIND_FIELDS).some((fields) => fields.includes(field)));
    }
  });
});
