# LCU 本机桌面操作

LCU 由 `packages/core/src/computer-use` 管理，通用 `agent-loop` 只接收工具和图片资产引用。浏览器和音频能力未启用。

## 使用

在 Lab → 设置 → 工具 → 本机桌面操作（LCU）打开开关。设置保存在 `computer_use_settings`，立即生效，无需新增环境变量。默认命令为 `~/.local/share/lcu/current/bin/lcu`；自定义绝对路径可通过 `PATCH /api/computer-use/settings` 的 `command` 字段保存（需要管理权限）。

运行时须本机已安装 LCU 和签名 ChatGPT 应用、桌面已解锁。安装前校验官方 release archive 的 SHA-256。当前本机使用 LCU 0.11.2。用 `~/.local/share/lcu/current/bin/lcu doctor` 检查运行时，doctor 通过不能代替实际桌面验收。

## 权限与生命周期

每个对话回合建立独立原始 CUA 连接，完整原始 initialization instructions 进入系统上下文，只注册模型可见 `lcu_js` / `lcu_js_reset`。内部工具由宿主调用。会话和回合 ID 不由模型构造。

原始应用授权请求进入 Lab 审批列表；批准只转发本次允许，不制造永久授权。拒绝、关闭/取消回合不会批准；无法显示的授权形式取消。普通工具审批策略继续有效。

同一运行时的多个 Agent 按完整桌面回合取得输入租约，同一回合的工具调用也串行。停止会取消排队操作，等待原始 Interrupt 清理；已发给系统的动作不可撤回，停止延迟受原始运行时限制。清理失败会阻止后续桌面动作并报告具体错误，需重启运行时恢复。

授权、连接、截图和生命周期依赖当前安装的 ChatGPT/CUA 版本；本机 26.1007.30912 / CUA 0.0.29 不是上游已测试版本组合。升级后应复测。

## 图片与验证

原始截图经既有图片资产服务保存。SDK 的 `ToolExecutionResult.images` 在完整工具结果波次之后转为带明确工具来源说明的图片观察消息，进入模型上下文；原始文字、错误状态及 content blocks 保留在工具结果中。

验收文件：`acceptance/lcu-computer-use.yaml`。

- `node --test packages/core/test/lcu-computer-use.test.js`
- `npm run test --workspace=@ppeng/agent-loop`
- `npm run build --workspace=@ppeng/agent-loop`
- `npm run test:e2e -- e2e/lcu-computer-use.spec.ts`
- `npm run test:acceptance`

真实验收必须由 Agent 经 LCU 创建临时 TextEdit 文档，输入并保存指定文字，再由独立文件读取检查，并检查截图实际到达模型。协议 mock 和 UI 开关测试不能代替这一步。
