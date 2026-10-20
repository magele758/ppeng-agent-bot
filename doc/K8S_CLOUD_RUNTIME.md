# Kubernetes 云运行时蓝图（Agent Core）

本文基于本仓库现有产物（`deploy/helm/ppeng-agent-core/`、`deploy/docker/*`、`deploy/compose/docker-compose.yml`、`apps/daemon`、`apps/web-console`）描述将 **daemon + Next web-console + 可选 capability-gateway** 部署到 Kubernetes 时的架构、扩容边界、会话/流式、隔离、持久化、HA、观测与自愈闭环。**不假设你已改造存储层**：默认仍为 **SQLite + `RAW_AGENT_STATE_DIR`** 下的文件（含 `runtime.sqlite`、`images/`、`traces/` 等，见 `doc/ARCHITECTURE.md`、`doc/DEPLOYMENT.md`）。

---

## 1. 总体架构拓扑

```
                    Internet / 内网用户
                           │
                    Ingress (TLS / WSS)
                           │
         ┌─────────────────┴─────────────────┐
         │   Service: web (ClusterIP/LB)    │
         │   Deployment: web (Next, 无状态)  │
         └─────────────────┬─────────────────┘
                           │  cluster DNS: DAEMON_PROXY_TARGET
         ┌─────────────────┴─────────────────┐
         │   Service: daemon                 │
         │   Deployment/StatefulSet: daemon │
         │   PVC: RAW_AGENT_STATE_DIR        │
         └─────────────────┬─────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         外部 LLM API   Prometheus    Loki/Grafana
              │         (抓取/metrics)  (可选)
```

- **Ingress / LB**：对外暴露 HTTPS；长连接相关路由终止在此层或云 LB，需对齐 **idle timeout、WebSocket/SSE** 参数（见下文）。
- **Pods**：典型为 **web** 与 **daemon** 两个工作负载；`capability-gateway` 目前编译进 daemon 镜像（`deploy/docker/Dockerfile.daemon`），按路径前缀挂载，不是独立 Deployment。
- **存储**：daemon Pod 挂载 PVC 到 **`RAW_AGENT_STATE_DIR`（-chart 中为 `/data/state`）**，与 Helm `persistence.accessMode: ReadWriteOnce` 一致（`deploy/helm/ppeng-agent-core/templates/pvc.yaml`）。

---

## 2. 组件拆分

| 组件 | 代码路径 | 职责 | K8s 形态 |
|------|-----------|------|----------|
| **web** | `apps/web-console` | UI；`/api/*` 由 `middleware.ts` **运行时** `fetch` 转发到 `DAEMON_PROXY_TARGET` | `Deployment`，可多副本、无 PVC |
| **daemon** | `apps/daemon` | HTTP API、调度、`/api/self-heal/*`、`/api/daemon/restart-request`、SSE 流式、可选 domain 包 | 默认与 **SQLite** 强绑定 → **单写者** 约束 |
| **网关** | `packages/capability-gateway` | IM/RSS 等；由环境变量 `RAW_AGENT_GATEWAY_PREFIX` 等挂载（见 `doc/ARCHITECTURE.md`） | 与 daemon 同进程或未来拆 Sidecar |

**Web 代理与流式**：`apps/web-console/middleware.ts` 对 `/api/:path*` 使用 `fetch` + `NextResponse(res.body, …)` 透传响应体，SSE 可沿此路径传播；但 **任何前置代理** 若开启响应缓冲或短 **idle timeout**，都会截断 `text/event-stream`。

**Daemon 流式实现**：`apps/daemon/src/routes/sessions.ts` 中 `sseInit` / `sseSend`（`apps/daemon/src/http-utils.ts`）向客户端推送 `event: model|result|error`；入口包括 **`POST /api/sessions/:id/stream`**、**`POST /api/chat/stream`**。当前仓库 **没有** 内置「多观众广播」或 **WebSocket** 服务端；多客户端需架构演进（见 §5）。

**健康检查**：Helm 中 daemon liveness `GET /api/health`，readiness `GET /api/readiness`（`deploy/helm/ppeng-agent-core/templates/daemon-deployment.yaml`）。实现见 `apps/daemon/src/routes/misc.ts`。**注意**：当前 readiness 对「可写」的探测使用 **系统 tmpdir**，未直接探测 PVC 挂载路径；生产建议扩展为对 **`RAW_AGENT_STATE_DIR`** 写探针，与 `doc/DEPLOYMENT.md` 表述对齐。

