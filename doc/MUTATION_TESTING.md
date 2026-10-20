# 变异测试门禁（Mutation Testing）

覆盖率只说明代码「执行过」，变异测试检查的是「断言过」：故意把代码改坏一处（变异体），看关联测试会不会失败。
测试失败就是杀死（killed），测试仍然全过就是存活（survived），说明这处行为没有被任何断言钉住。

本仓库只对**安全 / 权限 / 路由类关键模块**跑变异测试，并按模块记分做棘轮。实现：

| 文件 | 作用 |
|---|---|
| [`scripts/mutation/run-mutation.mjs`](../scripts/mutation/run-mutation.mjs) | CLI：生成变异体、并行跑测试、写报告、判门禁 |
| [`scripts/mutation/mutation-lib.mjs`](../scripts/mutation/mutation-lib.mjs) | 纯函数：变异算子、打分、分片、合并、棘轮判定、Markdown 渲染。单测在 [`scripts/test/mutation-lib.test.mjs`](../scripts/test/mutation-lib.test.mjs) |
| [`scripts/mutation/mutant-loader.mjs`](../scripts/mutation/mutant-loader.mjs) | `module.registerHooks` 加载钩子：在内存里把目标模块换成变异后的源码 |
| [`scripts/mutation/bail-reporter.mjs`](../scripts/mutation/bail-reporter.mjs) | `node --test` reporter：第一个失败就退出，杀死变异体不必等整个文件跑完 |
| [`scripts/mutation/mutation.config.json`](../scripts/mutation/mutation.config.json) | 模块清单：变异哪些文件 / 函数、跑哪些测试、地板分与容差 |
| [`scripts/mutation/mutation-baseline.json`](../scripts/mutation/mutation-baseline.json) | 各模块分数基线（棘轮） |
| [`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml) | CI：每周 + 手动 + 相关 PR，只观察 |

没有引入 StrykerJS 之类的依赖：core 的测试直接 `import ../dist/*.js`，在编译产物上做变异最直接；
只用到仓库已有的 `typescript`（解析 AST）和 Node 22 内置的 `module.registerHooks`、`node --test`、V8 覆盖率。

## 覆盖的模块

| 模块 | 变异范围 | 关联测试 |
|---|---|---|
| `command-hardline` | `sandbox/command-hardline.ts`（bash 硬拦截分析） | `command-hardline.test.js` |
| `bot-policy` | `bots/bot-policy.ts`（工具白名单校验与策略告警） | `bot-policy.test.js` |
| `bot-permission` | `turn/resolve-turn-tools.ts` 的 `allowlistsFor` / `applyAllowlists`；`bots/bot-facade.ts` 的 `savedMaxTurns` / `createCanonicalSession` / `ensureBotPermissionMode` / `ensureBotSessionCut` | `bot-policy` / `bots` / `message-agent` 测试 |
| `model-fallback-chain` | `model/fallback-chain.ts`（fallback 链设置、校验、规划） | `model-fallback.test.js` |
| `model-error-class` | `model/error-class.ts`（上游错误分类） | `model-fallback.test.js` |
| `memory-namespace` | `memory/bot-memory-scope.ts`；`memory/store.ts` 中与 `agent_id` 隔离相关的方法 | `bot-memory-namespace.test.js` |
| `skill-proposal-validate` | `skill-proposals/validate.ts`（提案校验与密钥检测） | `skill-proposals.test.js` |
| `message-agent` | `tools/message-agent.ts`（bot 间消息、owner 校验、唤醒规则） | `message-agent.test.js` |

`mutate` 里写路径表示变异整个文件，写 `{ file, functions }` 只变异这些函数 / 方法（函数改名而配置没跟上会直接报错，
不会悄悄缩小范围）。新增模块：在 config 里加一项，跑一次全量并 `--update-baseline`。

## 怎么工作

1. **检查产物新鲜度**：`dist/*.js` 比对应 `src/*.ts` 旧就退出码 2，提示先 `node scripts/build-workspace.mjs`。
2. **干净运行**：不带变异跑一遍关联测试，必须全过；同时采 V8 函数级覆盖率（复用 CRAP 门禁的 `paintV8Functions`），
   并记录耗时。还会确认测试真的加载了目标模块（否则变异无意义，退出码 2）。
3. **生成变异体**：用 TypeScript 编译器 API 解析 dist JS，每处可变异的节点产出一个变异体，丢弃与原文或此前变异体
   结果相同的（语法无效的变异体记为 `error`，不计分）。算子（都保持语法合法）：

   | 算子 | 改法 |
   |---|---|
   | `boundary` | `<` ↔ `<=`，`>` ↔ `>=` |
   | `equality` | `===` ↔ `!==`，`==` ↔ `!=` |
   | `logical` | `&&` ↔ `\|\|` |
   | `negate` | `if` / `while` / `for` / 三元的条件取反；去掉前缀 `!` |
   | `boolean` | `true` ↔ `false` |
   | `return-value` | `if` 守卫里的 `return x` → `return undefined`（`x` 非平凡时） |
   | `remove-guard` | 删掉 `if` 守卫里的 `return` / `throw` / `continue` / `break` |
   | `remove-call` | 删掉函数体内的调用语句（不含 `super()` / `console.*`） |
   | `string-empty` | 作为模式 / 判别量的字符串（`===` 比较、`case`、数组字面量、`includes` / `startsWith` / `split` / `has` / `new Set` 等参数）→ `''` |
   | `regex` | 正则字面量 → 永不匹配 `/(?!)/` 与总是匹配 `/(?:)/` |

4. **跑变异体**：变异后的源码写进临时目录，子进程以 `--import mutant-loader.mjs` 启动，
   通过 `MUTATION_TARGET`（被替换的 dist 文件）/ `MUTATION_SOURCE`（变异源码）告诉钩子替换谁。
   **磁盘上的产物从不被修改**，中途 Ctrl-C / 崩溃也无需「恢复」；临时目录在退出时（含 SIGINT / SIGTERM）删除，
   在跑的子进程按进程组终止。测试文件按 config 顺序执行，第一个失败即判杀死（bail reporter）。
5. **分类**：

   | 状态 | 含义 | 计分 |
   |---|---|---|
   | `killed` | 测试失败 | 算检出 |
   | `timeout` | 超时（多为变异出死循环），超时 = `max(10s, 干净运行 × 4 + 3s)` | 算检出 |
   | `survived` | 测试全过 | 未检出 |
   | `no-coverage` | 变异落在干净运行没执行到的函数里，不必跑就知道会存活 | 未检出 |
   | `error` | 变异后语法无效，或子进程无法启动 | 不计分 |

   分数 = `(killed + timeout) / (killed + timeout + survived + no-coverage)`。

6. **并行**：默认并发 = CPU 核数（`--concurrency` 可调）。每个子进程只跑该模块的关联测试，而不是整个 `test:unit`。

## 本地使用

```bash
node scripts/build-workspace.mjs                       # 先编译
pnpm run test:mutation                                  # 全部模块 + 门禁
pnpm run test:mutation --module bot-policy,message-agent
pnpm run test:mutation --module command-hardline --max-mutants 200   # 均匀抽样，快速迭代
pnpm run test:mutation --list --module memory-namespace              # 只列变异体
pnpm run test:mutation --update-baseline             # 分数提高后锁定（只升不降）
pnpm run test:mutation --help
```

| 参数 | 作用 |
|---|---|
| `--module a,b` | 只跑这些模块 |
| `--concurrency <n>` | 并发子进程数（默认 CPU 核数） |
| `--operators a,b` | 只用这些算子 |
| `--max-mutants <n>` | 每个文件均匀抽样 n 个（本地快速循环；不能用于更新基线） |
| `--shard i/n` | 按变异体序号交错切片，只跑第 i 片（CI 矩阵） |
| `--merge <dir>` | 不跑变异，合并 `<dir>` 下所有 `mutation-report.json` 再判门禁 |
| `--out <dir>` | 报告目录（默认 `coverage/mutation/`） |
| `--no-gate` | 只出报告，总是退出 0 |
| `--update-baseline` | 用本次分数抬高基线；需要全量运行（不能带 `--shard` / `--max-mutants` / `--operators`） |
| `--allow-decrease` | 与 `--update-baseline` 一起用，接受分数下降（需在 PR 里说明） |

输出：`<out>/mutation-report.json`（每个变异体：`id`、`file`、`where`（经 source map 映射到 `src/*.ts:行`）、
`distLine`、`operator`、`original`、`replacement`、`status`、`ms`）与 `<out>/mutation-summary.md`
（各模块计数与分数、门禁结论、每个模块前若干存活变异体）。设置了 `$GITHUB_STEP_SUMMARY` 时 Markdown 同时追加进去。
退出码：0 通过，1 门禁失败，2 无法运行（产物过期 / 缺失、干净运行失败、测试未加载目标模块）。

想手动确认某个存活变异体：从报告里拿 `original` / `replacement` 改一份 dist 副本，然后

```bash
MUTATION_TARGET=$PWD/packages/core/dist/sandbox/command-hardline.js MUTATION_SOURCE=/tmp/mut.js \
  node --import ./scripts/mutation/mutant-loader.mjs --test packages/core/test/command-hardline.test.js
```

## 棘轮基线

`mutation-baseline.json` 记每个模块的分数。门禁规则（`evaluateGate`）：

1. 模块在基线里：分数 < `基线 − tolerance`（默认 2 个百分点）→ 失败。容差吸收超时类变异体的抖动和小幅重构带来的变异体数量变化。
2. 模块不在基线里（新加的）：分数 < `floor`（默认 60）→ 失败。
3. 分数高于基线 → 提示 `--update-baseline` 锁定（不强制）。`--update-baseline` 只抬不降，除非加 `--allow-decrease`。

## CI（只观察）

[`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml) 每周一 03:23 UTC 全量跑，可手动触发，
PR 只在上表模块源码、关联测试、`scripts/mutation/**` 或 workflow 自身变化时触发。
`command-hardline` 变异体最多，切 3 片并行；其余模块一个 job；`gate` job 下载各片报告后 `--merge` 判定并写 Job Summary，
上传 `mutation-report` artifact。

它**不在 `release-gate.yml`、也不是必需检查**：跌破基线只让这个 workflow 变红。全量单机约 20+ 分钟（4 核），
跑稳一段时间后再考虑纳入发布卡点。

## 存活变异体怎么处理

先判断是「测试缺断言」还是「等价变异体」（改了代码但行为不变）：

- **缺断言**：补测试。优先断言**可观察行为**（返回值、抛出的错误码、写进库里的字段），而不是内部调用。
  典型漏洞：只测了正例没测边界（`<` vs `<=`），只断言 `ok: false` 没断言错误码，只测了第一个分支的早返回。
- **等价变异体**：在 TS 源码该行上方加注释 `// mutation-ignore-next-line: <为什么等价>`，tsc 保留注释，
  dist 下一行就不再生成变异体。不要为了分数加这个注释；理由写不清楚就说明它可能不等价。
- **防御性代码**（例如在 Node 里永远成立的 `typeof AbortSignal` 判断）：可以接受存活，不必为它造运行环境。

### 本次补强前后

第一次全量运行（基线前）与补测试后（4 核，`--concurrency 4`）：

| 模块 | 变异体 | 补强前 | 补强后 | 补强后存活 + 无覆盖 |
|---|---:|---:|---:|---:|
| `command-hardline` | 3064 | 67.40% | 76.89% | 578 + 130 |
| `bot-policy` | 64 | 90.62% | 100.00% | 0 |
| `bot-permission` | 42 | 78.57% | 92.85% | 2 + 1 |
| `model-fallback-chain` | 163 | 77.30% | 96.93% | 4 + 1 |
| `model-error-class` | 183 | 75.40% | 98.36% | 3 |
| `memory-namespace` | 182 | 57.62% | 97.25% | 5 |
| `skill-proposal-validate` | 135 | 80.00% | 97.03% | 4 |
| `message-agent` | 251 | 72.50% | 94.82% | 7 + 6 |

全量单机 1421s（4 核，其中 `command-hardline` 约 1024s）。补强过程中顺带修了三个真实问题：

- bwrap 沙箱：私有 `/tmp` 挂载在工作区绑定之后，会把 `/tmp` 下的工作区盖掉（`os-sandbox.ts`）。
- hardline：`time -p rm -rf /`、`/usr/bin/time -f %e rm -rf /` 没被识别（`time` 的选项被当成命令名）。
- 记忆：`SqliteStateStore` 在跑迁移之前就构造了 `AgentMemoryStore`，新库上 FTS 检测为 false，
  直到进程重启前全部走 LIKE（`ftsSearch` 在测试里从未执行，表现为整片 `no-coverage`）。

剩下的存活变异体大多是等价或防御性的，例如：

- `message-agent`：`effectiveRelayHop` 的两个守卫、名册按 id / 名字解析的早返回（id 与名字唯一，后续查找结果相同）、
  「给自己发消息」检查（前面的 agentId 检查已拦住，不可达）。
- `model-fallback-chain`：允许列表里的 `'heuristic'`（heuristic 已先行判定）、链已去重后的 `continue` / `seen.add`。
- `model-error-class`：`typeof AbortSignal` 判断（Node 里总有定义）、null / undefined 守卫。
- `memory-namespace`：`hasFts` 的探测与 `ftsSearch` 的异常都会回落到 LIKE，结果相同；`enforceLimit` 的 `<=` → `<`（多一次 `LIMIT 0` 删除）。
- `command-hardline`：集中在词法器内部（`lexShell` / `readStringLiteral` / 括号匹配，变异后在测试输入上仍切出相同的词）、
  `kill` 选项消费（只有值恰好是 `-1` 时才有差别）、`visited` 去重（只影响性能）。

补强时发现但**未修**的 hardline 盲区（需要单独设计）：上游管道喂给解释器（`echo "…" | python3`）、
`||` 之后的赋值（`R=/tmp; false || R=/; rm -rf $R`）、循环体里的赋值、`local -x`、`cd /; popd; rm -rf *`。

## 局限

- 只变异 dist JS：TypeScript 类型层面的错误不在范围内；一处源码可能对应多个 dist 变异体（例如 `?.` 降级后的表达式）。
- 算子是有意保守的子集（没有算术、赋值、对象字面量、数组方法替换等），分数不能和 Stryker 等工具的分数直接比较。
- `no-coverage` 按**函数**判定：函数被执行过但某个分支没执行到，这个分支上的变异体仍会真跑一遍（结果是存活）。
- 存活不等于有 bug，杀死也不等于测得完美：变异测试只告诉你「这个改动没有测试在乎」。
