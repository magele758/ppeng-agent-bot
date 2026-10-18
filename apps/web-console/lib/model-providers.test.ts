import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogNeedsSetup,
  catalogToPickerOptions,
  classifyScanError,
  defaultEnabledModelIds,
  modelSetupState,
  pickDefaultModel,
  groupPickerOptionsByProvider,
  globalDefaultModelOptions,
  isVerifiedConfiguredProvider,
  baseUrlFromModelsEndpoint,
  matchProviderPresetId,
  parseManualModelIds,
  providersForPresetRow,
  resolvePickerModelRef,
  type ModelPickerOption,
  type ModelProvidersResponse,
  type PublicModelProvider
} from './model-providers.ts';

const opt = (
  providerId: string,
  providerName: string,
  modelId: string
): ModelPickerOption => ({
  providerId,
  providerName,
  modelId,
  kind: 'openai-compatible',
  source: 'ui'
});

test('global default offers enabled real models with provider labels only [AC:global-default-model-clarity#AC-1] [AC:global-default-model-clarity#AC-5]', () => {
  const provider = (id: string, kind: string, hasApiKey = true) => ({ id, name: id, kind, source: 'ui', baseUrl: 'https://example.test/v1', hasApiKey, models: [{ id: 'enabled', enabled: true }, { id: 'off', enabled: false }] });
  const data = { catalog: { providers: [provider('real', 'openai-compatible'), provider('demo', 'heuristic'), provider('no-key', 'openai-compatible', false)] }, options: [opt('deleted', 'Removed', 'stale')] } as unknown as ModelProvidersResponse;
  assert.deepEqual(globalDefaultModelOptions(data).map((o) => [o.providerId, o.providerName, o.modelId]), [['real', 'real', 'enabled']]);
  data.catalog.providers = [provider('demo', 'heuristic')] as PublicModelProvider[];
  assert.deepEqual(globalDefaultModelOptions(data), []);
});

test('groupPickerOptionsByProvider keeps provider order and groups models', () => {
  const grouped = groupPickerOptionsByProvider([
    opt('ds', 'DeepSeek', 'v3'),
    opt('oa', 'OpenAI', 'gpt-4o'),
    opt('ds', 'DeepSeek', 'r1')
  ]);
  assert.deepEqual(
    grouped.map((g) => [g.providerId, g.providerName, g.options.map((o) => o.modelId)]),
    [
      ['ds', 'DeepSeek', ['v3', 'r1']],
      ['oa', 'OpenAI', ['gpt-4o']]
    ]
  );
});

test('groupPickerOptionsByProvider empty', () => {
  assert.deepEqual(groupPickerOptionsByProvider([]), []);
});

test('parseManualModelIds splits and dedupes', () => {
  assert.deepEqual(parseManualModelIds('glm-4, my-model；glm-4\nfoo'), ['glm-4', 'my-model', 'foo']);
  assert.deepEqual(parseManualModelIds('  '), []);
});

test('catalogToPickerOptions includes custom UI providers', () => {
  const data = {
    catalog: {
      providers: [
        {
          id: 'prov-custom',
          name: '我的网关',
          kind: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          hasApiKey: true,
          apiKeyMasked: '••••',
          useJsonMode: true,
          models: [
            { id: 'my-model', enabled: true },
            { id: 'hidden', enabled: false }
          ],
          createdAt: 't',
          updatedAt: 't',
          source: 'ui'
        },
        {
          id: 'heuristic',
          name: '本地启发式',
          kind: 'heuristic',
          baseUrl: '',
          hasApiKey: false,
          apiKeyMasked: '',
          useJsonMode: false,
          models: [{ id: 'heuristic', enabled: true }],
          createdAt: 't',
          updatedAt: 't',
          source: 'builtin'
        }
      ],
      defaultRef: null,
      updatedAt: 't'
    },
    options: [],
    persisted: true,
    effective: { source: 'ui', defaultRef: { providerId: 'prov-custom', modelId: 'my-model' } }
  } as ModelProvidersResponse;
  const opts = catalogToPickerOptions(data);
  assert.deepEqual(
    opts.map((o) => [o.providerId, o.providerName, o.modelId, o.source]),
    [
      ['prov-custom', '我的网关', 'my-model', 'ui'],
      ['heuristic', '本地启发式', 'heuristic', 'builtin']
    ]
  );
});

function pub(partial: Partial<PublicModelProvider> & Pick<PublicModelProvider, 'id' | 'source'>): PublicModelProvider {
  return {
    name: partial.name ?? partial.id,
    kind: partial.kind ?? 'openai-compatible',
    baseUrl: partial.baseUrl ?? 'https://api.example.com/v1',
    hasApiKey: partial.hasApiKey ?? true,
    apiKeyMasked: '••••',
    useJsonMode: true,
    models: partial.models ?? [{ id: 'm', enabled: true }],
    createdAt: 't',
    updatedAt: 't',
    ...partial
  };
}

