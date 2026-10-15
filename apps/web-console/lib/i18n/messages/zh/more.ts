export const more = {
  help: '帮助',
  savedNoRestart: '已保存，立即生效（无需改 .env / 重启）',
  sourceUi: '界面配置',
  sourceDefault: '默认',
  on: '开',
  off: '关',
  effectivePrefix: '生效: ',


  compactCollapseLabel: '消费后占位',
  compactCollapseTip: '模型已看过的 tool_result 换成一行占位，省窗口。SQLite 仍是全文。',
  compactPolicyAria: '工具结果压缩策略',
  compactPolicyKeepRecent: '关（默认，保留最近 N 条）',
  compactPolicyAfterText: '开 · 等正文后再抽',
  compactPolicyAfterAny: '开 · 下一轮助手即抽',
  compactKeepRecent: '默认策略保留条数',
  compactKeepRecentInvalid: '保留条数须为 0–50 的整数',
  compactSessionStats: '本会话 collapsed={collapsed} · 省 {chars} 字',
  compactMicroOff: ' · 微压缩总开关已关（RAW_AGENT_MICRO_COMPACT=0）',
  compactGroupTitle: '上下文压缩',
  compactGroupTip: '只改送给模型的 tool_result 视图，落库原文不变。用来控制长工具结果占窗口。',


  loopTaskMode: '默认任务模式',
  loopSkillScope: '默认技能域',
  loopSkillScopeAria: '默认技能域',
  loopInboxCap: 'Inbox overflow 上限',
  loopInboxCapTip: '留空或 0=不丢。填正整数后，未认领 inbox 超限会把最旧的合成一条 system 摘要。',
  loopInboxUnlimited: '无限（默认）',
  loopInboxCapInvalid: 'inbox overflow 上限须为非负整数，或留空表示无限',
  loopDefaultsGroup: '新会话默认',
  loopDefaultsGroupTip: '新建会话的 TaskMode / 技能域默认值，以及 inbox 堆积超限时是否折叠旧消息。保存后立即生效。',
  loopKernelLabel: 'Turn kernel',
  loopKernelTip:
    'runSession 默认走 @ppeng/agent-loop。「ppeng core」是本地对照内核。下一轮 run 生效，无需重启。',
  loopKernelAria: 'Turn kernel 变体',
  loopKernelPpeng: 'ppeng core（对照）',
  loopKernelAgentLoop: 'agent-loop（默认）',
  loopAssemblyLabel: '组装档位',
  loopAssemblyTip:
    'agent-loop 按档加载模块。产品默认 max（含 PTC / guardian / 补偿编排）。下一轮 run 生效，无需重启。',
  loopAssemblyAria: 'agent-loop 组装档位',
  loopAssemblyMini: 'mini（可移植内核）',
  loopAssemblyNormal: 'normal（+ tool-loop）',
  loopAssemblyFull: 'full（+ EventLog / L4）',
  loopAssemblyMax: 'max（全量）',
  taskModeAuto: '自动（全工具）',
  taskModeFast: '极速',
  taskModePlanner: '规划',
  taskModeTeams: '团队',
  taskModeDeepResearch: '深度研究',
  taskModeBrowser: '浏览器',
  taskModeComputer: '电脑操作',
  taskModeDynamicWorkflow: '动态工作流',
  skillScopeFull: '全部技能',
  skillScopeRequested: '仅本轮勾选',









  modelProvidersTitle: '模型服务商',
  modelProvidersEnvFallback: ' 当前仍可用 .env 回退。',
  scanFailed: '扫描失败',
  scanned: '已扫描 {count} 个模型，可在对话区选择',
  deleted: '已删除',
  setDefaultMsg: '已设为默认：{model}',
  fillModelId: '请填写模型 ID',
  addedModel: '已加入 {model}',
  fillUrlOrKey: '请填写新的 Base URL 或 API Key',
  collapseAdd: '收起新增',
  addProvider: '新增服务商',
  noProviders: '暂无配置的服务商',
  noKey: '无密钥',
  scannedAt: ' · 扫描于 {at}',
  cancelEdit: '取消编辑',
  delete: '删除',
  fromEnv: '来自 .env，勾选状态随环境回退。',
  builtin: '内置',
  apiKeyKeep: '留空则不改',
  saveAndRediscover: '保存并重新发现',
  addModelId: '添加模型 ID',
  addModelPlaceholder: '手填模型名后添加',
  add: '添加',
  noModelsFound: '尚未发现模型'
};
