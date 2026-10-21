export const settings = {
  fontSize: {
    title: 'Font size', keywords: 'font size text appearance typography',
    description: 'Adjust text throughout the console. Changes apply immediately and are saved in this browser.',
    option: '{size}px', defaultOption: '{size}px (default)', reset: 'Restore default',
    preview: 'Reading comfortably. Aa — 清晰阅读，舒适交流 · 0123456789',
    saveFailed: 'Could not save the font size. It is applied for now, but may reset when you reopen the page.'
  },

  categories: {
    general: 'General',
    models: 'Models',
    behavior: 'Agent behavior',
    safety: 'Safety & sandbox',
    tools: 'Tools & skills',
    integrations: 'Integrations & observability',
    ops: 'Ops'
  },
  categoriesLabel: 'Settings categories',
  searchPlaceholder: 'Search settings (e.g. model, API key, Feishu, theme)',
  searchCount: '{count} settings found',
  searchClear: 'Clear search',
  noResultsTitle: 'No matching settings',
  noResultsDesc: 'Nothing matches "{query}". Try another keyword.',
  emptyCategoryTitle: 'No common settings here yet',
  emptyCategoryDesc: 'Turn on "Show advanced" at the top right to see more options.',
  entries: {
    language: { title: 'Language', keywords: 'ui language locale 中文 English' },
    theme: { title: 'Theme', keywords: 'appearance theme dark light night follow system' },
    modelProviders: {
      title: 'Model providers',
      keywords: 'API key secret base url model provider openai anthropic deepseek ollama wizard test connection default model'
    },
    modelFallback: { title: 'Model fallback', keywords: 'backup model fallback retry degrade' },
    gateway: {
      title: 'Gateway & IM access',
      keywords: 'feishu lark wecom wechat gateway IM webhook token secret encrypt allowlist sender botId signature'
    }
  },
  saveState: {
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    saved: 'Saved, takes effect immediately',
    failed: 'Save failed, please retry'
  },
  onboarding: {
    title: 'No real model configured yet',
    descDemo: 'You are on the built-in demo model (local heuristic); replies are only for trying out the UI. Add a model provider to get real answers — all it takes is an API key, about a minute.',
    descNone: 'No model is available yet. Add a model provider to start chatting — all it takes is an API key, about a minute.',
    cta: 'Set up a model',
    dismiss: 'Later'
  },
  theme: {
    desc: 'Pick the color scheme. "Follow system" switches with your OS light/dark setting.',
    light: 'Light',
    dark: 'Dark',
    system: 'Follow system'
  },
  model: {
    globalDefault: {
      title: 'Global default model',
      description: 'Bots, group members, and conversations without their own selection follow this model immediately after saving. Bot-specific and conversation selections take priority; clear them to follow the global default again.',
      empty: 'No usable model configured',
      configure: 'Configure models',
      saved: 'Global default model saved as {model}',
      saveFailed: 'Could not save the global default. The model may have been disabled or removed. Your saved configuration is unchanged; refresh the list and retry.',
      follow: 'Follow global default',
      following: 'Global default · {provider}'
    },
    desc: 'Pick a provider, paste the API key, test the connection and choose a default model. Takes effect immediately — no .env edit or restart.',
    wizardTitle: 'Add a model provider',
    stepProvider: 'Choose a provider',
    stepKey: 'Enter your API key',
    stepTest: 'Test the connection',
    stepSave: 'Choose a default model',
    providerGroup: 'Provider',
    customProvider: 'Custom',
    presetSiliconflow: 'SiliconFlow',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'Paste your API key',
    apiKeyHint: 'The key is stored on this machine\'s daemon only and is shown masked afterwards. Local services (e.g. Ollama) can keep the placeholder value.',
    showKey: 'Show',
    hideKey: 'Hide',
    needKey: 'Enter an API key first',
    test: 'Test connection',
    testing: 'Testing…',
    testOk: 'Connected — found {count} models',
    testOkNoModels: 'Connected, but no models were listed. Enter a model ID under "Advanced options".',
    defaultModel: 'Default model',
    saveAndUse: 'Save and use {name}',
    saveDisabled: 'Save and use',
    savedUse: 'Saved — {name} is now the default model',
    addAnother: 'Add another',
    done: 'Done',
    advanced: 'Advanced options',
    advancedHide: 'Hide advanced options',
    name: 'Provider name',
    namePlaceholder: 'Leave blank to name it automatically',
    manualModel: 'Model ID (manual)',
    manualModelPlaceholder: 'e.g. gpt-4o-mini (takes priority when filled)',
    enabledModels: 'Models available in chat',
    enabledModelsHint: 'Checked models appear in the chat model picker; the default model is always enabled.',
    errors: {
      missingKey: 'Enter an API key first.',
      missingUrl: 'Enter a Base URL first.',
      auth: 'The API key is invalid or lacks permission. Check it and try again.',
      notFound: 'The model list endpoint was not found. Check the Base URL (it usually ends with /v1).',
      rateLimit: 'The provider is rate limiting you. Try again shortly.',
      server: 'The provider is temporarily unavailable. Try again later.',
      network: 'Could not reach the provider. Check the Base URL and your network.',
      unknown: 'Connection failed: {detail}'
    },
    list: {
      loadFailed: 'Could not load the model configuration. Make sure the daemon is running, then refresh.',
      current: 'Current default model',
      noDefault: 'No default model yet',
      changeKey: 'Change key',
      keyUpdated: 'Key updated and re-checked — found {count} models',
      manageModels: 'Manage models',
      confirmDelete: 'Confirm delete',
      retest: 'Re-check',
      makeDefault: 'Make default',
      defaultBadge: 'default',
      modelCount: '{count} models available',
      status: {
        ok: 'Ready',
        error: 'Check failed',
        unchecked: 'Not checked',
        builtin: 'Built-in'
      }
    }
  },
  gateway: {
    title: 'Gateway & IM access',
    desc: 'Verification and access control for inbound Feishu / WeCom messages. Takes effect immediately — no .env edit or restart. Saved secrets only show "Set" and are never echoed back.',
    unavailable: 'This daemon does not support the gateway settings API yet (upgrade to a build with the gateway security fixes).',
    secretSet: 'Set',
    secretUnset: 'Not set',
    secretKeep: 'Set — leave blank to keep it',
    secretPlaceholder: 'Paste, then save',
    willClear: 'Cleared on save',
    clear: 'Clear',
    undoClear: 'Undo clear',
    clearNamed: 'Clear {name}',
    sendersPlaceholder: 'One ID per line (commas also work); leave empty for no restriction',
    sendersHint: 'Accepts open_id / user_id / union_id / chat_id.',
    botNone: 'Not bound (default routing)',
    botHint: 'When bound, messages from this channel go into this Bot\'s canonical session.',
    save: 'Save gateway settings',
    feishu: {
      title: 'Feishu',
      desc: 'Event-subscription verification token, encrypt key, and which senders may message the bot.',
      verificationToken: 'Feishu Verification Token',
      encryptKey: 'Feishu Encrypt Key',
      allowedSenders: 'Feishu sender allowlist',
      botId: 'Feishu bound Bot'
    },
    wecom: {
      title: 'WeCom',
      desc: 'Shared secret for the bridge, and which senders may message the bot.',
      bridgeSecret: 'WeCom bridge secret',
      allowedSenders: 'WeCom sender allowlist',
      botId: 'WeCom bound Bot'
    },
    webhook: {
      title: 'Generic webhook',
      desc: 'Restrict which senders may come in through the generic webhook.',
      allowedSenders: 'Webhook sender allowlist'
    }
  }
};
