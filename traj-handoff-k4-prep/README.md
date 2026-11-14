# 第四刀（飞轮）预备稿 — 测试 / 评估 / 回退

- 性质：隔离 worktree 内的**未提交**预备材料。不是冻结契约，不是第四刀实现，不打开生产飞轮入口，不接线飞轮来源，不改名或替换飞轮 Orchestrator。
- 起草：2026-11-14 17:10 Asia/Shanghai。
- 工作树：`/home/shinemo/wt/traj-handoff-k4-prep-c67112bc`
- 分支：`feat/traj-handoff-k4-prep-c67112bc`
- 基线 HEAD：`c67112bc5de284d3806bc399cf7289458021044f`（#533 squash，单父 `ffe7556a`，提交时间 16:58:12 Asia/Shanghai）。本预备**不得**移动该 HEAD。
- 第四刀实现本身仍须等第三刀验收后再开；本目录只准备检查单、评估矩阵、夹具说明与测试骨架。

## 只读契约（本预备未改这些文件）

| 文件 | sha256 |
| --- | --- |
| `trajectory-handoff-plan.md`（v2.3） | `f6090ce870b068a0aaa0ba99392b67f50a7db7af1f700fee45c519b33d0e5356` |
| `remaining-slices.md`（v1.1） | `9de26ca88333660bfe74cd07320fa0c97057f963a6fc9a325af553d6a36b66c8` |
| `knife34-decomposition.md` | `2f43e7342d8254cec78f831034da2cff1870c77ce974d60d70aef85d220cceba` |
| `pattern-b-extension-design.md` | `fffdca2ac49e316e7d2bf2967ba60d707706cf95199ed6059dcac4f88061f140` |

若本文与 v2.3 冲突，以 v2.3 为准。Pattern B **零代码**（含入口关闭原语）。

## 本目录文件

| 路径 | 内容 |
| --- | --- |
| `composition-acceptance-checklist.md` | 组合验收检查单（含「现在就能核」与「须等第三刀/实现」） |
| `evaluation-matrix.md` | 评估矩阵：契约条目 × 当前 tip 实核 × 骨架用例 × 解阻条件 |
| `rollback-playbook.md` | 第四刀回退预备（不执行；关闭组合入口、恢复来源限制、保守收尾） |
| `fixture-notes.md` | 夹具骨架与注入点。只用引擎 deps，不改生产接线 |
| `holes-waiting-k2-k3.md` | 必须等第二刀或第三刀才能填的洞 |
| `../packages/core/test/trajectory-handoff-flywheel-phases.test.js` | 建议新增测试的预备骨架（表征可跑；组合断言 `test.skip`） |

不要把这些材料提交/推送/开 PR，除非日后确认它们仍完全离开生产路径，且审查口径清楚。不要改 `#516` / `gate.ts` / verifier。不要碰第三刀 / Swarm 生产文件，也不要进入 `#532` 写者树、第三刀树或已退役的 k34 合并树。

## 当前 tip 已核到的关键缺口（只记录，不在本预备修复）

`packages/core/src/orchestrator/engine.ts` 的 `tryCompleteImplementStep` 在 `swarm.status ∈ {completed, failed, cancelled}` 时结束 implement 步骤；`completed` 直接把步骤标为完成，**不经过** `qualityPassed` / `validateQualityReport`。生产接线 `packages/core/src/runtime/collaborators.ts` 为飞轮启动的 Swarm 设置 `qualityGate: ['completed']`。这与 v2.3 §11 / §12「implement 成功出口必须经过现有证据门」不一致，是第四刀实现必须证明并补上的点，不是本预备的代码范围。

`review` / `test` 阶段已经走 `qualityPassed`（既有 `collaboration-quality-gates.test.js`）。阶段顺序仍是 `classify → research → implement → review → test`，implement 的 executor 仍是 `'swarm'`。引擎与飞轮目录没有轨迹交接状态机，也没有可信来源字段。
