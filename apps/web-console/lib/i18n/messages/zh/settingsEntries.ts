export const settingsEntries = {
  computerUse: {"title": "本机桌面操作（LCU）", "desc": "让 Agent 使用本机桌面应用。需要已安装 LCU 和 ChatGPT，应用授权由你决定。", "keywords": "LCU 桌面 电脑操作 截图 TextEdit", "enabled": "启用本机桌面操作", "hint": "关闭后不再暴露桌面工具。每个对话独立授权，同一桌面按回合排队；浏览器和音频未启用。"},
  appControl: {"title": "macOS 应用控制", "desc": "让 Agent 激活本机应用、向当前应用输入文字，或发送少量按键。仅 macOS。", "keywords": "macOS 应用控制 Apple Events 自动化 按键", "enabled": "启用 macOS 应用控制", "hint": "默认关闭。打开后只能激活应用、输入文字，或发送回车、Tab、Esc、方向键、拷贝和粘贴。每次动作仍需在 Lab 批准。首次使用时 macOS 可能弹出权限询问，这个开关不会预先授权。其它系统会提示不可用。"},
  common: {
    saved: '已保存，立即生效',
    save: '保存',
    undo: '撤销修改',
    unsaved: '有未保存的修改',
    restoreDefault: '恢复默认',
    restoreDefaultAria: '恢复默认：{name}',
    defaultValue: '默认：{value}',
    invalidRange: '请输入 {min}–{max} 之间的整数',
    loading: '正在加载设置…',
    loadFailed: '设置加载失败：{error}',
    retry: '重试',
    refresh: '刷新',
    on: '开',
    off: '关',
    none: '未设置',
    sourceUi: '已在界面保存',
    sourceDefault: '使用默认值',
    sourceEnv: '来自环境变量（尚未在界面保存）',
    effectiveNow: '当前生效：{value}',
    keepSecret: '已保存，留空则保持不变'
  },
  agentLoop: {
    title: '对话默认行为',
    keywords: '默认模式 任务模式 taskmode 技能范围 skill scope 插话 打断 中途发消息 工作中发消息 loop',
    desc: '新建对话时的默认做法，以及你在 Agent 还在工作时再发消息会怎样。改动保存后立即生效，无需重启。',
    fields: {
      taskMode: {
        label: '默认任务模式',
        hint: '新对话默认采用的工作方式；在对话输入框里仍可随时切换。'
      },
      skillScope: {
        label: '默认技能范围',
        hint: '新对话默认可以使用哪些技能。'
      },
      interrupt: {
        label: '工作中发来新消息',
        hint: 'Agent 还在处理上一条消息时，你又发了新消息，系统怎么处理。'
      }
    },
    options: {
      taskMode: {
        auto: { label: '自动', desc: '按需自动选择，可使用全部工具，适合大多数场景。' },
        fast: { label: '极速', desc: '少思考、快回复，适合简单问答。' },
        planner: { label: '规划', desc: '先列出计划再动手，适合步骤较多的任务。' },
        teams: { label: '团队', desc: '把任务拆给多个 Agent 协作完成。' },
        deep_research: { label: '深度研究', desc: '多来源检索并整理结论，耗时更长。' },
        browser: { label: '浏览器', desc: '以浏览网页、操作页面为主。' },
        computer: { label: '电脑操作', desc: '以操作命令行与桌面为主。' },
        dynamic_workflow: { label: '动态工作流', desc: '自动编排并执行多个步骤。' }
      },
      skillScope: {
        full: { label: '全部技能', desc: '每轮都可使用所有已启用的技能。' },
        requested: { label: '仅本轮勾选', desc: '只使用你在输入框里为这一轮勾选的技能，更省上下文。' }
      },
      interrupt: {
        queue: { label: '排队等待', desc: '等当前这一步做完再处理新消息，最稳妥。' },
        steer: { label: '立即转向', desc: '下一步马上按新消息调整方向；已发出的模型请求不会被取消。' },
        disabled: { label: '不接收', desc: 'Agent 工作期间忽略新消息，跑完才能再发。' }
      }
    }
  },
  agentLoopEngine: {
    title: 'Agent 运行引擎',
    keywords: '内核 kernel 组装 档位 assembly drain 工具发射 消息堆积 inbox overflow 上限 底层 调度',
    desc: '底层调度参数，普通使用无需改动；改错可能让插话与工具执行的行为变得难以预期。',
    fields: {
      drain: {
        label: '插话时跳过未启动的工具',
        hint: '开启后，你中途插话时尚未开始执行的顺序工具会被跳过，让模型更快看到新消息；已在运行的工具不受影响。'
      },
      kernel: {
        label: '循环内核',
        hint: '决定每一轮如何调度模型与工具。ppeng core 仅用于对照排查问题。'
      },
      assembly: {
        label: '功能档位',
        hint: '内核装配的功能范围，档位越高能力越全、开销越大。',
        ppengDisabled: '使用 ppeng core 内核时此项不生效。'
      },
      inboxCap: {
        label: '消息堆积上限',
        hint: '未处理的消息超过该数量时，把最旧的几条压成一条摘要，避免撑爆上下文。留空或 0 表示不限制。',
        placeholder: '不限制'
      }
    },
    options: {
      kernel: {
        'agent-loop': 'agent-loop（推荐）',
        ppeng: 'ppeng core（对照）'
      },
      assembly: {
        mini: 'mini · 精简',
        normal: 'normal · 标准',
        full: 'full · 完整',
        max: 'max · 全量'
      }
    },
    defaults: {
      kernel: 'agent-loop（推荐）',
      assembly: 'max · 全量',
      inboxCap: '不限制'
    }
  },
  compact: {
    title: '上下文压缩',
    keywords: '压缩 上下文太长 窗口太满 超长 省 token 费用 成本 工具结果 折叠 占位 compact micro',
    desc: '长对话里，模型已经读过的工具输出会被折叠成一行占位，节省上下文窗口；完整原文始终保留在会话记录中。',
    fields: {
      policy: {
        label: '何时折叠已读的工具输出',
        hint: '折叠只影响送给模型的内容，不会删除记录。'
      },
      keepRecent: {
        label: '保留最近几条完整输出',
        hint: '「保留最近几条」策略下，最近这些工具输出保持完整，更早的长输出被折叠。'
      }
    },
    options: {
      policy: {
        keep_recent: { label: '保留最近几条', desc: '默认做法：只折叠较早的长工具输出，最近几条完整保留。' },
        after_text_assistant: { label: '助手写出正文后折叠', desc: '等助手给出正文回复后再折叠，连续调用工具期间仍保留原文。' },
        after_any_assistant: { label: '下一轮立即折叠', desc: '助手一回复就折叠上一轮的工具输出，最省上下文。' }
      }
    },
    globalOff: '压缩功能当前被系统整体关闭，下面的设置暂不生效。'
  },
  goal: {
    title: '目标（Goal）',
    keywords: '目标 goal 完成判定 门禁 做完了没 自动继续 最大轮数 尝试次数',
    desc: '让 Agent 带着明确的完成条件工作，由系统判断「做完了没」，没做完会继续尝试。',
    fields: {
      enabled: {
        label: '启用目标功能',
        hint: '关闭后，会话里设置的完成条件不再生效。'
      },
      maxTurns: {
        label: '默认最多尝试轮数',
        hint: '一个目标自动继续这么多轮仍未完成就停下，防止无限消耗。'
      }
    }
  },
  goalVerify: {
    title: '目标：自动校验方式',
    keywords: '校验 验证 verify http 请求 网址 网络访问 goal',
    desc: '目标可以让系统自己去验证结果是否达成，这里控制允许使用哪些验证手段。',
    fields: {
      http: {
        label: '允许通过 HTTP 请求校验',
        hint: '开启后 Agent 可访问你指定的网址来判断目标是否达成，会产生对外网络请求。'
      }
    }
  },
  sandbox: {
    title: '命令沙箱',
    keywords: '沙箱 sandbox bash 隔离 安全 无隔离 direct bwrap seatbelt 容器 命令执行 权限 密钥保护',
    desc: '决定 Agent 执行命令时用什么方式与你的电脑隔离，避免误读密钥或破坏文件。保存后立即生效。',
    fields: {
      mode: {
        label: '隔离方式',
        hint: '推荐保持「自动」；仅在需要排查问题或使用远程沙箱时再改。'
      }
    },
    options: {
      mode: {
        auto: { label: '自动', desc: '推荐。按本机能力自动选择最强的隔离；不支持系统隔离时仅做环境变量脱敏。' },
        os: { label: '系统级隔离', desc: 'macOS 使用 seatbelt、Linux 使用 bwrap，禁止命令读取 ~/.ssh 等密钥目录。' },
        direct: { label: '直接执行（无隔离）', desc: '只做环境变量脱敏，命令拥有与本服务相同的权限。' },
        container: { label: '容器', desc: '本机暂未实现，实际会按「直接执行」运行。' },
        'cloudflare-computer': { label: 'Cloudflare 远程沙箱', desc: '命令发送到你配置的 Cloudflare Computer 执行，需在「沙箱 · Cloudflare 连接」里填写连接信息。' }
      }
    },
    risk: {
      direct: '「直接执行」没有任何系统隔离（无隔离）：命令可以读写本服务能访问的所有文件，包括密钥目录。只应在受信任的环境使用。',
      container: '容器模式在本机尚未实现，实际按「直接执行」运行，同样没有系统隔离（无隔离）。'
    }
  },
  sandboxCloudflare: {
    title: '沙箱 · Cloudflare 连接',
    keywords: 'cloudflare 远程沙箱 endpoint 令牌 token workspace 工作区 账号 account 超时 密钥库',
    desc: '只有把隔离方式设为「Cloudflare 远程沙箱」时才会用到。令牌不保存在这里，请放进密钥库。',
    fields: {
      endpoint: { label: '服务地址', hint: 'Cloudflare Computer 部署后的访问地址。' },
      workspace: { label: '工作区名称', hint: '远程沙箱里使用的工作区，只能含字母、数字、点、下划线和连字符。' },
      account: { label: '账号 ID', hint: '可选，Cloudflare 账号 ID。' },
      timeout: { label: '单次命令超时（毫秒）', hint: '命令超过该时间会被终止。' },
      backend: { label: '执行后端', hint: '不指定时由远程服务自行选择。' },
      tokenName: { label: '令牌的密钥名', hint: '访问令牌在密钥库中的名称，留空则使用默认名称。' }
    },
    options: {
      backend: {
        none: '不指定',
        'worker-shell': 'worker-shell',
        'container-shell': 'container-shell'
      }
    },
    token: {
      found: '令牌已就绪（来源：{source}）。',
      missing: '尚未找到令牌：请通过密钥库保存（PUT /api/secrets/{name}），或设置同名环境变量。'
    }
  },
  skills: {
    title: '技能加载方式',
    keywords: '技能 skill 路由 披露 load_skill 提示词 清单 shortlist lazy full 上下文',
    desc: '技能很多时，决定每轮把多少技能的名称与简介放进提示词；技能正文始终按需加载。',
    fields: {
      disclosure: {
        label: '技能清单怎么给模型看',
        hint: '影响上下文占用与技能被发现的概率。'
      }
    },
    options: {
      disclosure: {
        shortlist: { label: '按相关度挑选', desc: '默认。每轮只列出与你的消息最相关的几个技能；需要别的技能时 Agent 会自己搜索。' },
        lazy: { label: '按需搜索', desc: '不列清单，Agent 需要时先搜索再加载。最省上下文，但可能漏用技能。' },
        full: { label: '全部列出', desc: '列出所有技能的名称与简介。最全，但最占上下文。' }
      }
    }
  },
  dynTools: {
    title: '动态工具',
    keywords: '动态工具 dynamic tools 可选工具组 optional 自定义工具 保存工具 复用 提升 实验',
    desc: '允许 Agent 在对话中创建、保存并复用自己的小工具。实验性功能，默认关闭。',
    fields: {
      enabled: { label: '启用动态工具', hint: '关闭时下面的选项都不生效。' },
      allowSave: { label: '允许保存为可复用工具', hint: 'Agent 可以把临时写的工具保存下来，之后的对话还能用。' },
      allowPropose: { label: '允许提出新工具建议', hint: 'Agent 发现重复操作时，可以提议把它做成工具。' },
      allowPromote: { label: '允许提升为项目级工具', hint: '提升后项目里所有会话都能使用该工具，改动影响范围更大。' },
      hydrateTopK: { label: '每轮预载工具数', hint: '每轮最多把多少个最相关的动态工具提前交给模型。' },
      unusedTurns: { label: '多少轮未使用后建议退役', hint: '长期没被用到的工具会被建议清理。' }
    },
    tuning: {
      title: '调优参数',
      desc: '一般无需修改。'
    },
    session: {
      title: '当前会话的动态工具',
      desc: '查看并管理当前选中会话里的动态工具。',
      noSession: '先在「对话」里选中一个会话，这里才会列出它的动态工具。',
      empty: '这个会话还没有动态工具。',
      status: '状态：{status} · 范围：{scope}',
      retire: '退役',
      promoteLong: '提升到长期',
      promoteProject: '提升到项目',
      promotePending: '已提交提升申请，等待审批。'
    }
  },
  discovery: {
    title: '能力发现',
    keywords: '发现 discovery 探查 白名单 tailscale 主动扫描 局域网 网络扫描 端口 设备',
    desc: '让 Agent 发现网络里可用的外部能力（例如 Tailscale 设备上的服务）。默认全部关闭。',
    fields: {
      enabled: { label: '启用能力发现', hint: '总开关；关闭时其余选项都不生效。' },
      tailscale: { label: '读取 Tailscale 设备列表', hint: '从本机 Tailscale 获取设备，用于发现可用服务。' },
      activeScan: { label: '允许主动扫描', hint: '主动向白名单内的主机和端口发探测请求。' },
      hosts: { label: '允许探查的主机', hint: '用逗号分隔，如 api.example.com。' },
      cidrs: { label: '允许探查的网段', hint: '用逗号分隔，如 100.64.0.0/10, 10.0.0.0/8。' }
    },
    allowlist: {
      title: '探查白名单',
      desc: '探查只会针对这里列出的主机与网段。'
    },
    risk: {
      activeScan: '主动扫描会向网络里的主机和端口发送探测请求，可能触发安全告警，只应在你有权扫描的网络中开启。'
    },
    probe: '立即探测 Tailscale',
    probeDone: '探测完成：发现 {count} 个，来源 {source}'
  },
  connectors: {
    title: '连接器授权',
    keywords: '连接器 connector 授权 grant 插件 领域 密钥',
    desc: '每个连接器单独授权后，使用说明才会交给模型。这里只显示名称和是否已授权。',
    empty: '当前没有可授权的连接器。',
    granted: '已授权',
    notGranted: '未授权',
    loadFailed: '无法读取连接器'
  },
  langfuse: {
    title: 'Langfuse 追踪',
    keywords: '追踪 trace langfuse 可观测 observability 监控 日志 调用链 用量 费用 排查',
    desc: '把每次对话的调用链上报到 Langfuse，方便回看与排查。密钥只写入、不会回显。',
    fields: {
      baseUrl: { label: '服务地址', hint: 'Langfuse 的访问地址，例如 https://cloud.langfuse.com。', placeholder: 'https://cloud.langfuse.com' },
      publicKey: { label: 'Public Key', hint: '在 Langfuse 项目设置里创建。' },
      secretKey: { label: 'Secret Key', hint: '只写入、不回显。' },
      enabled: { label: '启用追踪上报', hint: '开启后新的对话会开始上报；连接信息填好并保存后才会生效。' }
    },
    probe: '测试连接',
    probeOk: '连接成功。',
    probeFail: '连接失败，请检查地址与密钥。',
    configured: '已配置连接信息。',
    unconfigured: '尚未配置连接信息。'
  },
  jev: {
    title: 'Jev 评估',
    keywords: '评估 eval jev 判官 第二意见 目标门 工具闸 切入点 审查 评审模型',
    desc: '接入独立的评估模型（Jev），在关键环节（判断目标是否完成、审查危险命令等）给出第二意见。',
    connection: {
      title: '连接',
      desc: '先填好并保存评估模型的连接信息，才能选择启用哪些环节。'
    },
    fields: {
      baseUrl: { label: '服务地址', hint: '评估模型的接口地址。', placeholder: 'https://jev.example.com/v1' },
      apiKey: { label: 'API Key', hint: '只写入、不回显。', placeholder: '输入 API Key' },
      model: { label: '模型名称', hint: '评估时使用的模型。' },
      profile: { label: '启用哪些环节', hint: '按档位一键选择；选「自选」可逐项开关。' }
    },
    probe: '测试连接',
    probeOk: '连接成功。',
    probeFail: '连接失败，请检查地址与密钥。',
    configured: '连接信息已保存，可以选择启用的环节。',
    unconfigured: '尚未配置连接信息。',
    needsEntry: '保存连接信息后才能选择启用的环节。',
    stages: {
      title: '启用的环节',
      desc: '决定评估模型会参与哪些决策。',
      custom: '勾选要参与的环节：',
      preset: '该档位包含的环节（只读，想逐项调整请选「自选」）：',
      empty: '该档位不插入任何环节。',
      active: '当前生效：{points}'
    },
    options: {
      profile: {
        off: '关闭',
        mini: '精简（不插入）',
        normal: '标准（仅目标门）',
        full: '完整（目标门 + 工具闸）',
        max: '全量（目标门 + 工具闸 + 压缩 + 路由）',
        custom: '自选'
      },
      points: {
        goalGate: '目标门：判断目标是否完成',
        toolGate: '工具闸：审查命令与外部 CLI',
        compact: '压缩：截断过长且成功的工具输出',
        route: '路由：判断还要工具、已完成还是重试',
        contextSelect: '上下文筛选：压缩前挑选早期片段',
        toolSelect: '工具筛选：在允许范围内缩短工具名单',
        skillSelect: '技能筛选：在候选技能里再过滤',
        sagaGate: 'Saga 门：仅提供辅助，勾选后主循环不会询问',
        memorySelect: '记忆筛选：注入前按相关性过滤',
        recoveryChoice: '恢复选择：在恢复动作中挑选',
        preTurn: '回合前判断：目标已达成时跳过本轮',
        ptcDecide: 'PTC 决策：脚本里的语义分支'
      }
    }
  },
  eventLog: {
    title: '事件日志（EventLog / Saga）',
    keywords: '事件日志 saga eventlog 审计 记录 回放 轨迹 追溯 audit',
    desc: '记录每个会话里发生的关键事件，便于审计、排查和回放。',
    fields: {
      enabled: {
        label: '记录会话事件日志',
        hint: '关闭后，新的事件不再写入日志，已有记录保留。'
      }
    }
  }
};