---

## 3. 多副本：SQLite 与本仓库现实

**结论（诚实）**：SQLite 在多进程并发 **写** 场景下不适用。本运行时主库为 **`runtime.sqlite`**（`packages/core/src/storage.ts` 等），**daemon 水平扩展为多写 replicas 不可行**。`doc/DEPLOYMENT.md` 已写明：daemon `Deployment` 须 **`replicas: 1`**（与当前 Helm `replicaCount` 同时为 web/daemon 复用的结构一致——**生产应拆成独立值：web 可扩，daemon 保持 1**，见 §12）。

### 三种演进路线

| 路线 | 描述 | 适用 |
|------|------|------|
| **A. StatefulSet + 单主 + RWO PVC** | 单 Pod 独占卷，保证唯一写者；可配合 **topology spread** / **PodDisruptionBudget** 控制中止 | **当前最接近**：与现有 Helm 一致 |
| **B. 多块 RWO「拼」扩容** | 每副本独立 PVC → **会话数据分片**：需应用层路由 **sessionId → 固定后端实例**（自定义 Router / Consul / Redis 会话表），且无跨副本共享会话 | 工程量大；仍可避免 SQLite 多写同一文件 |
| **C. 拆分 PostgreSQL（+ Redis/NATS/Kafka）** | 会话、消息、任务等迁移 Postgres；Redis 会话粘滞缓存/速率限制；消息总线做事件广播 | **云原生终态**：daemon 可多副本或无状态worker + queue |

**推荐终态**：**C**（Postgres + 可选 Redis Streams / NATS / Kafka 承载「运行事件」与广播），与本仓库 `doc/MEMORY_MULTIUSER.md` 中多租户、审计、语义检索演进一致。

**迁移路径（务实）**：  
1) 云上先 **A**：单 daemon + HA 仅在 **编排层**（快速故障转移、快照备份）。  
2) 读出路径只读副本或 **离线分析**：从 PVC 快照/备份抽数，不怼在线 SQLite。  
3) 按需实施 **存储抽象层** → Postgres，再放开 daemon **多副本** 与 **广播服务**。

---

## 4. 会话亲和与状态保持

**何时需要 sticky**  
- **SQLite 单副本**：同一会话所有请求落同一 Pod 即满足（天然单 Pod）。  
- **路线 B 分片** 或 **未来多 daemon**：需 **session affinity**：`Service` `sessionAffinity: ClientIP`（粗）、或 **Ingress** `affinity`/`cookie` 注解（视控制器：nginx、traefik、haproxy、云 ALB）。  
- **长时间 SSE**：连接建立后一般由 **同一 TCP 连接** 维系，但一旦重连会重新负载均衡——须保证路由到持有 runloop 的正确实例（或改为 **中心化事件总线**，见 §5）。

**何时不够**  
- `ClientIP` 在 NAT 后碰撞；移动端 IP 变换。→ 用 **cookie-based** affinity 或 **应用层网关**（按 `sessionId` 哈希）。  
- **滚动发布**：旧连接与新 Pod 割裂。→ 结合 **terminationGracePeriod**、`preStop` 延迟摘除、SSE 客户端 **自动重连 + Last-Event-ID**（当前客户端需自检是否实现）。

---

## 5. 流式 SSE / WS；多客户端订阅

### 5.1 K8s / LB 注意点

- **Idle timeout**：云 LB、Ingress、Service 默认可能 60s；SSE 可能长时间无「业务」字节，需调大或 **定期 comment/ping**（服务端可扩展 `sseSend` 心跳）。  
- **缓冲**：禁用代理对 SSE 的响应缓冲（如 nginx `proxy_buffering off`、`X-Accel-Buffering: no`）。  
- **Body 大小限制**：注意 Ingress 对 request body 限制；流式主要是 **响应** 长连接。

### 5.2 本仓库现状 → 多观众广播

当前 **`onModelStreamChunk` 只写入当前 HTTP 响应**（`streamRun`），**第二路浏览器不会收到同一路 push**。  
演进选项：

1. **Redis Pub/Sub**：轻量；**不持久**；适合「纯广播」、可丢中间态。  
2. **Redis Streams**：消费者组、可重放；适合「观众晚进能追一点历史」。  
3. **NATS / JetStream** 或 **Kafka**：多订阅、高吞吐、与事件驱动运维衔接好。

