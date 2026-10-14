# macOS 应用控制

外层宿主能力，在 `packages/core/src/app-control`。通用 agent-loop 只看见工具名和结果，不包含 osascript、Accessibility 或 Apple Events。

现有 LCU（`lcu_js` / `lcu_js_reset`）不变。

## 使用

Lab → 设置 → 工具 → macOS 应用控制。默认关闭，保存在 `app_control_settings`，保存后立即生效。没有新的 `RAW_AGENT_*` 开关。

模型只能调用三个固定动作：`app_activate`、`app_type_text`、`app_keystroke`（return、tab、escape、方向键、cmd-c、cmd-v）。宿主填固定脚本。像脚本、`do shell script` 或 URL scheme 的参数会被拒绝。

只在 macOS 上启动 `/usr/bin/osascript`。Linux 和 Windows 返回不可用，不启动子进程。首次调用会走系统自己的权限弹窗，这里不会预先授权。每个动作仍要在 Lab 里批准，批准一个动作不会放开别的动作。

子进程经 `sanitizeSpawnEnv` 使用最小环境，不带密钥和代理。
