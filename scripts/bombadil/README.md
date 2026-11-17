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

## 字体设置对照实验

`pnpm run test:stability:compare --rounds 3 --time-limit 90s` 在同一构建上交替运行原有四个字体设置 Playwright 回归和 Bombadil 字体探索，每组使用独立 Lab。预装 Bombadil v0.7.10，并设置 `CHROME` 为本机测试 Chrome 可执行文件，可确保两种驱动使用同一浏览器版本。Linux 基准工作流使用系统 Google Chrome。

`--base-url http://localhost:23000` 可复用已经运行的 Lab。它先只读检查 `/api/health`，成功才启动无头测试浏览器。字体和语言操作可能保存到该实例的偏好设置，适合使用测试实例。此模式各轮共享后端状态，报告会记录目标 origin。对原有 Bot 串线的造数和故障校准继续使用隔离实例。

每轮记录 5 个字号 × 中英文 × 640/1280 两个视口共 20 个可见状态。只有实际渲染的预览字号与选择值和文档设置一致才计数。多次观察同一个组合只计一次。校准以 1px 样式破坏预览，要求 trace 记录注入后的 1px 错误及指定属性违规。正常运行还必须实际改过字号。

`test-results/bombadil/comparison-*/report.json` 保存逐轮结果、基线与探索各自命中的组合、联合覆盖增量（百分点）、测试耗时中位数，以及字号 change 事件到首个样式匹配动画帧的 P50/P95 和样本量。后者包含驱动开销，不能代表用户生产环境的绘制耗时。两个驱动用同一探针，原有回归仍使用自身的会话 fixture。覆盖率分母只限上述字体状态。缺少校准、有效对照或页面样本时没有覆盖增益结论；缺少延时样本时延时为 null。