推荐模式：独立 **broadcaster** Deployment（或 daemon 内模块）订阅 **runtime 产生的事件主题** `session:{id}`，再向各 WS/SSE 连接 fan-out。daemon 计算仍可在单主；广播层 **无状态** 可水平扩展。

### 5.3 WebSocket

本仓库 **未提供** 原生 WSS 服务；若引入，建议 **独立 WS 层**（与 HTTP API 分离扩缩容），共用 **认证与 session 主题**。

---

## 6. WSS / TLS

- 使用 **cert-manager** 签发 `Certificate`，Ingress 引用 `tls.secretName`。  
- Ingress 需开启 **WebSocket 升级**（多数控制器默认支持；显式检查 `Connection: upgrade`、`Upgrade: websocket`）。  
- 与 SSE 相同：**超时、缓冲、上传大小** 在 Ingress 注解中逐项核对。

---

## 7. 多租户与隔离

与 `doc/MEMORY_MULTIUSER.md` 一致，分层次落地：

| 层级 | 建议 |
|------|------|
| **K8s** | 每大客户 **Namespace**；`ResourceQuota`、`LimitRange`；**NetworkPolicy** 限定仅 web→daemon、daemon→ egress 模型 API |
| **RBAC** | ServiceAccount **最小权限**；禁止 Pod 挂载宿主机 kubeconfig |
| **API** | `RAW_AGENT_AUTH_TOKEN` Bearer；或由 Ingress 注入 `X-User-Id` / `X-Tenant-Id`（文档规划） |
| **数据** | 成熟形态：**DB 层** `tenant_id`；当下 SQLite 单机多为 **单租户实例**（每租户一组 release + PVC） |
| **`RAW_AGENT_*` 分层** | 使用 **Secret**（密钥、`RAW_AGENT_API_KEY`）、**ConfigMap**（非敏感默认值）、必要时 **租户级 Helm values**；**never commit secrets**（`.env` 不进 repo，与 `README`/CI 指引一致） |
| **Domain 工具** | `RAW_AGENT_DOMAINS=sre,stock` 按需开启；见 `doc/DOMAIN_AGENTS.md`、`apps/daemon` domain loader |

---

## 8. 持久化与备份

- **写入根路径**：环境变量 **`RAW_AGENT_STATE_DIR`**（Helm 默认挂载 `/data/state`）。  
- **SQLite**：不推荐网络共享 FS 多写；**单 Pod RWO** 最稳。  
- **快照**：云平台卷快照 Cron；或 **Velero**（含 PV）。  
- **应用一致**：daemon 静默前 flush（利用 `preStop` + 就绪摘除）；大变更前触发 **停机窗口备份**。  
- **Evolution/docs 工件**：若在容器内跑 `pnpm run evolution`，需挂载可写 **`stateDir`/仓库** 或使用 **Job** PVC（见 §10）。

---

## 9. 高可用与容量

| 维度 | 建议 |
|------|------|
| **topologySpreadConstraints** | 跨 AZ 打散 web；daemon 单副本时仍可避免与关键依赖共节点（视情况） |
| **PodDisruptionBudget** | web：minAvailable；daemon：慎重（仅 1 副本时 PDB 语义有限） |
| **HPA** | web 可依 CPU/RPS **HPA**；**daemon 在 SQLite 模式下不建议因负载自动扩副本** |
| **跨区域 DR** | 备份 + 冷备用集群；SQLite 不推荐双活跨区写 |

---

## 10. 可观测性（与 `@ppeng/agent-sre` 结合点）

本仓库暂未内置 Prometheus scrape 端口规范；演进建议：

| 信号 | 方案 |
|------|------|
| **Metrics** | 为 daemon 暴露 `/metrics`，或 Node 侧 **`prom-client`**；告警 **PrometheusRule**（延迟、错误率、self-heal 409、SSE 断开率） |
| **Logs** | 容器 stdout → **Loki**/ELK；**JSON structured** |
| **Tracing** | core 可选 OpenTelemetry hooks（见 `README`/`ARCHITECTURE`）；接入 Tempo/Jaeger |
| **SRE Agent** | 挂载 `RAW_AGENT_DOMAINS=sre` 后，`@ppeng/agent-sre` 提供只读 **`prom_query`**、**`loki_query`**、**`k8s_get`**、**`pagerduty_list`**（`packages/agent-sre/src/index.ts`）；将 Prom/Loki/API token 置于 **Secret**，供工具环境变量读取（按你方封装规范） |

