# Web Console 重构方案（ui-redesign）

分支基线：`ui-redesign-base`（架构师已推送）。所有 worker 从该分支切分支开发，PR 目标 = `ui-redesign-base`（或其合并后的 `main`）。

## 1. 现状审计（问题）

- `AgentLabApp.tsx`(650 行)：数据加载、会话选择、Play 表面切换、抽屉工作台、顶栏控件全部堆在一个组件，prop 层层下钻。
- 导航：Chat（常驻 `PlayPanel`，1640 行）+ 右侧「工作台」抽屉（4 个 tab：功能 / 会话轨迹 / Teams / 更多）。「功能」里又有 5 项二级菜单，「更多」是一页 20+ 张卡片的长滚动（模型、Goal、Jev、Langfuse、Discovery、DynTools、Ingestion、Sandbox、AgentLoop、EventLog、Compact、Skill、SkillProposals、Orchestration、Memory、邮件、审批、Jobs、Workspaces…）。
- 配置：全部配置同级平铺、无分类、无搜索、无「简单/高级」之分；同一能力散落多处（模型：对话输入框 / 弹窗 / 更多页 / Fallback 卡；Skill：功能 / 更多 ×2；Memory：功能 / 更多；审批：对话 banner / 更多）。
- 交互：Bot 与 Chat 是 PlayPanel 里一个「表面」开关；顶栏控件（刷新 / 调度 / 自动刷新 / 配置模型）混在抽屉头；Teams 与 Swarm/Orchestration 分处两个 tab。
- 样式：`legacy-vanilla/styles.css`(3700 行) + `globals.css`(1600 行)，无统一间距/排版 token，卡片到处自带样式。

## 2. 新信息架构（一级导航，左侧 Rail）

| id | 名称 | 内容（原位置 → 新位置） |
|---|---|---|
| `chat` | 对话 | PlayPanel（会话列表 + 对话 + Bot 表面）。常驻挂载（保持流式状态），其他页时隐藏 |
| `agents` | Bots 与 Agents | 子页：`agents`（Agent 列表）· `bots`（Bot 管理/策略/Cron，现在散在 PlayPanel）· `teams`（TeamGraph/DAG/邮件/Swarm）· `skills`（技能列表 + 技能提案） |
| `tasks` | 任务 | 子页：`queue`（任务队列/定时发布/后台任务）· `runs`（Orchestration/Swarm 运行）· `inbox`（审批、邮件撰写、Workspaces） |
| `knowledge` | 知识与记忆 | 子页：`memory`（MemoryPanel）· `ingestion`（附件与浏览器/摄取） |
| `ops` | 运维 | 子页：`trajectory`（会话轨迹/Trace）· `health`（系统状态、自愈/Evolution、有效配置 EffectiveConfig） |
| `settings` | 设置 | 分类左栏 + 全局搜索 + 「显示高级」开关（只收起卡片内分组，如网关 Webhook、知识库高级项）。分类：`general` 通用（语言/主题）· `models` 模型 · `behavior` Agent 行为 · `safety` 安全与沙箱 · `tools` 工具与技能 · `integrations` 集成与可观测 · `experimental` 实验特性（原整项 advanced：模型回退、压缩、目标校验、循环内核、Cloudflare 沙箱、动态工具、能力发现、Langfuse、Jev） |

路由：URL hash `#/<section>[/<sub>]`（`lib/nav.ts`，纯函数、有单测）。不新增 Next 路由，保证 Chat 状态不被卸载。

## 3. 配置渐进披露

1. 默认只显示「必须配置」：模型服务商（首次引导）、语言/主题。其余有合理默认值。
2. 每个设置条目在注册表（`components/sections/settings/categories/*.tsx`）里声明 `{id, category, titleKey, keywordsKey?, advanced?, render}`。
3. 设置页：分类导航 + 搜索（匹配标题/关键词，命中高级项自动展开）+ 「高级」开关（`localStorage['lab.settings.advanced']`，`AdvancedToggle`/`useAdvancedMode`）。
4. 每个 worker 在自己的分类文件里：合并冗余卡片、将不常用项放进 `SettingsGroup advanced`、每个控件写一句说明（i18n）。
5. 禁止新增 `RAW_AGENT_*` 开关；持久化走既有 daemon settings API。
6. 去重：模型入口统一到 设置→模型（对话里仅保留「选择模型」与「管理」链接 → `openSection('settings','models')`）。

## 4. 设计 token 与布局壳

