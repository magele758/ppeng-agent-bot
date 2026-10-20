# 测试与能力矩阵

迭代时对照下表补充/更新用例，避免功能静默回归。

发布目标、分层验证与后续补齐顺序见 [发布可靠性计划](RELEASE_RELIABILITY_PLAN.md)。本地优先 `nvm use` 对齐 `.nvmrc` 的 Node 22；测试绿灯不是对任意模型输出或生产环境的零故障承诺。

## 命令一览

| 命令 | 说明 |
|------|------|
| `pnpm run build` | TypeScript 构建 |
| `pnpm run test:unit` | Core / capability-gateway 单元测试。CI release gate 里经 `scripts/ci/retry-failed-tests.mjs` 跑：失败文件单独重跑一次，重跑通过记为 flaky（告警不卡），两次都挂才判红；见 [`CI.md`](CI.md#flaky-单测策略) |
| `pnpm run test:formal` | 可执行不变量 + PBT + MockLLM E2E + TLA 草稿存在性（**不跑 TLC，不是形式化证明**）；见 [`formal/README.md`](formal/README.md) |
| `pnpm run test:regression` | 临时 daemon + HTTP 黑盒（heuristic，无密钥） |
| `pnpm run test:e2e` | 启动**临时 daemon + Next 控制台**（`next start`）+ Playwright；浏览器打 **Next** 的 URL，`/api/*` 由 Next 代理到临时 daemon |
| `pnpm run test:e2e:install` | 安装 Playwright 浏览器（CI / 新机器） |
| `pnpm run test:remote` | 真模型进程内冒烟（`heuristic` 时跳过；需 env） |
| `pnpm run test:examples` | 顺序跑 `packages/core/examples/01`–`10`（启发式/脚本化适配器，无需密钥），验证 `@ppeng/agent-core` 作为可嵌入 SDK 在 `dist/` 产物上仍可用；见 [`EMBEDDING_SDK.md`](EMBEDDING_SDK.md)。需先 `pnpm exec tsc -b packages/core` |
| `pnpm run test:crap` | 带覆盖率跑 `test:unit` + agent-loop vitest，按 CRAP（复杂度² × 未覆盖³ + 复杂度）卡新增高风险函数；需先 `build`。见 [`CRAP_GATE.md`](CRAP_GATE.md) |
| `pnpm run test:package` | 隔离安装实际 tarball，验证 exports、类型、mini 便携性与最小会话，不发布 |
| `pnpm run test:mutation` | 对关键模块的 `dist` 生成变异体，只跑关联测试，按基线卡变异分数；需先 `build`。独立 workflow 只观察，见 [`MUTATION_TESTING.md`](MUTATION_TESTING.md) |
| `pnpm run agent:eval:verify` | 配对能力评估引擎 simulation 自检；不是模型能力证据 |
| `pnpm run agent:eval:compare --config <experiment.json>` | 真实模型基线/候选比较，见 [Harness 评估](HARNESS_EVALUATION.md) |
| `pnpm run test:acceptance` | 验收标准静态追踪：`acceptance/*.yaml` 中 approved / implemented 的每条标准都要有标题带 `[AC:<id>#<AC-n>]` 的测试；`test:acceptance:full` 跑 unit + vitest + e2e 并按 JUnit 结果判定（标准须有通过的测试）。见 [`ACCEPTANCE_GATE.md`](ACCEPTANCE_GATE.md) 与 [`acceptance-first`](../skills/acceptance-first/SKILL.md) |
| `pnpm run ci:gate-health` | 只读汇总最近 CI 运行的 release gate 通过率、常挂 Job/Step、flaky 次数与 `main` 分支保护状态（需 `gh` 登录）；见 [`CI.md`](CI.md#门禁健康报告) |
| `pnpm run ci` | `build` + `unit` + `acceptance` + `formal` + fast eval（失败退出）+ `agent:eval:verify` + `test:package` + `crap` + `regression` + `integration` + `e2e` |
| `pnpm run ai:tools` / `ai:claude` / `ai:codex` / `ai:cursor` | 外部 AI CLI（需本机安装），见 [`EXTERNAL_AI_CLI.md`](EXTERNAL_AI_CLI.md) |
| `POST /api/self-heal/*`、`pnpm run start:cli self-heal …` | 自愈运行项：回归脚本会探测 start/status/stop、并发 409、daemon `restart-request` |

### `.env` 与真模型：分工

| 脚本 | 作用 | 是否读 `.env` |
|------|------|----------------|
| `pnpm run test:remote` | **进程内** `RawAgentRuntime` 一次会话，校验远程适配器能返回含 `OK` 的回复 | 否；需你在 shell 里 export 变量 |
| `pnpm run test:e2e` | **HTTP + 浏览器**：自启临时 daemon（含 `RAW_AGENT_E2E_ISOLATE=1`，强制 `heuristic`、忽略本机 `.env` 中的远程模型）+ Next；Playwright 默认访问 Next | 否（隔离模式下不依赖 `.env` 真密钥） |

**推荐本地加载 `.env`（勿提交密钥）：**

```bash
set -a && source .env && set +a   # bash/zsh
pnpm run test:remote                 # 真模型适配器冒烟
```

对 **Playwright（连已运行的 Next）**：设 `PLAYWRIGHT_BASE_URL` 为 Next 的 origin（如 `http://127.0.0.1:33815`），并保证该 Next 进程的环境变量 **`DAEMON_PROXY_TARGET`** 指向实际 daemon（如 `http://127.0.0.1:37070`）。脚本检测到 `PLAYWRIGHT_BASE_URL` 时**不再**自启子进程，直接跑 test。

```bash
# 终端 A：daemon
pnpm run start:daemon

# 终端 B：Next（代理到 daemon）
cd apps/web-console && DAEMON_PROXY_TARGET=http://127.0.0.1:37070 pnpm run dev
# 或生产：同上在 start 前 export DAEMON_PROXY_TARGET

# 终端 C
export PLAYWRIGHT_BASE_URL=http://127.0.0.1:33815
node scripts/e2e-run.mjs
```

若 URL 已设置但 Next/daemon 未就绪，用例会失败。

仓库默认 **CI 不加载 `.env`**：`test:regression` / `test:e2e` 使用 `heuristic`。

## Kernel lock（Agent Loop Phase 0）

分层重构不得改这些语义。`node --test` 文件：

- `packages/core/test/session-surface.test.js`
- `packages/core/test/prepare-turn-input.test.js`
- `packages/core/test/turn-recovery.test.js`
- `packages/core/test/auto-compact-replace.test.js`
- `packages/core/test/runtime.test.js`（含 parallel tool calls）
- `packages/core/test/approval-policy.test.js`
- `packages/core/test/agent-loop-contract.test.js`
- `packages/core/test/layer-exports.test.js`

## 能力矩阵 ↔ 自动化

| 能力 | `test:regression` | `test:e2e` | `test:unit` | 备注 |
|------|-------------------|------------|---------------|------|
| `/api/health`、`/api/version` | ✓ | — | 部分 | |
| `POST /api/chat` | ✓ | — | | |
| `GET /api/sessions` | ✓ | — | | |
| `GET /api/sessions/:id` + `messages` | ✓ | — | | |
| `GET /api/sessions/:id/tool-results/:messageId` | ✓ | — | ✓ | 落库 tool_result 全文 |
| `POST /api/sessions/:id/messages` | ✓ | — | | |
| `POST /api/chat/stream`（首块 SSE） | ✓ | — | | |
| 非法 JSON → 400 | ✓ | — | | |
| Task 创建 + `run` | ✓ | — | | |
| `POST /api/scheduler/run` | ✓ | — | | |
| `GET /api/agents` | ✓ | — | | |
| `GET /api/mailbox/all` | ✓ | — | | |
| `GET /api/traces` 无 session → 400 | ✓ | — | | |
| 静态目录穿越 → 404 | ✓ | — | | |
| 未知 API → 404 | ✓ | — | | |
| Daemon `/` stub、Next `/` Agent Lab | ✓（API/regression） | ✓ `lab.smoke`（打 Next） | | |
| 控制台 Tab 切换 | — | ✓ | | |
| Playground 发送消息（启发式） | — | ✓ | | |
| 运行时 / session 循环 | — | — | ✓ `runtime.test.js` 等 | |
| 飞书 Gateway 解析 | — | — | ✓ `feishu-parse` | 不设 mock 不进 HTTP E2E |
| Goal / cron / secrets / sandbox / ingestion / trajectory / teams DAG HTTP | ✓ | — | ✓ settings / pairing | 缺文件不当绿 |
| Lab 更多/Teams DAG/执行模式 | — | ✓ `lab.features` | ✓ session-groups / workspace-binding | |
| Formal 不变量 + MockLLM | — | — | ✓ `test:formal` | 不是 TLC 证明 |

## Playwright 规格文件

| 文件 | 内容 |
|------|------|
| [`e2e/lab.smoke.spec.ts`](../e2e/lab.smoke.spec.ts) | 首页、Tab、Playground 发送 |
| [`e2e/lab.features.spec.ts`](../e2e/lab.features.spec.ts) | 工作台「更多」设置卡、Teams DAG、执行模式/工作区 |

## PR 约定建议

- 新增或修改 **HTTP 行为**：在 [`scripts/regression-test.mjs`](../scripts/regression-test.mjs) 增加断言。
- 新增或修改 **控制台交互**：在 `e2e/` 增加或更新用例。
- 复杂业务逻辑：继续用 **单元测试** 优先。