---

## 11. 自愈闭环与 Evolution 反馈（Kubernetes 模式）

### 11.1 仓库已有机制（摘要）

- **Self-heal HTTP**：`/api/self-heal/start`、`/api/self-heal/status`、runs CRUD（`apps/daemon/src/routes/self-heal.ts`）；需 **git/npm 能力与策略**——容器内常需挂 **emptyDir/workspace**、或仅把 API 用作 **控制面**。  
- **Daemon 重启握手**：`/api/daemon/restart-request`、`/api/daemon/restart-request/ack`（`misc.ts`）。  
- **Evolution**：`pnpm run evolution …`、`scripts/evolution-cli.mjs`；cron 示例 `scripts/cron-evolution.example.sh` → `evolution-pipeline.sh`；与 **merge gate、harness eval**（`EVOLUTION_MERGE_RISK_CHECK`、`EVOLUTION_HARNESS_GATE`、`doc/HARNESS_EVAL.md`）可组成质量闭环。

### 11.2 建议 K8s 编排形态

| 模式 | 用途 |
|------|------|
| **CronJob** | 周期性 **learn-only** / 轻量 observability ingest（对齐 `cron-evolution.example.sh`，把 **`.env` 换为 Secret+ConfigMap envFrom**） |
| **Job** | 单笔 merge 前置 **harness**、冒烟 `release:smoke` |
| **Argo Workflows / Tekton** | 多级 gate：build → deploy staging → smoke → prod；失败 **Slack/Page** |

**密钥**：生产 **RDS/模型 key/仓库 token** 只进 **Kubernetes Secret / 外部 KMS**，不进 Git；CI 可参考 `doc/CI.md`。

---

## 12. Helm values 扩展建议（文本片段）

当前 chart **web 与 daemon 共用 `replicaCount`**（`values.yaml`），与 SQLite 约束冲突。**建议拆分**（以下片段仅供参考，可自行合入 Chart）：

```yaml
# 建议：拆 replicaCount
web:
  replicaCount: 3

daemon:
  replicaCount: 1   # SQLite 模式下保持 1

ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
  hosts:
    - host: agent.example.com
      paths:
        - path: /
          pathType: Prefix
          service: web

persistence:
  enabled: true
  size: 20Gi
  storageClass: fast-ssd
  accessMode: ReadWriteOnce

daemon:
  affinity: {}        # 可填 podAntiAffinity
  topologySpreadConstraints: []
  podDisruptionBudget:
    enabled: false    # 单副本时慎用

web:
  resources:
    requests:
      cpu: 100m
      memory: 256Mi

# Secret 仅存密钥；大批 RAW_AGENT_* 非敏感可用 extraEnvFrom configMapRef
secret:
  create: true
  rawAgentApiKey: ""
  rawAgentBaseUrl: ""
```

**环境变量对齐**：与 `.env.example`、`README` 一致，至少需要模型相关 **`RAW_AGENT_BASE_URL`、`RAW_AGENT_API_KEY`、`RAW_AGENT_MODEL_NAME`** 等部署到 Secret；daemon 继续使用 **`RAW_AGENT_STATE_DIR`**（`/data/state`）。

---

## 13. 小结清单

| 主题 | 本仓库现状 | 云上建议 |
|------|-------------|----------|
| daemon 副本 | Helm 默认为 1，与 SQLite 一致 | **严禁**在多写场景直接 `replicas>1` 共享 SQLite |
| 流式 | HTTP **SSE**，经 Next middleware 代理 | 调 LB/Ingress **超时与缓冲**；广播需 **Redis/NATS/Kafka** |
| 多观众 | **未实现** | broadcaster + 订阅主题 |
| 隔离 | `RAW_AGENT_*` + 规划中多用户模型 | Namespace + NetworkPolicy + 每租户实例或 Postgres |
| 观测 | traces 文件、`/api/traces` | Prom/Loki + SRE domain 工具只读闭环 |
| 自愈/Evolution | API + 脚本 | CronJob / Argo；密钥外置 |

---

**相关文档**：`doc/DEPLOYMENT.md`、`doc/ARCHITECTURE.md`、`doc/MEMORY_MULTIUSER.md`、`doc/HARNESS_EVAL.md`、`doc/DOMAIN_AGENTS.md`、`README.md`。
