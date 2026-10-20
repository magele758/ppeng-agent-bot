# 部署与上线回归卡点规划

本文定义项目从本地 daemon/Next 运行，演进到可容器化、可 K8s 部署、可回滚、可自闭环运行的最小方案。

## 目标

1. daemon 与 web-console 可以被重复构建、部署、回滚。
2. stateDir / SQLite / images / traces 有明确持久化策略。
3. 发布前 gate 能确认核心闭环仍可运行：会话、工具、self-heal、Evolution、展示站构建。
4. 后续可扩展到 Helm、Ingress、SLO、告警和 SRE 自动诊断。

## 最小部署拓扑

```
client
  -> ingress / service
  -> web-console (Next.js)
  -> /api/* proxy
  -> daemon
  -> state volume (SQLite, traces, images)
  -> optional external services (model API, Prometheus, Loki, PagerDuty)
```

建议先拆成两个容器：

| 组件 | 职责 | 端口 | 持久化 |
|------|------|------|--------|
| `daemon` | HTTP API、scheduler、runtime、self-heal、gateway、domain loader | `37070` | `RAW_AGENT_STATE_DIR` PVC |
| `web-console` | Next.js UI 与 `/api/*` 代理 | `33815` | 无状态 |

## 容器化建议

第一阶段只做生产镜像，不把开发依赖和 workspace 全部带入运行层。

建议文件：

```text
deploy/docker/Dockerfile.daemon
deploy/docker/Dockerfile.web
deploy/compose/docker-compose.yml
```

daemon 镜像需包含：

- `apps/daemon/dist`
- `packages/core/dist`
- `packages/capability-gateway/dist`
- domain packages dist（如 `agent-sre`、`agent-stock`）
- `package.json` / lockfile 中运行时依赖

web 镜像需包含：

- `apps/web-console/.next`
- `apps/web-console/public`
- Next runtime 依赖
- `DAEMON_PROXY_TARGET=http://daemon:37070`

CI 每天最多向 GHCR 推一组 `daemon` / `web` 的 `:nightly`（同时打 `:latest`，同一 digest）；已是当前提交则跳过。拉镜像与跳过规则见 [`CI.md`](CI.md)「每日 Docker 镜像」。

集群最小路径（拉 GHCR、不现场 build）：

- Compose：[`deploy/compose/docker-compose.k8s.yml`](../deploy/compose/docker-compose.k8s.yml)
- `kubectl apply -k deploy/k8s/compose`