test('catalogToPickerOptions excludes env fallback', () => {
  const data = {
    catalog: {
      providers: [
        pub({
          id: '__env__',
          name: '环境变量（回退）',
          source: 'env',
          models: [{ id: 'glm-5.2', enabled: true }]
        }),
        pub({
          id: 'prov-ui',
          name: '我的网关',
          source: 'ui',
          scannedAt: 't',
          models: [{ id: 'ui-model', enabled: true }]
        })
      ],
      defaultRef: { providerId: '__env__', modelId: 'glm-5.2' },
      updatedAt: 't'
    },
    options: [],
    persisted: false,
    effective: { source: 'env', defaultRef: { providerId: '__env__', modelId: 'glm-5.2' } }
  } as ModelProvidersResponse;
  const opts = catalogToPickerOptions(data);
  assert.deepEqual(
    opts.map((o) => [o.providerId, o.providerName, o.modelId]),
    [['prov-ui', '我的网关', 'ui-model']]
  );
});

test('catalogToPickerOptions keeps heuristic and scan-failed UI models', () => {
  const data = {
    catalog: {
      providers: [
        pub({
          id: 'bad',
          name: 'Broken',
          source: 'ui',
          scanError: '401',
          models: [{ id: 'glm', enabled: true }]
        }),
        pub({
          id: 'heuristic',
          name: '本地启发式',
          kind: 'heuristic',
          source: 'builtin',
          baseUrl: '',
          hasApiKey: false,
          models: [{ id: 'heuristic', enabled: true }]
        })
      ],
      defaultRef: null,
      updatedAt: 't'
    },
    options: [],
    persisted: true,
    effective: { source: 'heuristic', defaultRef: { providerId: 'heuristic', modelId: 'heuristic' } }
  } as ModelProvidersResponse;
  const opts = catalogToPickerOptions(data);
  assert.deepEqual(
    opts.map((o) => [o.providerId, o.modelId]),
    [
      ['bad', 'glm'],
      ['heuristic', 'heuristic']
    ]
  );
  assert.equal(catalogNeedsSetup(data), false);
});

test('catalogNeedsSetup is true when only env fallback exists', () => {
  const data = {
    catalog: {
      providers: [
        pub({
          id: '__env__',
          name: '环境变量（回退）',
          source: 'env',
          models: [{ id: 'glm-5.2', enabled: true }]
        })
      ],
      defaultRef: { providerId: '__env__', modelId: 'glm-5.2' },
      updatedAt: 't'
    },
    options: [],
    persisted: false,
    effective: { source: 'env', defaultRef: { providerId: '__env__', modelId: 'glm-5.2' } }
  } as ModelProvidersResponse;
  assert.equal(catalogNeedsSetup(data), true);
  assert.equal(catalogNeedsSetup(null), true);
});

test('resolvePickerModelRef prefers catalog default and never env', () => {
  const ui = opt('prov-ui', '我的网关', 'ui-model');
  assert.equal(resolvePickerModelRef([ui], { providerId: '__env__', modelId: 'glm-5.2' }), null);
  assert.deepEqual(
    resolvePickerModelRef(
      [ui],
      { providerId: '__env__', modelId: 'glm-5.2' },
      { providerId: 'prov-ui', modelId: 'ui-model' }
    ),
    { providerId: 'prov-ui', modelId: 'ui-model' }
  );
  assert.deepEqual(resolvePickerModelRef([ui], { providerId: 'prov-ui', modelId: 'ui-model' }), {
    providerId: 'prov-ui',
    modelId: 'ui-model'
  });
  assert.equal(resolvePickerModelRef([], { providerId: '__env__', modelId: 'glm-5.2' }, { providerId: '__env__', modelId: 'glm-5.2' }), null);
});

test('isVerifiedConfiguredProvider rejects heuristic and failed scan', () => {
  assert.equal(isVerifiedConfiguredProvider(pub({ id: 'h', source: 'builtin', kind: 'heuristic', baseUrl: '' })), false);
  assert.equal(isVerifiedConfiguredProvider(pub({ id: 'bad', source: 'ui', scanError: '401' })), false);
  assert.equal(isVerifiedConfiguredProvider(pub({ id: 'nokey', source: 'ui', hasApiKey: false })), false);
  assert.equal(isVerifiedConfiguredProvider(pub({ id: 'ok', source: 'ui', scannedAt: 't' })), true);
  assert.equal(isVerifiedConfiguredProvider(pub({ id: 'env', source: 'env' })), true);
});

