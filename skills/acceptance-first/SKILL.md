---
name: acceptance-first
description: Acceptance-first workflow for this repo — turn a user requirement into executable acceptance criteria (acceptance/<feature-id>.yaml, Given/When/Then) that the owner approves before any code is written, then link tests to criteria with [AC:<feature-id>#<criterion-id>] tags so the release gate proves every approved criterion has a passing test. Use when: (1) the user describes a new feature, behaviour change or bug fix to build, (2) writing or editing files under acceptance/, (3) tagging tests for acceptance criteria, (4) the acceptance gate (pnpm run test:acceptance / CI "Acceptance criteria gate") fails, (5) a requirement changes after its criteria were approved.
---

# 验收优先（Acceptance-first）工作流

目标：**负责人只评审验收用例，不评审代码**；发布门禁证明每一条已批准的标准都有一个通过的测试。

- 规格：`acceptance/<feature-id>.yaml`（`feature-id` 为 kebab-case，等于文件名）
- 门禁：`pnpm run test:acceptance`（静态追踪）、CI `Release gate / Acceptance criteria gate`（基于测试结果）
- 详细规则：[`doc/ACCEPTANCE_GATE.md`](../../doc/ACCEPTANCE_GATE.md)；示例：[`acceptance/acceptance-gate.yaml`](../../acceptance/acceptance-gate.yaml)

---

## 1. 规格格式（固定，不要改结构）

```yaml
id: skill-proposals
title: 技能提案审批
status: draft              # draft | approved | implemented | retired
requirement: |
  用户的原话（逐字粘贴，不要改写成实现方案）
criteria:
  - id: AC-1
    given: 已开启技能提案
    when: Agent 提交一个技能提案
    then: Lab「更多」页出现待审批卡片，批准后技能可被 load_skill 加载
```

可选字段：`retiredReason`（retired 时必填理由）、`owner`、`notes`、`links`；criterion 可带 `notes`。其它字段只会告警。

写标准的要求：

- 用**用户能观察到的行为**写 Given / When / Then（中文可以），一条标准一个可验证结果。
- **不写实现细节**：不出现函数名、文件路径、表名、内部 API。负责人要能在不看代码的情况下判断「对不对、全不全」。
- 覆盖正常路径 + 关键边界（权限不足、空数据、失败提示等），每条都能被一个自动化测试证明。
- criterion id 用 `AC-1`、`AC-2`…，一旦批准不再复用或重排。

## 2. 流程（必须按顺序）

1. **起草**：收到需求后先写 `acceptance/<id>.yaml`，`status: draft`，`requirement` 粘贴用户原话。此时不写实现代码。
2. **请负责人确认并停下**：把标准以列表形式展示给用户（Given / When / Then 原文），明确问「这些验收标准是否正确、完整？」，**然后结束本轮，等待回复**。draft 不会让门禁失败。
3. **批准后**：用户确认后把 `status` 改为 `approved`，然后：
   1. **先写测试**：每条标准至少一个测试，标题带标签，先确认它失败（红）；
   2. 再实现代码直到测试通过（绿）；
   3. 跑 `pnpm run test:acceptance`（及相关测试），全部通过后把 `status` 改为 `implemented`。
   规格、测试、代码可以在同一个 PR 里一起合入。
4. **变更**：已批准（approved / implemented）的标准要改写、新增或删除，**必须重新请负责人确认**，并在 PR 的 Acceptance 一节写明改了什么。
5. **废弃**：需求取消时把 `status` 改为 `retired` 并填写 `retiredReason`，同时去掉测试里的对应标签（残留标签只告警）。

**禁止**：为了让门禁通过而删除 / 弱化标准、把 approved 改回 draft、给不相关或空的测试打标签、用 `skip` / `todo` 占位。门禁拦不住的事情靠这条纪律。

## 3. 给测试打标签

在**测试标题**里写 `[AC:<feature-id>#<criterion-id>]`，一个测试可带多个标签；`describe` / `test.describe` 标题上的标签作用于其中所有测试。

```js
// node:test（packages/*/test、apps/web-console/lib/**/*.test.ts、scripts/**/test）
test('批准提案后 load_skill 可加载 [AC:skill-proposals#AC-1]', async () => { /* ... */ });

// vitest（packages/agent-loop/src/**/*.test.ts）
it('steer 在下一轮生效 [AC:loop-steer#AC-2]', () => { /* ... */ });

// Playwright（e2e/*.spec.ts）
test('更多页出现待审批卡片 [AC:skill-proposals#AC-1] [AC:skill-proposals#AC-2]', async ({ page }) => { /* ... */ });
```

- 标题必须是字面量字符串（静态扫描读源码）；`test.skip` / `.todo` / `.fixme` 不算覆盖。
- 测试文件必须被 `test:unit`（`package.json` 里的文件列表）、agent-loop vitest 或 Playwright 实际执行；写在别处的标签会让门禁失败——新增测试文件记得加进 `test:unit`。
- 优先用最接近用户行为的层级：界面行为用 Playwright，API 行为用 daemon 路由测试，纯逻辑用单测。

## 4. 门禁规则速查

| status | 门禁行为 |
|---|---|
| `draft` | 只报告「等待负责人确认」，永不失败 |
| `approved` | 每条标准 ≥1 个带标签测试（静态）；有结果时 ≥1 个通过且无失败。缺测试报 `approved but not implemented` |
| `implemented` | 同上（全部标准必须通过） |
| `retired` | 不检查；引用它的标签只告警 |

另外：标签引用不存在的规格/标准、标签格式错误、规格 schema 错误、criterion id 重复 → 失败。

本地命令：

```bash
pnpm run test:acceptance           # 静态：标签齐不齐（秒级）
pnpm run test:acceptance:full      # 跑 unit + agent-loop vitest + e2e 并基于 JUnit 结果判定（需先 build）
node scripts/acceptance/acceptance-gate.mjs --collect unit,vitest   # 只跑部分运行器
```

## 5. PR 描述

填写 [`.github/pull_request_template.md`](../../.github/pull_request_template.md) 的 **Acceptance** 一节：涉及的 spec id、每个 spec 的状态（新起草 / 已批准 / 已实现 / 已废弃）、标准是否有改动（改动需负责人重新确认）、门禁结果（贴 `pnpm run test:acceptance` 摘要）。

## 经用户批准的阶段拆分

用户于2026-10-19明确批准第四阶段按8条本地软件标准单独交付、原40条作为现场验收保留。可选规格字段 `verificationStage: software | deployment`（省略为software）。新增或改动此字段需要用户明确确认适用阶段；它不改变criteria原文或批准状态。

软件合并运行 `pnpm run test:acceptance`；现场完整验收运行 `pnpm run test:acceptance:deployment`（`--stage all`）。报告必须保留不适用现场条目的真实状态及未认证提示；软件通过不能冒充现场通过。基线已批准的软件规格不能迁出软件门禁。此阶段拆分不得用作给其他未完成需求绕过门禁的通用许可。
