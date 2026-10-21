import test from 'node:test';
import assert from 'node:assert/strict';
import { applyJevContextSelect } from '../dist/jev/points/context-select.js';
import { applyJevToolSelect } from '../dist/jev/points/tool-select.js';
import { applyJevSkillSelect } from '../dist/jev/points/skill-select.js';
import { applyJevMemorySelect } from '../dist/jev/points/memory-select.js';
import { applyJevRecoveryChoice } from '../dist/jev/points/recovery-choice.js';
import { applyJevPreTurn } from '../dist/jev/points/pre-turn.js';
import { applyJevSagaGate } from '../dist/jev/points/saga-gate.js';
import {
  createPtcJevHooks,
  jevPtcChoice,
  jevPtcNoul,
  normalizePtcChoiceOptions
} from '../dist/jev/points/ptc-decide.js';
import {
  applyJevContextSelect as applyJevContextSelectWrap,
  applyJevMemorySelect as applyJevMemorySelectWrap,
  applyJevPreTurn as applyJevPreTurnWrap,
  applyJevRecoveryChoice as applyJevRecoveryChoiceWrap,
  applyJevSkillSelect as applyJevSkillSelectWrap,
  applyJevToolSelect as applyJevToolSelectWrap
} from '../dist/jev/apply.js';
import { writeJevSettings } from '../dist/jev/settings.js';

const CHAIN = {
  baseUrl: 'https://api.typesafe.ai/v1',
  apiKey: 'k',
  model: 'jev-latest',
  points: ['toolSelect'],
  modules: {
    goalGate: false,
    toolGate: false,
    compact: false,
    route: false,
    contextSelect: false,
    toolSelect: true,
    skillSelect: false,
    sagaGate: false,
    memorySelect: false,
    recoveryChoice: false,
    preTurn: false,
    ptcDecide: false
  }
};

function kvStore() {
  const map = new Map();
  return {
    getDaemonControl(key) {
      return map.get(key);
    },
    setDaemonControl(key, value) {
      map.set(key, value);
    }
  };
}

function noulAnswers(map) {
  return Object.fromEntries(Object.entries(map).map(([id, noul]) => [id, { noul }]));
}

function choiceAnswers(id, choice, confidence) {
  return { [id]: { choice, confidence } };
}

function longText(seed, n = 220) {
  return `${seed} ${'x'.repeat(n)}`;
}

function msg(role, parts, seq = 1) {
  return {
    id: `m-${role}-${seq}`,
    sessionId: 's1',
    role,
    parts,
    createdAt: new Date(0).toISOString(),
    seq
  };
}

test('contextSelect: protects recent two user turns; drops low-relevance early; keeps errors', async () => {
  const early = longText('old-context');
  const errContent = longText('boom-error');
  const recent = longText('recent-user');
  const messages = [
    msg('assistant', [{ type: 'text', text: early }], 1),
    msg('tool', [{ type: 'tool_result', toolCallId: 't1', name: 'bash', ok: false, content: errContent }], 2),
    msg('user', [{ type: 'text', text: longText('first-user') }], 3),
    msg('assistant', [{ type: 'text', text: longText('mid') }], 4),
    msg('user', [{ type: 'text', text: recent }], 5)
  ];
  let asks = 0;
  const out = await applyJevContextSelect(CHAIN, messages, 'deploy', async () => {
    asks += 1;
    return noulAnswers({ c0: 0.1 });
  });
  assert.equal(asks, 1);
  assert.ok(out);
  assert.equal(out.length, 4);
  assert.ok(out.some((m) => m.parts.some((p) => p.type === 'tool_result' && p.ok === false)));
  assert.ok(out.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('recent-user'))));
  assert.ok(!out.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('old-context'))));
});

test('contextSelect: low-relevance tool_result is stubbed, not removed', async () => {
  const messages = [
    msg('assistant', [{ type: 'tool_call', toolCallId: 'c1', name: 'bash', input: {} }], 1),
    msg('tool', [{ type: 'tool_result', toolCallId: 'c1', name: 'bash', ok: true, content: longText('stdout') }], 2),
    msg('user', [{ type: 'text', text: longText('u1') }], 3),
    msg('user', [{ type: 'text', text: longText('u2') }], 4)
  ];
  const out = await applyJevContextSelect(CHAIN, messages, 'task', async () => noulAnswers({ c0: 0.1 }));
  const result = out.flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
  assert.equal(result.toolCallId, 'c1');
  assert.match(result.content, /jev-context/);
});

