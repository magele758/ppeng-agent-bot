# 聊天系统消息展示清单

系统消息的文字统一经 `SystemMessageContent` 展示，入口覆盖 `ChatTurnFromMessage`（历史）、`ChatTurnPlain`（即时）和 `StructuredBubble` 的文本片段。没有匹配专用解析器的文字，始终进入系统通知卡，包含无标记扩展返回、未来新增标记及格式不完整的消息。

## 已核对的来源

核对了 core 与 agent-loop 两套 turn kernel、runtime 的 l5-bindings / compact-host / session-complete / subagent-help / normal-request-guard、bot-work / concurrent-fork、session 的摘要与 inbox-overflow。注入模型但不进入可见对话的 system prompt 不因本次改动而展示。

| 来源/标记 | 展示 |
|---|---|
| `[risk-advisory]` | 保留风险/容量提示专用卡 |
| Goal / Constraints 等结构化历史摘要 | 保留会话摘要分区卡 |
| `[jev-*]` | 保留 Jev 建议卡，未知格式可查看原文 |
| `[goal update]` | 保留目标状态卡，新增默认折叠的完整原文 |
| `[goal]`、goal coordination / revision / status 等 | 目标检查卡，不冒充当前实时状态 |
| `[recovery] Stopped:` | 执行停止提示 |
| recovery / recovery-advisory / recovery:unknown / self-heal | 恢复与核实通知；未确认执行提示使用警示样式 |
| model-fallback | 模型切换卡 |
| pre-compact / on-compact | 上下文整理卡 |
| stop-hook / stop-extension | 扩展通知卡 |
| bot-help / team-dag | 协作更新卡 |
| command-hardline / os-sandbox / sharing-domain-changed | 权限与边界卡 |
| explicit-shared-context / routine-context / skill-review reminder | 上下文补充卡 |
| 图片导航、收件箱、请求协调等其它文字，以及无标记扩展输出 | 中性的系统通知兜底卡 |

## 展示边界

- 普通通知最多预览 240 字符、3 行；完整原文存于默认关闭的 details，不截断或改写存储消息。
- 目标更新的长标题和原因也限制默认展示行数，原始 JSON、完整原因及模型叮嘱可以主动展开查看。
- 现有摘要、Jev 和风险卡保留各自的折叠详情。
- 仅转换系统文字。用户/助手引用不转换，模型视图保持原始文本；工具调用、结果、图片及其它结构化部分保留原有展示。
- 目标更新的会话归属过滤先于渲染，跨会话消息不能从原文入口泄漏。
- 静态历史通知不使用 alert 强行打断辅助技术；未知格式不猜测危险程度或执行结果。
- UI 文案走中英文 i18n，原文保持原语言。移动端长行换行，模型决策、停止条件和配置不变。

验证包括来源分类、现有目标状态卡、三种渲染入口、模型视图、跨会话隔离、混合工具结果、未知和无标记文本，以及浏览器折叠/原文/窄屏/英文回归。
