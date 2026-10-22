import test from 'node:test';
import assert from 'node:assert/strict';
import { zh } from './i18n/messages/zh/index.ts';
import { en } from './i18n/messages/en/index.ts';
import { osSandboxReasonKey, parseOsSandboxReason } from './os-sandbox-reason.ts';

test('shell sandbox reasons map to visible copy [AC:saved-sandbox-mode-constrains-shell#AC-2] [AC:saved-sandbox-mode-constrains-shell#AC-3]', () => {
  assert.equal(parseOsSandboxReason('hi'), undefined);
  assert.equal(parseOsSandboxReason('[os-sandbox:saved-os] stayed'), 'saved-os');
  assert.equal(parseOsSandboxReason('out\n[os-sandbox:auto-strongest] because auto'), 'auto-strongest');
  assert.equal(parseOsSandboxReason('{"os_sandbox_note":"[os-sandbox:auto-model-os] picked"}'), 'auto-model-os');
  assert.match(zh.play.turns.osSandbox.savedOs, /系统级隔离/);
  assert.match(zh.play.turns.osSandbox.autoStrongest, /自动/);
  assert.match(zh.play.turns.osSandbox.autoModelOs, /系统级隔离/);
  assert.match(en.play.turns.osSandbox.savedOs, /OS-level/);
  assert.match(en.play.turns.osSandbox.autoStrongest, /Auto/);
  assert.equal(osSandboxReasonKey('saved-os'), 'play.turns.osSandbox.savedOs');
  assert.equal(osSandboxReasonKey('auto-strongest'), 'play.turns.osSandbox.autoStrongest');
  assert.equal(osSandboxReasonKey('auto-model-os'), 'play.turns.osSandbox.autoModelOs');
});