test('contextSelect: ask failure returns null (fail-open)', async () => {
  const messages = [
    msg('assistant', [{ type: 'text', text: longText('early') }], 1),
    msg('user', [{ type: 'text', text: longText('u1') }], 2),
    msg('user', [{ type: 'text', text: longText('u2') }], 3)
  ];
  const out = await applyJevContextSelect(CHAIN, messages, 'task', async () => null);
  assert.equal(out, null);
});

test('toolSelect/skillSelect: <2 or all below threshold ⇒ null; never invents names', async () => {
  assert.equal(await applyJevToolSelect(CHAIN, 't', [{ name: 'a' }]), null);
  assert.equal(await applyJevSkillSelect(CHAIN, 't', [{ name: 'a' }]), null);

  const tools = [
    { name: 'bash' },
    { name: 'read_file' },
    { name: 'web_search' }
  ];
  assert.equal(
    await applyJevToolSelect(CHAIN, 't', tools, async () => noulAnswers({ t0: 0.1, t1: 0.2, t2: 0.3 })),
    null
  );
  const kept = await applyJevToolSelect(CHAIN, 't', tools, async () =>
    noulAnswers({ t0: 0.9, t1: 0.1, t2: 0.8 })
  );
  assert.deepEqual(kept, ['bash', 'web_search']);
  assert.ok(!kept.includes('rm_rf'));

  const skills = [
    { name: 'deploy' },
    { name: 'debug' },
    { name: 'docs' }
  ];
  assert.equal(
    await applyJevSkillSelect(CHAIN, 't', skills, async () => noulAnswers({ s0: 0.1, s1: 0.2, s2: 0.3 })),
    null
  );
  const skillKept = await applyJevSkillSelect(CHAIN, 't', skills, async () =>
    noulAnswers({ s0: 0.9, s1: 0.1, s2: 0.1 })
  );
  assert.deepEqual(skillKept, ['deploy']);
});

test('memorySelect: fail-open on null/low; keeps ids from input only', async () => {
  const items = [
    { id: 'a', text: 'alpha' },
    { id: 'b', text: 'beta' },
    { id: 'c', text: 'gamma' }
  ];
  assert.equal(await applyJevMemorySelect(CHAIN, 't', items, async () => null), null);
  assert.equal(
    await applyJevMemorySelect(CHAIN, 't', items, async () => noulAnswers({ m0: 0.1, m1: 0.1, m2: 0.1 })),
    null
  );
  const kept = await applyJevMemorySelect(CHAIN, 't', items, async () =>
    noulAnswers({ m0: 0.9, m1: 0.1, m2: 0.8 })
  );
  assert.deepEqual(kept, ['a', 'c']);
});

test('recoveryChoice: low confidence / unknown id / <2 ⇒ null', async () => {
  const opts = [
    { id: 'retry', label: 'Retry' },
    { id: 'stop', label: 'Stop' }
  ];
  assert.equal(await applyJevRecoveryChoice(CHAIN, 'sit', [{ id: 'only', label: 'x' }]), null);
  assert.equal(
    await applyJevRecoveryChoice(CHAIN, 'sit', opts, async () =>
      choiceAnswers('recovery', 'retry', 0.2)
    ),
    null
  );
  assert.equal(
    await applyJevRecoveryChoice(CHAIN, 'sit', opts, async () =>
      choiceAnswers('recovery', 'hack', 0.99)
    ),
    null
  );
  assert.equal(
    await applyJevRecoveryChoice(CHAIN, 'sit', opts, async () =>
      choiceAnswers('recovery', 'stop', 0.9)
    ),
    'stop'
  );
});

test('preTurn: no goal never asks; skip only at high noul; fail-open null', async () => {
  let asks = 0;
  const ask = async () => {
    asks += 1;
    return noulAnswers({ met: 0.95 });
  };
  assert.equal(await applyJevPreTurn(CHAIN, 'done?', false, ask), 'call_model');
  assert.equal(asks, 0);
  assert.equal(await applyJevPreTurn(CHAIN, 'done?', true, ask), 'skip_done');
  assert.equal(asks, 1);
  assert.equal(
    await applyJevPreTurn(CHAIN, 'done?', true, async () => noulAnswers({ met: 0.2 })),
    'call_model'
  );
  assert.equal(await applyJevPreTurn(CHAIN, 'done?', true, async () => null), null);
});

