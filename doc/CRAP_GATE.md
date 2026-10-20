# CRAP 门禁（Change Risk Anti-Patterns）

`main` 发布卡点的一部分：阻止「又复杂又没被测试覆盖」的函数进入 main。实现见
[`scripts/crap/crap-lib.mjs`](../scripts/crap/crap-lib.mjs)（纯函数，单测在
[`scripts/test/crap-lib.test.mjs`](../scripts/test/crap-lib.test.mjs)）与
[`scripts/crap/crap-gate.mjs`](../scripts/crap/crap-gate.mjs)（CLI）。

## 公式

```
CRAP(m) = comp(m)² × (1 − cov(m))³ + comp(m)
```

- `comp`：圈复杂度（McCabe）。基数 1，每个 `if` / `?:` / `for` / `for…of` / `for…in` / `while` /
  `do` / `case` / `catch` / `&&` / `||` / `??`（含 `&&=` `||=` `??=`）各 +1；嵌套函数单独计分。
- `cov`：语句覆盖率 ∈ [0, 1]。函数体内可执行语句（不含嵌套函数、类型声明）中，被测试执行到的比例。
- 阈值 **30**（沿用 crap4j 惯例）。

读法：

| 复杂度 | 0% 覆盖 | 50% | 80% | 100% |
|---:|---:|---:|---:|---:|
| 5 | 30 | 8.1 | 5.2 | 5 |
| 10 | 110 | 22.5 | 10.8 | 10 |
| 20 | 420 | 70 | 23.2 | 20 |
| 31 | 992 | 151 | 38.7 | 31 |

- 简单函数不测也过（复杂度 5 以下 CRAP ≤ 30）。
- 复杂度 10 的函数大约需要 40% 以上覆盖，20 需要约 70%。
- 复杂度 > 30 的函数**覆盖率 100% 也过不了**：只能拆分。

## 数据来源

| 来源 | 覆盖哪些代码 | 怎么采 |
|---|---|---|
| `pnpm run test:unit`（node --test，跑 `dist/*.js`） | core / gateway / domain 包 / daemon / cli | `NODE_V8_COVERAGE` 原始 V8 块覆盖，按进程合并后经 `*.js.map` 映射回 `src/*.ts` 行 |
| `packages/agent-loop` vitest | agent-loop 源码 | `@vitest/coverage-v8` 的 `coverage-final.json`（istanbul 语句） |

两路按 TS 源码行取并集。范围：`packages/*/src`、`apps/daemon/src`、`apps/cli/src`（排除 `*.test.ts`、`*.d.ts`）。
**不含** web-console（Next UI）、`test:regression` / `test:integration` / E2E 带来的覆盖：门禁只认单测，
因为它衡量的是「改动能否被快速、确定地验证」。

## 棘轮基线

存量债务冻结在 [`scripts/crap/crap-baseline.json`](../scripts/crap/crap-baseline.json)
（只记 CRAP > 30 的函数，键为 `文件::限定名`，不含行号，改其它代码不会让键漂移；
路由 handler 以 `METHOD /pattern` 命名）。门禁规则：

1. **新增**（或原来 ≤ 30、现在 > 30）的函数 CRAP > 30 → 失败。
2. 基线内函数 CRAP 超过 `基线 × 1.05 + 1` → 失败（容差吸收计时相关路径的覆盖抖动；实测两次全量运行 0 抖动）。
3. 基线内函数变好或被删除 → 提示 `pnpm run test:crap --update-baseline` 锁定收益（不强制）。

所以：存量可以慢慢还，但只能变少，不能变多。

## 本地使用

```bash
nvm use                      # 与 CI 对齐 Node 22
pnpm run test:crap --preflight  # 先检查 Vitest 与覆盖率插件是否解析为同版本
pnpm run build                 # 门禁读 dist 的 source map
pnpm run test:crap             # 带覆盖率跑 test:unit + agent-loop vitest，再判定
pnpm run test:crap:update      # 还债后更新基线（提交 crap-baseline.json）
node scripts/crap/crap-gate.mjs --node-cov <dir> --vitest-cov <coverage-final.json>  # 复用已采的覆盖率
```

报告写到 `coverage/crap/crap-report.json`（全部函数）与 `crap-summary.md`；CI 里同时写入 Job Summary 并上传
`crap-report` artifact。退出码：0 通过，1 门禁失败，2 无法计算（例如测试本身失败，覆盖率不完整）。

预检同时验证 SDK 解析的 Vitest、coverage-v8 和 coverage-v8 自己解析到的 Vitest，避免 hoisting 导致“版本看似正确但插件实际调用另一份 runner”。完整采集使用解析出的 CLI 与当前 Node 进程；冲突应按 `.nvmrc` / 锁文件恢复依赖，不自动安装或更新基线。

JSON 增加 `metadata`（Node、平台、架构、测试工具版本、生成时间、fresh/reused），用于排查环境差异；复用覆盖率时它描述计分进程的环境，不证明原覆盖数据的生成环境。warning 过滤测试主动触发事件，不依赖 Node 版本是否恰好产生 SQLite 实验警告。

降低风险优先补行为测试，不能仅为分数拆函数。已低于阈值的债务应审查后从基线删除，避免收益被后续回归吃掉；本轮仅移除已测到 CRAP 10 的 `applyJevRoute`，不接受新增债务。见 [发布可靠性计划](RELEASE_RELIABILITY_PLAN.md)。

## 门禁失败怎么办

- **新函数超标**：补单测提高覆盖，或拆小函数降低复杂度。别靠调阈值。
- **基线函数变差**：通常是删了/改坏了覆盖它的测试，或往大函数里继续堆分支。
- **确实需要接受新债务**（少见）：`pnpm run test:crap:update` 并在 PR 描述里说明原因，review 时会看到基线 diff。

## 局限（与其它手段互补）

- 覆盖率只说明「执行过」，不说明「断言过」：高覆盖低 CRAP 的模块仍可能测得很弱，需要变异测试补。
- 看不见「缺失的代码」：漏掉的鉴权校验没有复杂度也没有覆盖率；这类问题靠路由级授权测试。
- 并发 / 时序 / 跨进程问题不在其视野内：靠 `test:regression`、`test:integration`、E2E 与 `specs/`。
- 行粒度：同一行里的未执行分支（如单行三元）按该行已执行计。
