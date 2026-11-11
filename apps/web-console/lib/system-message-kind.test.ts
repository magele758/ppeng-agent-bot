import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySystemMessage } from './system-message-kind.ts';
import { normalizedRole } from './chat-utils.ts';
test('background receipt identity is system while human copies remain human [AC:background-job-notice#AC-2]',()=>{
 for(const key of ['background-job:bg_123','source:event:background-job:bg_123']){
  assert.equal(normalizedRole({role:'user',key,parts:[{type:'text',text:'Background job bg_123 completed.\n(no output)'}]}),'system');
 }
 assert.equal(normalizedRole({role:'user',parts:[{type:'text',text:'Background job bg_123 completed.'}]}),'user');
 assert.equal(classifySystemMessage('[background-job] bg_123 completed.').kind,'backgroundJob');
 assert.equal(classifySystemMessage('Background job bg_123 completed.\n(no output)').kind,'backgroundJob');
});
test('system sources have contextual categories [AC:system-message-ui#AC-1]', () => {
  const cases = { recovery: ['[recovery] retrying','[recovery-advisory] change strategy','[recovery:unknown] effects unconfirmed'], fallback: ['[model-fallback] switched'], continuing: ['[goal-continuing] Ship it — this run reached its step limit'], goal: ['[goal] not yet met','[goal coordination] waiting','[goal revision 2] changed'], compact: ['[pre-compact] starting','[on-compact] summary'], hook: ['[stop-hook] blocked','[stop-extension] wait'], collaboration: ['[bot-help] result','[team-dag] update'], access: ['[command-hardline] denied','[sharing-domain-changed] new domain'], context: ['[explicit-shared-context] shared','[routine-context session=example] context','[skill-review reminder] inspect'] };
  for (const [kind, examples] of Object.entries(cases)) for (const text of examples) assert.equal(classifySystemMessage(text).kind, kind, text);
  assert.equal(classifySystemMessage('[recovery] Stopped: empty_assistant').kind, 'stopped');
  assert.equal(classifySystemMessage('[recovery] retrying').warning, false);
});
test('unknown and unmarked content remains neutral and verbatim [AC:system-message-ui#AC-2]', () => {
  for (const raw of ['extension output\n'+ 'x'.repeat(2000), '[future-type] stopped maybe', '', '  [not-known] <script>x</script>\n']) {
    const result = classifySystemMessage(raw);
    assert.equal(result.kind, 'generic');
    assert.equal(result.warning, false);
    assert.equal(result.raw, raw);
  }
});
