export const settings = {
  debugDisplay: {
  "title": "调试信息",
  "keywords": "调试 目标 进展 Trace 内部机制",
  "description": "默认关闭。开启后，所有会话展示目标状态、目标历史、目标与进展、停止原因和 Trace 入口。保存后立即生效，并随当前账号同步。",
  "enable": "显示内部调试信息",
  "saveFailed": "保存失败，请重试。"
},
  fontSize: {
    title: '字体大小', keywords: '字体 字号 外观 大小 font size text appearance',
    description: '调整整个控制台的文字大小，立即生效并同步到当前用户的其他浏览器。',
    option: '{size}px', defaultOption: '{size}px（默认）', reset: '恢复默认',
    preview: '清晰阅读，舒适交流。Aa — Reading comfortably · 0123456789',
    saveFailed: '无法保存字号；本次调整已生效，重新打开页面后可能恢复默认。'
  },

  categories: {
    general: '通用',
    models: '模型',
    behavior: 'Agent 行为',
    safety: '安全与沙箱',
    tools: '工具与技能',
    integrations: '集成与可观测',
    experimental: '实验特性',
    ops: '运维'
  },
  categoriesLabel: '设置分类',
  experimentalSwitch: '启用{name}',
  searchPlaceholder: '搜索设置（如：模型、API Key、飞书、主题）',
  searchCount: '找到 {count} 项设置',
  searchClear: '清除搜索',
  noResultsTitle: '没有匹配的设置',
  noResultsDesc: '没有找到与「{query}」相关的设置，试试其他关键词。',
  emptyCategoryTitle: '这里暂时没有常用设置',
  emptyCategoryDesc: '打开右上角「显示高级」查看更多选项。',
  entries: {
    language: { title: '语言', keywords: '界面语言 language locale 中文 English' },
    theme: { title: '主题', keywords: '外观 theme dark light 深色 浅色 暗色 夜间 跟随系统' },
    sessionBrief: { title: '会话显示', keywords: '简化 关键信息 会话 折叠 工具 过程 太长 解读 brief' },
    modelProviders: {
      title: '模型服务商',
      keywords: 'API Key 密钥 Base URL 模型 provider openai anthropic deepseek ollama 向导 测试连接 默认模型'
    },
    modelFallback: { title: '模型回退', keywords: '备用模型 fallback 重试 降级' },
    gateway: {
      title: '网关与 IM 接入',
      keywords: '飞书 feishu lark 企业微信 wecom 网关 gateway IM webhook token secret encrypt 白名单 allowlist 发送者 botId 签名'
    },
    roomCapacity: {
      title: '群规模',
      keywords: '群 成员 名册 上限 每轮发言 room roster capacity'
    }
  },
  saveState: {
    dirty: '有未保存的修改',
    saving: '正在保存…',
    saved: '已保存，立即生效',
    failed: '保存失败，请重试'
  },
  onboarding: {
    title: '还没有配置真实模型',
    descDemo: '目前使用的是内置演示模型（本地启发式），回复只用于体验界面。配置一个模型服务商后即可获得真实回复，只需 API Key，约一分钟。',
    descNone: '还没有任何可用的模型。配置一个模型服务商后才能开始对话，只需 API Key，约一分钟。',
    cta: '去配置模型',
    dismiss: '稍后再说'
  },
  theme: {
    desc: '选择界面配色；「跟随系统」会随操作系统的深浅色自动切换。',
    light: '浅色',
    dark: '深色',
    system: '跟随系统'
  },
  sessionBrief: {
    title: '会话显示',
    description: '默认只看关键信息：你说的话、助手的回答、图片、目标进展，以及还没处理的确认。工具过程、推理、系统流水和统计收成一行。关掉后才展开全文。不改对话记录，也不改模型看到的内容。'
  },
  skin: {
    label: '外观',
    desc: '可随时切换，不改变深色、浅色或跟随系统。',
    classic: '经典',
    sanctum: '圣所',
    cyberpunk: '赛博朋克',
    demon: '恶魔的聚会',
    'robot-stage': '机器人大舞台',
    pixel: '像素',
    kindergarten: '童趣幼儿园',
    minimal: '极简黑白'
  },
  model: {
    globalDefault: {
      title: '全局默认模型',
      description: '未单独指定模型的 Bot、群聊成员和普通对话跟随此默认值，保存后立即生效。Bot 专属模型或对话单独选择优先；清除单独选择后恢复跟随全局。',
      empty: '尚未配置可用模型',
      configure: '配置模型',
      saved: '全局默认模型已保存为 {model}',
      saveFailed: '保存全局默认模型失败，模型可能已禁用或删除。当前配置未更改，请刷新列表后重试。',
      follow: '跟随全局默认',
      following: '全局默认 · {provider}'
    },
    desc: '选择服务商、填入 API Key、测试连接，选好默认模型即可使用。保存后立即生效，无需改 .env 或重启。',
    wizardTitle: '添加模型服务商',
    stepProvider: '选择服务商',
    stepKey: '填写 API Key',
    stepTest: '测试连接',
    stepSave: '选择默认模型',
    providerGroup: '服务商',
    customProvider: '自定义',
    presetSiliconflow: '硅基流动',
    apiKey: 'API Key',
    apiKeyPlaceholder: '粘贴你的 API Key',
    apiKeyHint: 'Key 只保存在本机 daemon，之后只显示脱敏结果，不会再回显。本地服务（如 Ollama）可保持默认占位值。',
    showKey: '显示',
    hideKey: '隐藏',
    needKey: '请先填写 API Key',
    test: '测试连接',
    testing: '正在测试…',
    testOk: '连接成功，发现 {count} 个模型',
    testOkNoModels: '连接成功，但没有发现模型。请在「高级选项」里手动填写模型 ID。',
    defaultModel: '默认模型',
    saveAndUse: '保存并使用 {name}',
    saveDisabled: '保存并使用',
    savedUse: '已保存，{name} 已设为默认模型',
    addAnother: '再添加一个',
    done: '完成',
    advanced: '高级选项',
    advancedHide: '收起高级选项',
    name: '服务商名称',
    namePlaceholder: '留空则自动命名',
    manualModel: '手动指定模型 ID',
    manualModelPlaceholder: '如 gpt-4o-mini（填写后优先使用）',
    enabledModels: '在对话中可选的模型',
    enabledModelsHint: '勾选的模型会出现在对话的模型选择器里；默认模型始终启用。',
    errors: {
      missingKey: '请先填写 API Key。',
      missingUrl: '请先填写 Base URL。',
      auth: 'API Key 无效或没有权限，请检查后重试。',
      notFound: '找不到模型列表接口，请检查 Base URL 是否正确（通常以 /v1 结尾）。',
      rateLimit: '服务商限流了，请稍后再试。',
      server: '服务商暂时不可用，请稍后重试。',
      network: '连不上服务商，请检查 Base URL 与网络。',
      unknown: '连接失败：{detail}'
    },
    list: {
      loadFailed: '无法读取模型配置，请确认 daemon 正在运行后刷新页面。',
      current: '当前默认模型',
      noDefault: '尚未设置默认模型',
      changeKey: '更换 Key',
      keyUpdated: 'Key 已更新并重新检测，发现 {count} 个模型',
      manageModels: '管理模型',
      confirmDelete: '确认删除',
      retest: '重新检测',
      makeDefault: '设为默认',
      defaultBadge: '默认',
      modelCount: '{count} 个可用模型',
      status: {
        ok: '可用',
        error: '检测失败',
        unchecked: '未检测',
        builtin: '内置'
      }
    }
  },
  gateway: {
    title: '网关与 IM 接入',
    desc: '飞书 / 企业微信入站消息的校验与访问控制。保存后立即生效，无需改 .env 或重启；已保存的密钥只显示「已设置」，不会回显。',
    unavailable: '当前 daemon 还不支持网关设置接口（需要升级到包含网关安全修复的版本）。',
    secretSet: '已设置',
    secretUnset: '未设置',
    secretKeep: '已设置，留空表示保持不变',
    secretPlaceholder: '粘贴后保存',
    willClear: '保存后清除',
    clear: '清除',
    undoClear: '撤销清除',
    clearNamed: '清除{name}',
    sendersPlaceholder: '每行一个 ID，也可用逗号分隔；留空表示不限制',
    sendersHint: '支持 open_id / user_id / union_id / chat_id。',
    botNone: '不绑定（使用默认路由）',
    botHint: '绑定后，该渠道的消息会进入这个 Bot 的固定会话。',
    save: '保存网关设置',
    feishu: {
      title: '飞书',
      desc: '事件订阅的校验 Token、加密 Key，以及允许发消息的发送者。',
      verificationToken: '飞书 Verification Token',
      encryptKey: '飞书 Encrypt Key',
      allowedSenders: '飞书发送者白名单',
      botId: '飞书绑定 Bot'
    },
    wecom: {
      title: '企业微信',
      desc: '桥接服务的共享密钥，以及允许发消息的发送者。',
      bridgeSecret: '企业微信桥接 Secret',
      allowedSenders: '企业微信发送者白名单',
      botId: '企业微信绑定 Bot'
    },
    webhook: {
      title: '通用 Webhook',
      desc: '限制哪些发送者可以通过通用 Webhook 入站。',
      allowedSenders: 'Webhook 发送者白名单'
    }
  },
  roomCapacity: {
    description: '名册、单群人数和每轮发言人数保存在这里，保存后立即生效。',
    rosterCap: '名册上限',
    maxRoomMembers: '单群人数上限',
    maxWaveSpeakers: '每轮发言人数',
    save: '保存',
    saved: '已保存',
    saveFailed: '无法保存群规模设置'
  }
};