- `styles/tokens.css`：在既有语义色之上增加 `--ui-space-*`（4px 栅格）、`--ui-radius-*`、`--ui-text-*`、`--ui-shadow-*`、`--ui-rail-width`、`--ui-content-max`、`--ui-z-*`。组件优先使用 `--ui-*`，不要新增写死 px/颜色。
- `styles/shell.css`：Rail + 内容区网格；`styles/primitives.css`：Section/SettingsGroup/EmptyState/SubTabs 等。
- 共享原语（`components/ui/`）：`Section`（页头：标题、描述、操作区）、`SubTabs`、`SettingsGroup`（标题/说明/可折叠/advanced）、`AdvancedToggle` + `useAdvancedMode`、`EmptyState`。
- 壳：`components/shell/`：`LabProvider`（共享数据/刷新/选择会话/导航，`useLab()`）、`LabShell`（Rail + 内容区 + 各 Section 挂载）、`Rail`、`ShellToolbar`。

## 5. i18n 命名空间所有权（避免 index.ts 冲突）

foundation 已在 `messages/{zh,en}/index.ts` 注册全部新命名空间，worker 只改自己的文件，**不要再改 index.ts**：

`shell`(架构师) · `settings`(WS5，含 `settings.entries.{language,modelProviders,modelFallback}`) · `settingsEntries`(WS6，其余设置条目标题/关键词) · `agents`(WS2) · `tasks`(WS3) · `knowledge`(WS3) · 既有：`play`(WS1) · `teams`(WS2) · `ops`(WS4) · `memory`(WS3) · `more`/`nav`/`common`（只增不删；旧 key 仅在无引用后由所属 worker 清理）。

## 6. 并行工作流（互不重叠的文件所有权）

每个 worker 仅编辑自己拥有的路径；共享文件（`lib/types.ts`、`LabProvider`、`ui/*`、`styles/*`、i18n index、`lib/nav.ts`）发现需要改时：只做**追加式**最小改动并在 PR 描述说明，或向架构师反馈。每个 worker 自带 `acceptance/<id>.yaml`（draft→approved，用户已授权直接开工）+ 带 `[AC:..]` 标签的测试 + 更新相关 e2e。

- **WS1 Chat**：`components/sections/chat/**`、`PlayPanel.tsx`、`ChatTurns.tsx`、`usePlayChat.ts`、`ComposerModelPicker.tsx`、`QueryQueue.tsx`、`WorkspacePicker.tsx`、`TaskModePicker.tsx`、`ApprovalBanner.tsx`、`StoredToolResultExpand.tsx`、`SpawnBlockedNotice.tsx`、`ArtifactRail.tsx`、`ActivityPanel.tsx`；`lib/{chat-utils,stream-segments,tool-io,send-ack-feedback,session-*,query-queue,workspace-binding,speech-dictation,spawn-blocked}.*`；i18n `play`；e2e `chat-basics`/`spawn-blocked`/`lab-model-view`/`a2ui`。目标：精简顶部与 composer（把配置折叠进一个「会话设置」面板），移除对话里重复的设置入口，Bot 创建引导走 Agents→bots。
- **WS2 Bots & Agents & Teams & Skills**：`components/sections/agents/**`、`Bot*.tsx`（BotCronPanel/BotModelSetting/BotPolicy*）、`TeamsPanel/TeamGraph/TeamsDagPanel/SwarmPanel.tsx`、`SkillProposalsCard.tsx`、`lib/{bots,bot-*,team-graph,cron,skill-proposal-remind}.*`；i18n `agents`、`teams`、`skillProposals`；e2e `bot-*`/`skill-proposals`/`swarm-api`。目标：Agent 卡片可操作（详情/可用工具），Bot 管理从 PlayPanel 抽到本页（与 WS1 约定 `openSection('agents','bots')` 入口），Teams 与 Swarm 合并为一个视图。
- **WS3 Tasks + Knowledge**：`components/sections/tasks/**`、`components/sections/knowledge/**`、`OrchestrationPanel.tsx`、`MemoryPanel.tsx`、`IngestionSettingsCard.tsx`；i18n `tasks`、`knowledge`、`memory`。目标：任务队列状态过滤/详情，审批收件箱，记忆分层浏览与搜索，摄取配置默认折叠。
- **WS4 Ops**：`components/sections/ops/**`、`OpsPanel/TracePanel/TraceTurnList/TrajectoryPanel.tsx`、`GlobalStatusBar.tsx`、`SelfHealBanner.tsx`、`EffectiveConfigCard.tsx`、`ShellToolbar.tsx`（刷新/自动刷新/调度）、`app/evolution/**`；`lib/{trace-groups,turn-feed-stats,effective-config}.*`；i18n `ops`。目标：Trace 默认摘要视图、健康总览、一键诊断。
- **WS5 Settings 框架 + 通用/模型**：`components/sections/settings/**`（SettingsSection、SettingsNav、SettingsSearch、`registry.ts`、`categories/general.tsx`、`categories/models.tsx`）、`Model*.tsx`（ModelProvidersCard/ModelFallbackCard/ModelSetupForm/ModelSettingsDialog）、`LanguageSettingsCard/ThemeToggle/LanguageToggle/AccountMenu/AuthGate/LoginScreen.tsx`；`lib/{model-providers,auth}.*`；i18n `settings`、`modelFallback`、`config`、`auth`。目标：模型配置向导化（先选厂商→填 key→选模型）、搜索与高级开关体验、首次引导。
- **WS6 Settings 其余分类**：`components/sections/settings/categories/{behavior,safety,tools,integrations}.tsx`、`AgentLoopSettingsCard/CompactSettingsCard/GoalSettingsCard/SandboxSettingsCard/DynToolsSettingsCard/DiscoverySettingsCard/SkillSettingsCard/JevSettingsCard/LangfuseSettingsCard/EventLogSettingsCard.tsx`、`lib/{dyn-tools,...}`；i18n：`settingsEntries`（`messages/{zh,en}/settingsEntries.ts`）。目标：每张卡片改用 `SettingsGroup`，常用项在前、其余 advanced，补说明文案。

