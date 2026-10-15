export const more = {
  help: 'Help',
  savedNoRestart: 'Saved, takes effect immediately (no .env / restart)',
  sourceUi: 'UI config',
  sourceDefault: 'Default',
  on: 'On',
  off: 'Off',
  effectivePrefix: 'Effective: ',


  compactCollapseLabel: 'Collapse used results',
  compactCollapseTip:
    'Replace tool_result the model already saw with a one-line stub to save window. SQLite stays full text.',
  compactPolicyAria: 'Tool-result compact policy',
  compactPolicyKeepRecent: 'Off (default, keep recent N)',
  compactPolicyAfterText: 'On · after text reply',
  compactPolicyAfterAny: 'On · after any assistant turn',
  compactKeepRecent: 'Keep recent N (default policy)',
  compactKeepRecentInvalid: 'Keep count must be an integer from 0–50',
  compactSessionStats: 'This session collapsed={collapsed} · saved {chars} chars',
  compactMicroOff: ' · micro-compact master switch is off (RAW_AGENT_MICRO_COMPACT=0)',
  compactGroupTitle: 'Context compact',
  compactGroupTip:
    'Only changes the tool_result view sent to the model; stored transcript stays intact. Use this to keep long tool results from filling the window.',


  loopTaskMode: 'Default task mode',
  loopSkillScope: 'Default skill scope',
  loopSkillScopeAria: 'Default skill scope',
  loopInboxCap: 'Inbox overflow cap',
  loopInboxCapTip:
    'Empty or 0 = never drop. A positive integer folds the oldest unclaimed inbox items into one system summary when over cap.',
  loopInboxUnlimited: 'Unlimited (default)',
  loopInboxCapInvalid: 'Inbox overflow cap must be a non-negative integer, or leave empty for unlimited',
  loopDefaultsGroup: 'New-session defaults',
  loopDefaultsGroupTip:
    'Default TaskMode / skill scope for new sessions, and whether to fold old inbox messages when they pile up. Saved settings take effect immediately.',
  loopKernelLabel: 'Turn kernel',
  loopKernelTip:
    'runSession defaults to @ppeng/agent-loop. "ppeng core" is the local reference kernel. Takes effect on the next run; no restart.',
  loopKernelAria: 'Turn kernel variant',
  loopKernelPpeng: 'ppeng core (reference)',
  loopKernelAgentLoop: 'agent-loop (default)',
  loopAssemblyLabel: 'Assembly preset',
  loopAssemblyTip:
    'agent-loop loads modules by tier. Product default is max (PTC / guardian / compensation). Takes effect on the next run; no restart.',
  loopAssemblyAria: 'agent-loop assembly preset',
  loopAssemblyMini: 'mini (portable kernel)',
  loopAssemblyNormal: 'normal (+ tool-loop)',
  loopAssemblyFull: 'full (+ EventLog / L4)',
  loopAssemblyMax: 'max (all modules)',
  taskModeAuto: 'Auto (all tools)',
  taskModeFast: 'Fast',
  taskModePlanner: 'Planner',
  taskModeTeams: 'Teams',
  taskModeDeepResearch: 'Deep research',
  taskModeBrowser: 'Browser',
  taskModeComputer: 'Computer',
  taskModeDynamicWorkflow: 'Dynamic workflow',
  skillScopeFull: 'All skills',
  skillScopeRequested: 'This turn only',









  modelProvidersTitle: 'Model providers',
  modelProvidersEnvFallback: ' .env fallback is still available.',
  scanFailed: 'Scan failed',
  scanned: 'Scanned {count} models; pick them in chat',
  deleted: 'Deleted',
  setDefaultMsg: 'Set as default: {model}',
  fillModelId: 'Enter a model ID',
  addedModel: 'Added {model}',
  fillUrlOrKey: 'Enter a new Base URL or API Key',
  collapseAdd: 'Collapse add',
  addProvider: 'Add provider',
  noProviders: 'No providers configured',
  noKey: 'No key',
  scannedAt: ' · scanned {at}',
  cancelEdit: 'Cancel edit',
  delete: 'Delete',
  fromEnv: 'From .env; checked state follows the env fallback.',
  builtin: 'Built-in',
  apiKeyKeep: 'Leave blank to keep',
  saveAndRediscover: 'Save and rediscover',
  addModelId: 'Add model ID',
  addModelPlaceholder: 'Type a model name, then add',
  add: 'Add',
  noModelsFound: 'No models discovered yet'
};
