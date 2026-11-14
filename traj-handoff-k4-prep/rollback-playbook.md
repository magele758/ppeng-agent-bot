# 第四刀回退预备（不在本阶段执行）

适用：v1.1「回退总规则」+ §5.6，以及拆分稿 §3.4。本文是演练清单与验证命令草稿，不是操作批准，也不在预备阶段关闭或打开任何入口。

## 0. 回退要到达的状态

回到本刀之前：

- 飞轮组合入口关闭，research / implement 使用本刀之前的既有阶段实现。
- 重新施加：来自飞轮的调用不得仅因进入共用 Swarm 执行器就自动启用轨迹交接。
- 独立 Swarm 入口（第三刀已验收）仍须可运行，除非另行显式回退第三刀。
- #516 口径不变。不得用关闭交接掩盖已经放宽的成功映射——本刀禁止放宽。
- 普通会话（含已经持久化自动策略的会话）不受本刀回滚破坏。
- 未验证产物、旧证据、内核 `done` 不得因此获得交付成功身份。

## 1. 触发与前置

- 触发例：第四刀合入后发现阶段泄权、implement 绕门、组合限制解除把飞轮来源做成自动准入、或回归红。
- 前置：确认要回退的是第四刀组合，而不是第三刀独立 Swarm。不要把两个入口当成同一个开关。
- 前置：登记当时 HEAD、同头 Formal / FV / Main full health 结论；回退提交不得 squash 进无关分支，不得放宽 verifier。

## 2. 动作顺序（实现阶段执行，现在只预演）

1. **立即关闭飞轮组合入口**，阻止新的飞轮侧交接准入。本预备不实现该生产原语，只要求未来实现保留可关闭的单一控制点（可信宿主来源 / 组合开关，而不是改 Swarm 策略）。
2. **在途运行受控收尾或取消**。不得把未完成的飞轮 implement 直接放到「旧路径」上重放。结果未知失败关闭；保留已用预算、计划版本、未决调用与等待裁决。迟到事件不得重新启动任务。
3. **恢复 research / implement 的既有阶段实现**（tip `c67112bc` 行为可作为回退对照：implement 仍经 `startSwarmForRun`，但来源限制重新生效；不要借回退改名 Orchestrator 或重写 pipeline）。
4. **重新施加来源限制**：飞轮经共用 Swarm 不得自动启用交接。独立 Swarm 准入不受株连。
5. **禁止顺手改** `gate.ts`、delivery-mapping、verifier，或把失败改写成成功。
6. 只有在没有需新协议处理的活动运行、或已有兼容处理能力时，才回滚到不理解这些运行记录的程序版本。

## 3. 回退后必须再跑的验证

在实现阶段的回退 PR / 回退提交上：

```text
# 构建 packages/core 后
node --test packages/core/test/collaboration-quality-gates.test.js
node --test packages/core/test/trajectory-handoff-delivery-mapping.test.js
node --test packages/core/test/orchestration-engine.test.js
node --test packages/core/test/trajectory-handoff-flywheel-phases.test.js
# 以及第三刀入口隔离与独立 Swarm 回归（文件名以第三刀落地为准，本树不抢写）
# 第二刀单会话 / 已持久化自动策略回归（文件名以第二刀落地为准）
```

验收要点：

- 新的飞轮侧交接准入被拒绝。
- 独立 Swarm 仍能按第三刀策略进入交接（若第三刀未同时回退）。
- 飞轮 implement 再进入共用 Swarm 时，交接保持关闭。
- delivery-mapping 与完整 `collaboration-quality-gates.yaml` 仍绿。
- 已持久化自动策略的普通会话仍按第二刀策略运行。

## 4. 回退夹具（测试双，不是生产原语）

见 `fixture-notes.md` 的 `createFlywheelCompositionHarness({ compositionEntry: 'closed' | 'open' })`。

- `closed`：模拟本刀回退后的来源限制。用于 skip 用例，待实现后取消跳过。
- 该 harness 只存在于测试文件，**不得**被 `collaborators.ts` / `engine.ts` / `swarm/executor.ts` 进口。
- 不要在本预备实现「入口关闭基础原语」的生产代码（Pattern B 与第四刀实现都还没被授权写这些）。

## 5. 明确不要做的回退方式

- 不要关闭已验收的独立 Swarm 入口来「顺便」挡住飞轮。
- 不要用关闭交接掩盖放宽过的成功映射。
- 不要回放结果未知的在途调用。
- 不要回退第二刀默认策略或已持久化自动策略。
- 不要改 Swarm 策略或改名 Orchestrator。