test('sagaGate: <2 null; fail-open invokeLlm; high confidence picks option', async () => {
  const opts = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' }
  ];
  assert.equal(await applyJevSagaGate(CHAIN, 't', [{ id: 'a', label: 'A' }]), null);
  assert.deepEqual(await applyJevSagaGate(CHAIN, 't', opts, async () => null), null);
  assert.deepEqual(
    await applyJevSagaGate(CHAIN, 't', opts, async () => ({
      ...noulAnswers({ enough: 0.9 }),
      ...choiceAnswers('next', 'b', 0.9)
    })),
    { invokeLlm: false, optionId: 'b' }
  );
  assert.deepEqual(
    await applyJevSagaGate(CHAIN, 't', opts, async () => ({
      ...noulAnswers({ enough: 0.2 }),
      ...choiceAnswers('next', 'a', 0.9)
    })),
    { invokeLlm: true }
  );
});

test('ptcDecide: options capped at 8; fail-open null; hooks use injected ask', async () => {
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`o${i}`, `L${i}`]));
  const { ids } = normalizePtcChoiceOptions(nine);
  assert.equal(ids.length, 8);
  assert.ok(!ids.includes('o8'));

  assert.equal(await jevPtcNoul(CHAIN, '', undefined, async () => noulAnswers({ ptc_noul: 0.9 })), null);
  assert.equal(await jevPtcNoul(CHAIN, 'q', undefined, async () => null), null);
  assert.deepEqual(await jevPtcNoul(CHAIN, 'q', undefined, async () => noulAnswers({ ptc_noul: 0.7 })), {
    value: true,
    p: 0.7
  });

  assert.equal(
    await jevPtcChoice(CHAIN, 'pick', ['only'], undefined, async () =>
      choiceAnswers('ptc_choice', 'only', 0.9)
    ),
    null
  );
  assert.equal(
    await jevPtcChoice(CHAIN, 'pick', ['a', 'b'], undefined, async () => null),
    null
  );
  assert.deepEqual(
    await jevPtcChoice(CHAIN, 'pick', ['a', 'b'], undefined, async () =>
      choiceAnswers('ptc_choice', 'b', 0.88)
    ),
    { value: 'b', p: 0.88 }
  );

  let asks = 0;
  const hooks = createPtcJevHooks(CHAIN, undefined, async () => {
    asks += 1;
    return noulAnswers({ ptc_noul: 0.6 });
  });
  assert.deepEqual(await hooks.noul('ok?'), { value: true, p: 0.6 });
  assert.equal(asks, 1);
});

test('apply wrappers: inactive point never asks (custom only toolSelect)', async () => {
  const store = kvStore();
  writeJevSettings(store, {
    baseUrl: 'https://api.typesafe.ai/v1',
    profile: 'custom',
    points: { toolSelect: true }
  });
  let asks = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    asks += 1;
    return new Response(JSON.stringify({ answers: {} }), { status: 200 });
  };
  try {
    assert.equal(await applyJevContextSelectWrap(store, [msg('user', [{ type: 'text', text: 'hi' }])], 't'), null);
    assert.equal(await applyJevSkillSelectWrap(store, 't', [{ name: 'a' }, { name: 'b' }]), null);
    assert.equal(await applyJevMemorySelectWrap(store, 't', [{ id: '1', text: 'a' }, { id: '2', text: 'b' }]), null);
    assert.equal(
      await applyJevRecoveryChoiceWrap(store, 's', [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' }
      ]),
      null
    );
    assert.equal(await applyJevPreTurnWrap(store, 'goal?', true), null);
    assert.equal(asks, 0);

    // Active toolSelect may ask once.
    await applyJevToolSelectWrap(store, 't', [{ name: 'a' }, { name: 'b' }]);
    assert.equal(asks, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('applyJevPreTurn wrap: goalGate active forces call_model even if point would skip', async () => {
  const store = kvStore();
  writeJevSettings(store, {
    baseUrl: 'https://api.typesafe.ai/v1',
    profile: 'custom',
    points: { preTurn: true, goalGate: true }
  });
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ answers: { met: { noul: 0.99 } } }), { status: 200 });
  try {
    assert.equal(await applyJevPreTurnWrap(store, 'goal met?', true), 'call_model');
  } finally {
    globalThis.fetch = orig;
  }
});
test('explicit tool delivery is authoritative without another model round [AC:tool-exposure-tiers#AC-1] [AC:tool-exposure-tiers#AC-7]',async()=>{
 const store=kvStore();writeJevSettings(store,{baseUrl:'https://example.invalid/v1',profile:'custom',points:{toolSelect:true}});const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({answers:{}}),{status:200});};
 try{assert.equal(await applyJevToolSelectWrap(store,'t',[{name:'read_file'},{name:'bot_create'}],{preserveExposure:true}),null);assert.equal(calls,0);}finally{globalThis.fetch=original;}
});