本机 A/B 仍用 [`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml)（`--build` + 本地镜像名）。Helm 默认仓库名未改；要吃 GHCR 时改 `image.repository`。

## Helm / K8s 目录建议

```text
deploy/helm/ppeng-agent-core/
  Chart.yaml
  values.yaml
  templates/
    daemon-deployment.yaml
    web-deployment.yaml
    service-daemon.yaml
    service-web.yaml
    ingress.yaml
    secret.yaml
    pvc.yaml
    configmap.yaml
```

最小 values：

```yaml
image:
  daemon: ppeng-agent-core-daemon:latest
  web: ppeng-agent-core-web:latest

state:
  size: 10Gi
  storageClassName: ""

env:
  RAW_AGENT_MODEL_PROVIDER: openai-compatible
  RAW_AGENT_MODEL_NAME: ""
  RAW_AGENT_BASE_URL: ""

secrets:
  RAW_AGENT_API_KEY: ""

web:
  daemonProxyTarget: http://ppeng-agent-core-daemon:37070
```

## 配置优先级与本地兜底

原则：**配了就自动启用，没配就用本地模式，永不因「没配」而启动失败或功能半残。**
推断逻辑集中在 `packages/core/src/config/effective-config.ts`（纯函数，有单测）。

优先级（高 → 低）：

1. **显式值**：env 里明确写了开关/模式（`RAW_AGENT_*_PROVIDER`、`RAW_AGENT_DOMAINS` CSV、`RAW_AGENT_GATEWAY_ENABLED` …），含 `0` / `off` / `local` / `sqlite`，一律尊重。
2. **Lab 持久化**（`daemon_control` KV，如 web 搜索模板、记忆向量召回 auto/on/off、浏览器开关），保存即生效。
3. **env 连接信息**：`DATABASE_URL` / `REDIS_URL` / `RAW_AGENT_S3_*` / `RAW_AGENT_WEB_SEARCH_URL` / `RAW_AGENT_MCP_*` / `RAW_AGENT_VL_*` / `SRE_*` / `STOCK_*` …
4. **自动推断**：只有「用户提供了连接信息 / 凭证 / 端点」才算配了；PATH 上有二进制或包**不算**。
5. **本地兜底**：SQLite + 本地盘 + 进程内锁；对应工具不暴露。

| 连接信息 | 自动启用 | 备注 |
| --- | --- | --- |
| `DATABASE_URL` | 事件缓冲 `redis_postgres`、技能注册表 `pg_redis` | 需先执行 `packages/core/src/storage/migrations/pg/001_initial.sql`；连不上或缺表 → warn + 回退本地。**会话库仍是 SQLite**（PG 会话路径尚未迁移）。`REDIS_URL` 缺失时按「Redis 可选」降级 |
| `REDIS_URL` | 调度锁 `redis`；PG 档的可选缓存 | 连不上 → 调度器暂用进程内锁，恢复后自动切回 |
| `RAW_AGENT_S3_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY}` 配齐 | 资产 `tiered` | 缓存目录默认 `<stateDir>/tiered-cache`；只配一部分 → warn + 回退本地 |
| `RAW_AGENT_WEB_SEARCH_URL`（或 Lab 模板） | `web_search` 工具 | 没配则不暴露 |
| `RAW_AGENT_MCP_URL(S)` / `RAW_AGENT_MCP_STDIO` | MCP 挂载 | |
| `RAW_AGENT_VL_MODEL_NAME` + 端点/key | `hybrid-router` | 缺端点/key → warn，图片走主模型 |
| `RAW_AGENT_EMBEDDING_*`（专用上游） | 记忆向量召回（Lab 选「自动」时） | 仅有对话 key 不自动开；Lab 可选「开启/关闭」显式覆盖 |
| `SRE_PROM_URL` / `SRE_LOKI_URL` / `SRE_PAGERDUTY_TOKEN` / `SRE_KUBECONFIG`；`STOCK_API_KEY` / `STOCK_NEWS_URL` | 对应只读领域包（`RAW_AGENT_DOMAINS` 未设时） | 设了 CSV（含空串）则以 CSV 为准；`homeiot` / `erp` 永远显式 |

**刻意保持显式**（行为/权限变化，而非连接信息）：外部 AI CLI、cron、浏览器自动化、A2UI 渲染、动态工具、PTC、能力发现、evolving 写回，以及 capability-gateway（会开放入站 HTTP 端点）。Lab 只会提示「本机检测到可用」，不会自动开。

旧的 6 个 `RAW_AGENT_*_PROVIDER` / `DEPLOYMENT_MODE` 仍然有效，作为「高级覆盖」：显式指定的云档缺依赖才会报错退出（用户明确要求了）；显式 `local` / `sqlite` 会压过自动推断。

**看当前到底生效了什么**：`GET /api/config/effective`，或 Lab「更多 → 运行模式 / 有效配置」。每项返回 `enabled` / `source`（`explicit-env` | `lab` | `auto-detected` | `local-fallback`）/ `reason` / `warnings`，不含任何密钥或连接串。

## Health / readiness

现有 `/api/health` 可作为 liveness 基础，但 readiness 应更严格。

建议新增或扩展 readiness 检查项：

- 进程可响应 HTTP。
- `RAW_AGENT_STATE_DIR` 存在且可写。
- SQLite 可打开并完成简单查询。
- model provider 配置可解析，但不强制真实调用模型。
- gateway config 可读取（如果启用 gateway）。
- domain bundle 加载结果可列出，缺失 env 不应导致 daemon 崩溃。

建议端点：

| 端点 | 用途 |
|------|------|
| `/api/health` | liveness，轻量存活 |
| `/api/ready` | readiness，依赖可用性 |
| `/api/version` | 镜像版本、git sha、build time |

## 上线回归卡点

发布前必须经过 release smoke gate：

```text
candidate
  -> build
  -> unit / integration / e2e
  -> contract / security
  -> deploy staging
  -> health / readiness
  -> loop smoke
  -> release or rollback