架构师（foundation，已完成）拥有：`components/shell/**`、`components/ui/**`、`styles/**`、`lib/nav.ts`、`AgentLabApp.tsx`、`app/**`（除 evolution）、`lib/i18n/messages/*/{index,shell}.ts`。

## 7. 合并顺序与冲突规避

1. foundation → 2. WS1–WS6 并行（路径互不相交）→ 3. 最后一个 PR 删除空的占位与废弃的 `MorePanel/HomePanel/旧 key`（由架构师/最后合并者做）。
- e2e 选择器已在 foundation 更新为：Rail 链接 `getByRole('link', {name})`、各 section 根节点 `#section-<id>`、子页 `#section-<id>-<sub>`；沿用旧 id（`#panel-play`、`#btnModelSetup`、`#listApprovals` 等）。
- CI 每个 PR 需：`pnpm run build:web-console`、`pnpm run test:unit`、`pnpm run test:acceptance`、相关 e2e。

## 8. Foundation 实际落地结构（分支 `ui-redesign-base`）

- 路由：`lib/nav.ts`（`SECTION_IDS`/`SUB_PAGES`/`parseHash`/`formatHash`，单测 `lib/nav.test.ts`）。新增子页只需改 `SUB_PAGES` + `shell.sub.*` 文案 + 对应 Section 的 `renderSub`。
- 数据与导航：`components/shell/LabProvider.tsx` → `useLab()`（sessions/agents/bots/tasks/approvals/jobs/workspaces/mailAll/swarmRuns/orchestrationRuns、`tick`、`navigate(section, sub?)`、`openSession(id,{focusChat})`、`selectedSessionId`、`setModelSetupOpen`）。需要新的全局数据时**只追加**字段。
- 壳：`LabShell`（Rail + `ShellToolbar` + 六个 Section，Chat 常驻挂载）、`Rail`（`<a href="#/…">` + `aria-current`）。
- Section 外框：`components/sections/SectionFrame.tsx`（页头 + 子页签 + `#section-<id>-<sub>`）。各 Section：`sections/{chat,agents,tasks,knowledge,ops}/XxxSection.tsx`，设置：`sections/settings/{SettingsSection.tsx,registry.ts,categories/*.tsx}`。
- 设置条目：在 `categories/<cat>.tsx` 追加 `SettingsEntry`（`advanced` 控制默认隐藏；`titleKey/keywordsKey` 用于搜索）。
- 原语：`components/ui/*`（`Section`/`SubTabs`/`SettingsGroup`/`AdvancedToggle`/`EmptyState`/`useAdvancedMode`）；样式 `styles/{tokens,shell,primitives}.css`。
- 已删除 `MorePanel`（内容分散到 tasks/inbox、settings 各分类、agents/skills、knowledge）；`HomePanel` 新增 `view` 属性（只渲染一个子视图，各 Section 复用，待各 WS 逐步拆掉）。
- 移除 PlayPanel 的「工作台」按钮与 `onOpenWorkbench`/`workbenchOpen` 属性。
- e2e 约定：rail 链接 `getByRole('link',{name})`；子页签 `getByRole('tab')`；高级设置测试用 `page.addInitScript(() => localStorage.setItem('lab.settings.advanced','1'))`。
- 验收：`acceptance/console-navigation.yaml`、`acceptance/console-settings.yaml`（均带测试）；`model-fallback`/`skill-proposals` 文案已改为新位置。
