# 多用户有状态对话与记忆规划

当前项目已有 SQLite session、messages、tasks、approvals、mailbox、session memory。下一步目标是把它从“本地单用户有状态 runtime”升级为“多用户、可隔离、可审计、可长期记忆”的 Agent 平台。

## 目标

1. 不同用户/租户的数据隔离。
2. 会话、任务、审批、workspace、memory 都有 owner。
3. 记忆从 session-local 扩展到 user/team/project 多层。
4. 支持语义检索、隐私删除、审计与配额。

## 当前基础

已有：

- `sessions`
- `session_messages`
- `tasks`
- `approvals`
- `mailbox`
- `background_jobs`
- `session_memory`

已有工具：

- `memory_set`
- `memory_get`
- `memory_delete`
- `handoff_state`

缺口（相对完整产品）：

- OIDC 之外的密码登录、审计报表、配额
- 会话默认未绑 owner（未配置 OAuth 时仍是单机共用）

已实现（migration v7+ / v20）：

- `users` / `tenants` / `memberships` 表
- Google / GitHub OAuth（`RAW_AGENT_OAUTH_*`），Lab 登录后会话按 `metadata.userId` 隔离。未设置 `RAW_AGENT_OAUTH_PUBLIC_ORIGIN` 时只接受本机 loopback 登录；公网或反代（非本机 `Host` / `X-Forwarded-Host`）会在启动日志和 `/api/auth/*/start` 报错，要求把该变量设成浏览器打开的 https 源。这两个头不再当作回调来源。
- `agent_memory` 五层 + FTS5（降级 LIKE）
- 对话工具 `memory_set`/`memory_get` 写入 `agent_memory`（`session.scratch`/`session.long`）

## 多用户数据模型

建议先兼容单用户模式，逐步加列。

```text
users
  id
  email
  display_name
  status
  created_at

tenants
  id
  name
  created_at

memberships
  user_id
  tenant_id
  role

audit_events
  id
  tenant_id
  user_id
  action
  resource_type
  resource_id
  metadata_json
  created_at
```

核心表补充：

```text
sessions.user_id
sessions.tenant_id
tasks.user_id
tasks.tenant_id
approvals.user_id
workspaces.user_id
session_memory.user_id
session_memory.tenant_id
```

兼容策略：

- 未配置 auth 时使用 `local-user` / `local-tenant`。
- 旧数据迁移到默认 user/tenant。
- API 查询默认按当前 user/tenant 过滤。

## Auth 与权限

阶段一（本地/私有部署）：

- 支持 `RAW_AGENT_AUTH_TOKEN`。
- 请求头 `Authorization: Bearer <token>`。
- 单租户默认 admin。

阶段二（团队使用）：

- 支持反代注入 header：`X-User-Id`、`X-User-Email`、`X-Tenant-Id`。
- 支持 role：`owner`、`admin`、`member`、`viewer`。

阶段三（产品化）：

- OAuth/OIDC。
- per-user API key。
- 审计报表。

## 记忆分层

| 层级 | 范围 | 用途 | 示例 |
|------|------|------|------|
| `session.scratch` | 当前 session / subagent handoff | 临时上下文 | handoff notes |
| `session.long` | 当前 session 长期 | 该会话长期事实 | 用户本轮目标 |
| `user.memory` | 用户跨 session | 偏好、常用项目、工作方式 | “用户喜欢简洁中文回复” |
| `team.memory` | 租户/团队 | 团队约定、部署环境 | K8s namespace、review 规范 |
| `project.memory` | repo/workspace | 项目事实、架构约束 | Next app router、daemon proxy |

建议 memory 字段：

```text
id
tenant_id
user_id
scope
namespace
key
value
embedding_ref
importance
source
confidence
expires_at
access_count
last_access_at
created_at
updated_at
```

## 语义检索路线

阶段一：SQLite FTS

- 对 memory value 建 FTS。
- 支持关键词检索。
- 无额外向量依赖。

阶段二：Embedding provider 抽象

- `EmbeddingProvider` 接口。
- 支持 openai-compatible embedding。
- memory 写入时异步生成 embedding。

阶段三：Vector store

- SQLite vector extension / LanceDB / pgvector 可选。
- 按 tenant/user/project 过滤。

检索策略：

```text
query
  -> exact key lookup
  -> FTS / vector recall
  -> recency + importance rerank
  -> inject into dynamic context
```

## 隐私与删除

必须支持：

- user memory export
- user memory delete
- tenant delete
- sensitive key denylist
- audit event for memory read/write/delete

敏感数据策略：

- API key、token、cookie 不写 memory。
- 用户可标记“不要记住”。
- 默认只自动写低风险偏好，不自动写凭据或隐私。

## 写入权限（ACL）

| scope | 谁可写 | 谁可读 |
|-------|--------|--------|
| `session.scratch` | 当前 session 的 agent | 当前 session + subagent |
| `session.long` | 当前 session 的 agent | 当前 session |
| `user.memory` | 该 user 的任意 session | 该 user 的任意 session |
| `team.memory` | tenant 内 `admin` 或 `member` | tenant 内所有 member |
| `project.memory` | 有 workspace 写权限的 session | 同 repo 下的 session |

未来如果细化，可在 memory 行上加 `acl_json` 字段（白名单 user/role），第一阶段按上表硬编码。

## 并发冲突

两个 session 同时写同一个 key：

- 策略：**last-write-wins**（SQLite upsert 天然行为）。
- 若需要合并语义（如列表追加而非覆盖），由 Agent 在写入前先 `memory_get` → 合并 → `memory_set`，不在存储层做自动合并。

## embedding scope 策略

- `session.scratch`：**不做** embedding（生命周期短、量大、无跨 session 检索需求）。
- `session.long`：不做 embedding（仅当前 session 可见，精确 key 查找足够）。
- `user.memory`、`team.memory`、`project.memory`：**异步生成** embedding，用于语义检索。

## 容量上限与清理

- 每个 scope 有默认上限：`session.scratch` 200 条、`session.long` 500 条、`user.memory` 5000 条、`team.memory` 2000 条、`project.memory` 5000 条。
- 超限时按 `importance * recency` 排序，淘汰最低分条目。
- 可选 TTL：`expires_at` 非空的条目到期自动清理（由 daemon scheduler 定期扫描）。
- 定期合并：importance 相近且 key 相似的条目可由 Agent 主动合并（`mergedFrom` 字段记录来源）。

## 与 Agent loop 的关系

- SubAgent 默认只复制 `session.scratch`，不复制全量 long memory。
- Teammate 可按 task 读取必要 team/project memory。
- DeepResearch 可把经过引用验证的事实写入 project memory。
- Evolution 可把稳定项目事实写入 project memory 或 `AGENTS.md`。

## 验收用例

| 用例 | 预期 |
|------|------|
| 两用户创建 session | 互相不可见 |
| user memory 写入 | 同一用户新 session 可检索 |
| team memory 写入 | 同 tenant member 可见 |
| project memory 写入 | 同 repo 可检索 |
| delete user memory | 后续检索不返回 |
| sensitive value 写入 | 被拒绝或脱敏 |
| subagent handoff | 只复制 scratch |