```

脚本入口：

```bash
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
pnpm run deploy:smoke --daemon-url <daemon> --web-url <web> [--token <token>]
```

## 部署冒烟（deploy-smoke）

[`scripts/deploy-smoke.mjs`](../scripts/deploy-smoke.mjs)（纯逻辑在 [`scripts/lib/deploy-smoke-lib.mjs`](../scripts/lib/deploy-smoke-lib.mjs)，单测
`scripts/test/deploy-smoke-lib.test.mjs`）对**已经跑起来**的部署做黑盒 HTTP 检查，不依赖仓库构建产物、无第三方依赖。

```bash
node scripts/deploy-smoke.mjs \
  --daemon-url http://127.0.0.1:37070 \
  --web-url http://127.0.0.1:33815 \
  --token "$TOKEN" \
  --expect-adapter heuristic \
  --json-out ./deploy-smoke.json
```

| 检查 | 内容 | 前提 |
|------|------|------|
| `daemon_readiness` | `GET /api/readiness` → 200 且 `ready: true`（**启动期重试**） | — |
| `daemon_health` | `GET /api/health` → `ok: true`；给了 `--expect-adapter` 时校验模型适配器 | — |
| `daemon_auth_required` | 直连 daemon 不带 token → **401** | 配了 token |
| `daemon_auth_token` | 直连 daemon 带 `Bearer <token>` → **200** | 配了 token |
| `web_page` | 控制台 `/` → 200 HTML（**启动期重试**） | 给了 `--web-url` |
| `web_readiness_proxy` | 经控制台 `GET /api/readiness` → 200 且 `ready: true`（middleware 能连到 daemon） | 给了 `--web-url` |
| `web_api_proxy` | 经控制台 `GET /api/sessions` → 200（证明 middleware 代理 + 服务端补 Bearer 生效） | 给了 `--web-url` |
| `agents_general` | `GET /api/agents` 含内置 `general` | — |
| `chat_roundtrip` | `POST /api/sessions` 带一条消息，拿到非空助手回复 | — |
| `sse_stream` | 同一会话 `POST /api/sessions/:id/stream`，`text/event-stream` 收到 `result` 事件且无 `error` | — |

- 对话类检查优先**经控制台**发（不带 token，靠代理注入）；没给 `--web-url` 时直连 daemon 并带 token。
- 只有 readiness 与控制台首页会在 `--startup-timeout-ms`（默认 60s）内重试；其余检查只跑一次，避免把不稳定的部署“重试成绿”。
  每个请求有 `--check-timeout-ms`（默认 30s）超时。
- 参数也可用脚本专用环境变量：`DEPLOY_SMOKE_DAEMON_URL` / `DEPLOY_SMOKE_WEB_URL` / `DEPLOY_SMOKE_TOKEN` /
  `DEPLOY_SMOKE_STARTUP_TIMEOUT_MS` / `DEPLOY_SMOKE_CHECK_TIMEOUT_MS`（只被冒烟脚本读取，不影响 daemon）。
- 输出：stdout 为 JSON 摘要（`ok` / `counts` / `failedChecks` / `checks[]`，**不含 token**），stderr 为人读摘要；
  设置了 `GITHUB_STEP_SUMMARY` 时追加 Markdown 表格。退出码 0 = 全过，1 = 有检查失败，2 = 参数错误。
- 用启发式模型（`RAW_AGENT_MODEL_PROVIDER=heuristic`）即可无密钥跑通；对真模型部署同样适用，只是会真实调用一次模型。

调用方：

| 场景 | 目标 | 失败时 |
|------|------|--------|
| `docker-nightly.yml` | runner 上刚构建的 daemon / web 容器 | 一律不推（与 release gate 一样强制，见 [`CI.md`](CI.md)） |
| `release-orchestrator` 部署 Candidate 后 | Candidate daemon / web | 拆掉 Candidate，报告记 `rolled_back`，退出码非 0 |
| `release-orchestrator` promote 后 | Stable daemon / web | 回滚到 promote 前的 Stable，退出码非 0 |
| 手动 | 任意环境 | — |

尚未覆盖（仍是规划项）：`/api/traces`、`/api/self-heal/status` 可读，`evolution --learn-only` dry-run，展示站构建。

## SQLite 单副本约束

SQLite 不支持多进程并发写入。在 K8s 中 daemon Deployment 必须 `replicas: 1`。如果未来需要水平扩展，须迁移到 PostgreSQL 或其它支持并发写的存储。短期通过单 Pod + PVC 满足需求，不做多副本。

## CI/CD 极简 pipeline

```
git push
  -> CI: build + unit + integration + e2e
  -> docker build & push (daemon + web)
  -> helm upgrade --install (staging namespace)
  -> release:smoke (staging)
  -> 通过 -> helm upgrade (production namespace)
  -> 失败 -> helm rollback + 告警