test('providersForPresetRow keeps UI custom and hides unused / heuristic', () => {
  const custom = pub({ id: 'tokenpony', name: 'Tokenpony', source: 'ui', scannedAt: 't' });
  const heuristic = pub({ id: 'heuristic', source: 'builtin', kind: 'heuristic', baseUrl: '' });
  const envOk = pub({
    id: 'env-oa',
    name: 'OpenAI',
    source: 'env',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-4o', enabled: true }]
  });
  assert.deepEqual(
    providersForPresetRow([heuristic, custom, envOk]).map((p) => p.id),
    ['tokenpony']
  );
  assert.deepEqual(providersForPresetRow([heuristic]), []);
});

test('baseUrlFromModelsEndpoint strips /models', () => {
  assert.equal(
    baseUrlFromModelsEndpoint('https://api.tokenpony.cn/v1/models'),
    'https://api.tokenpony.cn/v1'
  );
});

test('matchProviderPresetId maps known base URLs and falls back to custom', () => {
  assert.equal(
    matchProviderPresetId({ kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/' }),
    'openai'
  );
  assert.equal(
    matchProviderPresetId({ kind: 'openai-compatible', baseUrl: 'https://api.tokenpony.cn' }),
    'custom'
  );
});

const catalogOf = (providers: PublicModelProvider[]): ModelProvidersResponse =>
  ({
    catalog: { providers, defaultRef: null, updatedAt: 't' },
    options: [],
    persisted: true,
    effective: { source: 'ui', defaultRef: { providerId: 'x', modelId: 'y' } }
  }) as ModelProvidersResponse;

test('modelSetupState: demo when only heuristic exists, ready once a keyed provider has a model [AC:settings-models-onboarding#AC-1]', () => {
  const heuristic = pub({
    id: 'heuristic',
    kind: 'heuristic',
    source: 'builtin',
    baseUrl: '',
    hasApiKey: false,
    models: [{ id: 'heuristic', enabled: true }]
  });
  assert.equal(modelSetupState(catalogOf([heuristic])), 'demo');
  assert.equal(modelSetupState(catalogOf([])), 'none');
  const real = pub({ id: 'ds', source: 'ui', models: [{ id: 'deepseek-chat', enabled: true }] });
  assert.equal(modelSetupState(catalogOf([heuristic, real])), 'ready');
  const noKey = pub({ id: 'ds2', source: 'ui', hasApiKey: false, models: [{ id: 'm', enabled: true }] });
  assert.equal(modelSetupState(catalogOf([heuristic, noKey])), 'demo');
});

test('pickDefaultModel prefers the preset favourite and skips non-chat models [AC:settings-models-onboarding#AC-3]', () => {
  const ids = (...x: string[]) => x.map((id) => ({ id }));
  assert.equal(pickDefaultModel(ids('text-embedding-3-small', 'gpt-4o', 'gpt-4o-mini'), 'openai'), 'gpt-4o-mini');
  assert.equal(pickDefaultModel(ids('deepseek-reasoner', 'deepseek-chat'), 'deepseek'), 'deepseek-chat');
  assert.equal(pickDefaultModel(ids('whisper-1', 'some-model'), 'custom'), 'some-model');
  assert.equal(pickDefaultModel(ids('text-embedding-x'), 'custom'), 'text-embedding-x');
  assert.equal(pickDefaultModel([], 'openai'), undefined);
});

test('classifyScanError turns raw upstream failures into actionable kinds [AC:settings-models-onboarding#AC-4]', () => {
  assert.equal(classifyScanError('HTTP 401: {"error":"bad key"} (https://x/v1/models, status 401)'), 'auth');
  assert.equal(classifyScanError('HTTP 404: not found (https://x/models, status 404)'), 'notFound');
  assert.equal(classifyScanError('HTTP 429: slow down'), 'rateLimit');
  assert.equal(classifyScanError('HTTP 503: down'), 'server');
  assert.equal(classifyScanError('fetch failed (http://127.0.0.1:1/v1/models)'), 'network');
  assert.equal(classifyScanError('缺少 API Key'), 'missingKey');
  assert.equal(classifyScanError('缺少 Base URL'), 'missingUrl');
  assert.equal(classifyScanError('weird'), 'unknown');
  assert.equal(classifyScanError(undefined), 'unknown');
});

test('defaultEnabledModelIds skips non-chat models and caps huge catalogs [AC:settings-models-onboarding#AC-3]', () => {
  const small = [{ id: 'a' }, { id: 'text-embedding-x' }, { id: 'b' }];
  assert.deepEqual(defaultEnabledModelIds(small, 'a'), ['a', 'b']);
  const big = Array.from({ length: 80 }, (_, i) => ({ id: `m${i}` }));
  assert.deepEqual(defaultEnabledModelIds(big, 'm3'), ['m3']);
});
