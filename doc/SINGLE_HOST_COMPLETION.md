# 单机 Bot 短期收尾

2026-10-28（Asia/Shanghai）。用户要求补齐短期缺口，近期单机部署，明确排除 self-heal。本文按源码与实际测试记录交付，不把历史计划的未勾选项直接当成缺失功能。

## 本轮行为修复

- 关联后台执行的盯梢必须拿到本轮对应任务的真实检查结果，核对任务 ID、所属会话、启动时间与当前记录；其他任务、旧身份、缺少检查不能获得健康静默结论。
- 本轮取得一个状态未变化但有新观察记录的任务，可按策略静默；仅重读旧后台记录不会刷新观察时间；检查期间出现的执行失败明确报告，进程退出不代替目标核验。
- Routine 结果按持久来源关联收集，排除历史摘要和无关回复；旧格式已结束运行增加结束时间边界。已有结果通知保持幂等，不启动额外模型回合。
- 纯回复语言偏好留在对话中，不另建长期目标；显式目标修改和真正的开发要求继续按原语义处理。
- 旧 Routine 缺少附加设置时，自动化面板仍可打开和编辑。
- 本机启动路径经过符号链接时，开发服务正常启动；退出清理子进程、编译失败保留失败状态。
- 手机短屏时首次任务引导限制高度并独立滚动，输入框和草稿保持可见。
- 首页及无效地址默认进入 Bot；显式 `#/chat` 和其它有效地址继续可用。保留原功能入口，不移除已有会话。

验收：`single-host-bot-completion`、`bot-watch-work-continuity`；既有 `console-navigation` 只调整默认页面，其余导航和草稿保留标准不变。

## 已有能力的收尾口径

来源授权连续性、关联 watcher、监督新鲜度、群派工接收与回流已分别有现有规格和实现；不再按旧通信计划从零搭总线。R5 的结果归属与观察真实性在本轮补强。

已核验的既有软件规格：活动栏、历史记忆、身份连续性、侧栏头像、可靠消息、群界面、群目标、群审批、群子任务、例行任务生命周期、软件执行、即时插话、默认 Super Bot。相关自动化行为验收通过后更新为 implemented；真实模型长期质量不由这些确定性测试代替。

## 既有软件验收索引

本轮逐项对照现有标准和测试实现，以下 13 份标准保留原条款；各条款已有通过的行为测试，本轮更新为 implemented。

| 规格 | 条款数 | 主要测试入口 |
|---|---:|---|
| `bot-activity-rail` | 6 | `packages/core/test/bot-activity.test.js` |
| `bot-history-memory` | 6 | `apps/web-console/lib/history-window.test.ts`, `e2e/bot-workspace.spec.ts`, `packages/core/test/bot-history-memory.test.js` 等 |
| `bot-identity-continuity` | 2 | `packages/core/test/bot-work.test.js`, `packages/core/test/message-agent.test.js`, `scripts/test/bot-identity-http.test.mjs` |
| `bot-list-face-plate` | 8 | `apps/web-console/components/SessionListRow.face-plate.test.ts` |
| `bot-reliable-messaging` | 3 | `packages/core/test/bot-work.test.js`, `packages/core/test/message-agent.test.js` |
| `bot-room-console` | 6 | `apps/web-console/components/play-group/room-console.test.ts` |
| `bot-room-goal-intake` | 5 | `packages/core/test/bot-room-goal-intake.test.js` |
| `bot-room-inline-approval` | 5 | `packages/core/test/bot-room-inline-approval.test.js` |
| `bot-room-tasks` | 4 | `packages/core/test/bot-room-tasks.test.js` |
| `bot-routine-lifecycle` | 14 | `apps/web-console/lib/routine-status.test.ts`, `apps/web-console/lib/routine-time.test.ts`, `e2e/bot-work-recovery.spec.ts` 等 |
| `bot-software-execution` | 5 | `e2e/bot-workspace.spec.ts`, `packages/core/test/bash-execution-result.test.js`, `packages/core/test/discovery-openapi.test.js` 等 |
| `bot-steer-visible` | 5 | `apps/web-console/lib/feed-window.test.ts`, `apps/web-console/lib/live-turn-session.test.ts` |
| `default-super-bot` | 10 | `e2e/bot-work-recovery.spec.ts`, `e2e/bot-workspace.spec.ts`, `e2e/lab.smoke.spec.ts` 等 |

`bot-watch-work-continuity` 的本机观察与结果归属已补强；跨机器、工作区与提交证据的组合验收不在本轮宣称完成，整份规格保持 approved。六份 `bot-communication-*` 历史草稿不等于六套必须重写的系统，已落地部分复用现有实现；完整通信改造仍后置。

## 当前不实施的范围

- self-heal 全部新增工作；旧 Evolution shell 流水线继续停止维护。
- 多机生产现场验收保持 approved，不删除、不弱化原40条标准，不迁移软件标准以绕过门禁。
- 分布式存储、多 daemon、联邦、更多领域包、完整通信因果图、负载驱动公平调度和通用构建缓存后置。
- 新的通用变更索引/服务不在本轮重建；现有 Factory/Release 的候选和验证证据保持原权威来源。

## 发布边界

单机软件通过不等于实际安装已升级或生产发布就绪。`bot-release-readiness` 保留发布证据要求；缺真实模型、完整长时浸泡或实际部署回滚证据时不能宣称可发布。没有对用户状态库执行迁移、回滚或重新部署。

## 验证记录

- 已通过：core/daemon TypeScript 编译、Next 生产构建、针对性失败转绿回归、HTTP 集成与回归、验收静态门禁、Quick gate。
- 已通过：生命周期模型（368 状态、2290 转移）、真实 Runtime/SQLite 探针与变异恢复；工具配对模型（5988 状态、11392 转移）、真实源代码探针与变异恢复。模型边界和排除项保持原样。
- 已通过：13 份既有规格每条标准至少一个行为测试；工作台与恢复浏览器专项 18/18。
- 全量 unit：5,466 通过、0 失败、4 条原有跳过；agent-loop vitest：48 文件、472 测试全部通过；CRAP 门禁通过。
- 浏览器全量 93 文件已执行；首轮失败的 10 个文件修复后逐文件隔离重跑全部通过。新增首次任务引导短屏用例验证输入框、草稿和引导链接可见；测试服务均使用临时数据库。