```

镜像 registry 建议先用 GitHub Container Registry 或私有 Harbor；Helm install 可由 GitHub Actions 或本机 `helm upgrade` 手动触发。

## deploy-smoke 在容器/集群内的注意事项

- `evolution --learn-only`：生产 Pod 可能无 `gateway.config.json` 或无 RSS 网络。将来纳入冒烟时建议此项改为 **dry-run 模式**（检查脚本可执行、inbox 目录可写），不实际拉 RSS。
- 若 Pod 内无 git（精简镜像），self-heal smoke 只检查 API 可达，不实际启动 worktree。

## 回滚策略

失败时必须保留：

- 镜像 tag / git sha
- Helm release revision
- daemon logs
- web-console logs
- `/api/ready` 失败原因
- release smoke 输出

回滚顺序：

1. 停止自动合并与自动发布。
2. Helm rollback 到上一 revision。
3. 确认 `/api/ready` 和核心 smoke 通过。
4. 将失败记录转为 C 飞轮（SRE 修复）与 H 飞轮（eval 样本）。

## 自动回滚（release-orchestrator）

[`scripts/release-orchestrator.mjs`](../scripts/release-orchestrator.mjs) 在部署后自动跑部署冒烟（逻辑在
[`scripts/release/deploy-smoke-step.mjs`](../scripts/release/deploy-smoke-step.mjs)，单测
`scripts/release/test/deploy-smoke-step.test.mjs`）：

| 阶段 | 冒烟目标 | 通过 | 失败 |
|------|----------|------|------|
| `start` / `deploy-candidate` 部署 Candidate 后 | `EVOLUTION_RELEASE_CANDIDATE_DAEMON_URL` + `EVOLUTION_RELEASE_CANDIDATE_URL` | 继续 G1 | `rollbackCandidate`（Compose 仅 stop/rm Candidate 服务；Helm `uninstall` Candidate）。Stable 从未被动过，继续服务 |
| `promote` 晋升 Stable 后 | `EVOLUTION_RELEASE_STABLE_DAEMON_URL` + `EVOLUTION_RELEASE_STABLE_URL` | `outcome=promoted` | `rollbackStable` 回到 promote 前记录的 Stable |

- promote 前先记录当前 Stable：Compose 读运行中 `daemon` / `web` 容器的不可变 image ID，回滚通过临时 Compose override 固定这组 ID，使用 `--no-build --pull never --wait`，并核对恢复后的实际 ID。不会将 `sha256:...` 解析成 tag。
- Helm 同时记录 revision 与运行中 Pod digest，并验证旧 revision 的 manifest 已固定相同 digest；旧 manifest 若仍用可变 tag，晋级前就阻断。回滚原 revision 后重新核对 Pod imageID，不以 `helm rollback` 退出成功代替恢复验收。
- 外层 Stable 冒烟失败时，恢复后还会重跑同一冒烟；恢复命令失败、镜像身份不符、恢复后的冒烟失败均记 `rollback.ok=false`、`outcome=backlog`。
- 没有可回滚的旧 Stable（首次部署 / Stable 未运行）时，报告记 `rollback.ok=false`、`outcome=backlog`，需人工处理。
- 目标 daemon URL 为空（例如 Helm 未配 URL）时冒烟记为 `skip`，不阻塞。
- token 用 `RAW_AGENT_AUTH_TOKEN`（与 G1/G2 相同）；启动期重试默认 120s，可用 `DEPLOY_SMOKE_STARTUP_TIMEOUT_MS` 覆盖。
- 报告 `doc/evolution/reports/<id>.json` 新增 `deploy_smoke.{candidate,stable}`（决策 + 每项检查结果）、`stable.previous`、
  `rollback`（目标 / 原因 / 是否成功），`.md` 里有「部署冒烟与回滚」一节。
- Compose 默认 URL：Candidate `http://127.0.0.1:37071` / `:33001`，Stable `http://127.0.0.1:37070` / `:33815`。

## 与 8 飞轮的关系

| 飞轮 | 部署侧作用 |
|------|------------|
| C | 告警、诊断、回滚、自愈 |
| E | secret、RBAC、NetworkPolicy、审计 |
| F | 资源、并发、成本、容量 |
| G | API/SSE/A2UI/MCP 契约不被部署破坏 |
| H | release smoke 与 eval 防止上线即坏 |
