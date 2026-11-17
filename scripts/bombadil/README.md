# Bot 切换稳定性探索

安装 [Bombadil v0.7.10](https://antithesishq.github.io/bombadil/browser/2.1-installation.html) 并将可执行文件放到 PATH，运行环境需有 Chrome 或 Chromium。在独立工作目录中用生产构建运行，避免和开发中的 Next 共用 .next。

```sh
pnpm run build
pnpm run test:stability:bots --canary --time-limit 45s
pnpm run test:stability:bots --time-limit 90s
```

每次启动独立的临时 daemon、heuristic 模型、Next 和无头浏览器。正常探索会在两个带历史标记的 Bot 间切换，填写并发送带归属标记的消息，随机刷新或等待。浏览器逐步检查聊天区是否串线，结束时检查两个 Bot 是否都收到了发给自己的消息。覆盖不足也返回失败。测试时长只计算浏览器探索时间。

`--canary` 给临时历史混入另一个 Bot 的消息，用于确认浏览器真的看见并报告了串线。只有退出码 2 且轨迹包含对应属性的违规才算校准成功。这检验了错误检测能力；实际流事件的迟到顺序另由 `e2e/bot-switch-live-turn.spec.ts` 精确控制。

每轮会输出采样数、选择 Bot 次数、发送次数、刷新次数和独立的轨迹目录，运行 `bombadil browser inspect <目录>` 可检查失败前的操作和截图。GitHub Actions 的 **Bot stability exploration** 支持手动运行，修改探索脚本的 PR 也会触发。评估收益时应单独记录校准结果、覆盖不足、可复现的新缺陷以及探索用时。

[GitHub 实测记录](https://github.com/magele758/ppeng-agent-bot/actions/runs/44057193122)中，预置串线触发了 transcriptOwnership 属性。干净样本在 90 秒内观察 4,270 个状态、2 次切换、8 次发送、5 次刷新。后端核对两只 Bot 各收到 2 条和 6 条测试消息。状态数含重复采样。本次探索未发现新的产品串线缺陷。
