# Jev 接入指南

返回 [中文首页](../README.zh.md) · [Documentation index](README.md) · [Harness 治理](harness/16-runtime-governance.md)

## 实现状态与定位

本文按 2026-10-08 仓库源码核对，说明本项目的接入方式，不替代 Jev 服务端协议文档。

| 能力 | Implementation status |
|------|-----------------------|
| Lab 配置、持久化、连通性探测 | 已实现，默认关闭 |
| 目标判断、工具闸、上下文/候选选择、恢复决策 | 已通过产品宿主接线；需启用相应切入点并满足触发条件 |
| PTC `jev.noul` / `jev.choice` | 已实现，custom 的 `ptcDecide` 启用后由宿主注入 |
| `sagaGate` | 仅提供辅助函数；产品编排器尚无离散选项调用路径，勾选不会触发主循环请求 |
| `jev_call` 与 Langfuse 映射 | 已实现；Langfuse 需单独配置 |

Jev 是产品宿主可选的语义判断服务：通过 `noul` 数值判断与 `choice` 离散选择参与已有决策点，不替代主对话模型，也不是工具授权或沙箱的替代品。

```text
Lab「更多 → Jev」→ daemon_control KV：jev_settings
                            ↓
core 宿主在启用的决策点调用 askJev
                            ↓
                    /predict 或 /systemone
                            ↓
          有效判断 → 对应决策；失败 → 各切入点原有路径
```

HTTP 客户端留在 `packages/core/src/jev`；SDK 通过宿主端口接入，不静态依赖 Jev 客户端。浏览器 `/mini` 的无 Node 静态依赖边界不因此改变。相关 SDK 契约见 [agent-loop 指南](../skills/agent-loop/SKILL.md)。

## 1. 从 Lab 配置

1. 启动 Lab，打开「更多 → Jev」。
2. 填写服务入口 Base URL、按服务需要填写 API Key，模型默认 `jev-latest`。
3. 保存入口，并使用连通性探测验证。探测也可以使用表单里的未保存值；**探测不会保存配置或启用链路**。
4. 选择 profile，或选择 custom 后勾选具体切入点。
5. 查看当前生效的 `activePoints`，再运行满足触发条件的会话并检查 trace。

配置保存在 SQLite 的 `daemon_control` KV（键 `jev_settings`）。保存无需重启；后续切入点解析配置时使用新值，不会撤回已经发出的请求。不要为 Jev 新增 `RAW_AGENT_*` 功能开关。

### 两套档位不要混淆

| 配置 | 管理什么 | 持久化/API |
|------|----------|------------|
| Agent Loop `assemblyPreset` | SDK 装配哪些循环模块；产品默认 max | `loop_settings` / `/api/loop/settings` |
| Jev `profile` | 产品宿主在哪些位置请求 Jev；默认 off | `jev_settings` / `/api/jev/settings` |

修改 Jev profile 不改变 kernel 或 assemblyPreset；Loop 选 max 也不会自动启用 Jev。

| Jev profile | 生效的切入点 |
|-------------|--------------|
| `off` | 无 |
| `mini` | 无，不插入 Jev |
| `normal` | `goalGate` |
| `full` | `goalGate`、`toolGate` |
| `max` | `goalGate`、`toolGate`、`compact`、`route` |
| `custom` | 仅使用 `points` 勾选项，可以选择全部 12 个 ID；实际执行还受接线与触发条件约束 |

没有保存 Base URL 时，所有 profile 都不接入。预设忽略 custom 勾选项，但保留勾选状态以便切回。**max 不等于开启全部 12 个切入点。**

## 2. 十二个切入点

以下说明产品宿主中的接线与边界；启用不代表每轮必定调用。

| ID | 介入位置与行为 | 边界/回退 |
|----|----------------|-----------|
| `goalGate` | 活跃 Goal Gate 的完成判官；`met` 分数 ≥ 0.8 判定满足 | 无有效分数时回退原 `completeText` 判官；仅勾选不会创建目标 |
| `toolGate` | 对 `bash`、`claude_code`、`codex_exec`、`cursor_agent` 请求 allow/ask/deny | 置信度 < 0.7 或无有效判断则继续原管线；不取代原审批/沙箱 |
| `compact` | 对最多 4 个成功且长度 ≥ 1500 字符的工具结果判断是否仍需保留；分数 < 0.2 时缩为前 400 字符加标记 | 只改送模视图，不删除 transcript；不是 autoCompact 的替代实现 |
| `route` | 模型无工具调用的软停止边界，判断 retry / need_tools / done，阈值 0.75 | 优先继续信号；同时启用 `goalGate` 时不采纳 route 的 done |
| `contextSelect` | 送模视图中筛选较早上下文片段，在 Jev compact 之前执行 | 保护近期尾部，含候选上限与较早溢出片段处理；不等于每段历史都会送去评分 |
| `toolSelect` | 权限白名单之后，缩小本轮工具候选集 | 不扩大授权集合；候选不足或筛选为空时保留原集合 |
| `skillSelect` | 在已有 Skill shortlist 上做相关性筛选 | 不负责技能发现，也不绕过路由/加载限制 |
| `memorySelect` | 上下文附录编译时筛选记忆候选项 | 无有效筛选则保留原候选，不删除持久化记忆 |
| `recoveryChoice` | 在宿主提供的既有离散恢复动作中择一 | 候选不足、无效或未知 ID 回退默认动作；不能创造任意恢复指令 |
| `preTurn` | 主模型调用前，判断已有结构化目标是否已满足 | 无活跃目标不跳过；有待处理工具调用时不介入；启用 `goalGate` 时不抢占完成判断 |
| `sagaGate` | 辅助函数可在至少两个既有离散选项中决策是否需要深模型规划 | **尚未接入产品编排器**；不会生成自由文本计划，也不会因勾选就发请求 |
| `ptcDecide` | 给 `ptc_exec` cell 注入 `jev.noul` / `jev.choice` | 仅 custom 可启用；还需 PTC 工具本身可用；未启用则不注入全局 `jev` |

`toolGate` 的 deny 会为本批全部调用写配对失败结果，包括被连带跳过的同批非风险调用；ask 为首个风险调用创建审批并挂起。恢复这条波次时，如果该调用已有批准或拒绝结果，沿用该结果，不再新建审批；拒绝且本波还没有失败结果时，补一条失败结果后继续其余调用。其网络失败回退是“继续原管线”，**不是 fail-closed 的安全保证**。

## 3. HTTP 配置与协议

接口定义见 [`routes/jev.ts`](../apps/daemon/src/routes/jev.ts)。下列 JSON 是请求体示例，需发送到实际 daemon 地址；设置了 daemon auth token 时按常规携带 Bearer 鉴权，勿把真实密钥写进文档或提交到 Git。

| 方法与路径 | 用途 |
|------------|------|
| `GET /api/jev/settings` | 返回公开配置、activePoints、profilePresets、catalog 和配置来源；不返回 API Key 明文 |
| `PATCH /api/jev/settings` | 局部更新并持久化，返回公开配置 |
| `POST /api/jev/probe` | 合并请求里的入口/密钥/模型与已保存值进行探测，返回 `ok`；不写配置、不启用 profile |

保存本地服务入口，先保持关闭（端口 8000 仅为示例，服务需自行运行）：

```json
{"baseUrl":"http://127.0.0.1:8000/predict","model":"jev-latest","profile":"off"}
```

用 `POST /api/jev/probe` 与请求体 `{}` 检查已保存入口；随后按需 PATCH：

```json
{"profile":"custom","points":{"toolSelect":true,"ptcDecide":true}}
```

PATCH `points` 是合并操作：上例不会关闭之前已开启的其他 custom 项。需要精确集合时，也应把不需要的项显式设为 false，或在 UI 中取消。关闭链路用 `{"profile":"off"}`，不必删除入口。

### 读取有效状态

- `configured`：仅表示存在 Base URL，不代表连接成功。
- `activePoints` / `chained`：表示配置允许的切入点及是否非空，不代表会话已触发调用。
- `apiKeySet`：已存密钥或可用的环境密钥回退，不验证其有效性。
- `effective.source`：`ui` 表示已有持久化 KV（也可能由 API 保存），否则 `default`。
- 优先使用 `profile` / `points` / `activePoints`；`enabled` / `modules` 是兼容字段，不能仅凭 `enabled=true` 判断会发请求（mini 即可为 true 但无 activePoints）。

API Key 留空或不传保持原值；`{"clearApiKey":true}` 清除已保存密钥。密钥解析顺序为：已保存值 → `TYPESAFE_API_KEY` → `TYPESAFE_AI_API_KEY` → `JEV_API_KEY`。因此清除已存密钥不一定移除环境回退；停用应选择 off。仅设置环境密钥不会自动接入循环。

### 上游地址选择

本仓库客户端不是 chat/completions 客户端，规则见 [`client.ts`](../packages/core/src/jev/client.ts)：

| Base URL | 请求目标与请求体 |
|----------|------------------|
| 已以 `/predict` 结尾 | 使用原地址，不发送 `model` |
| 已以 `/systemone` 结尾 | 使用原地址，发送 `model` |
| 其他入口，无有效密钥 | 追加 `/predict`，不发送 `model` |
| 其他入口，有有效密钥 | 追加 `/systemone`，发送 `model` |

有密钥时携带 `Authorization: Bearer`，包括显式 `/predict` 地址。希望地址选择不受密钥回退影响时，填写完整端点。请求为 POST JSON，包含 `state` 和按 ID 组织的 `questions`（`noul` 或带 `criteria` 的 `choice`）；响应读取顶层 `answers` 或 `result.answers`。

## 4. PTC 中使用

先确认 `ptc_exec` 可用，再保存 Jev 入口、选择 custom 并开启 `ptcDecide`。这是 PTC cell 内的片段，不是普通 Node 脚本：

```js
if (typeof jev === 'undefined') {
  return { needsFallback: true, reason: 'Jev 未注入' };
}
const decision = await jev.choice(
  '当前信息不足以得出结论，应继续收集证据还是生成摘要？',
  { collect: '继续收集证据', summarize: '生成摘要' }
);
if (!decision || decision.p < 0.8) {
  return { needsFallback: true };
}
return { next: decision.value, confidence: decision.p };
```

这里 0.8 是示例调用方阈值，不是 choice API 的固定阈值。返回 `needsFallback` 也不会自动调用主模型，后续处理由 cell/宿主流程决定。

- `jev.noul(instructions)` → `{ value: boolean, p: number } | null`，布尔值按 `p >= 0.5` 生成。
- `jev.choice(instructions, options)` → `{ value: string, p: number } | null`；options 支持字符串数组或 ID→说明对象，最多取前 8 项，不足 2 项返回 null。
- 空输入、请求失败、无有效回答等返回 null；choice 校验结果必须属于候选 ID。
- 密钥由宿主持有，不暴露给 cell；判断所需事实要包含在 instructions 中，不会自动把全部会话上下文传给这两个函数。

## 5. 回退、数据边界与观测

没有入口/有效切入点时不请求。HTTP 非成功状态、网络或 JSON 解析异常使客户端返回 null；空 answers 记录失败，各切入点按自己的规则处理。未传 signal 时使用 8 秒超时；传入 signal 时使用调用方 signal，**不会再叠加默认 8 秒超时**。

Jev 会收到对应切入点选取的任务、上下文、工具参数或候选摘要。客户端将 `state` 截到 24,000 字符；这不是脱敏，也不是完整请求大小上限（questions 另行发送）。只连接可信服务，部署前评估外发数据范围。

会话运行通过 `runWithJevTrace` 绑定 trace 上下文。实际调用记录 `jev_call`：切入点、起止时间、耗时、ok/error、问题摘要与回答分数/选项。问题 instructions 最多保留 240 字符，trace 不记录完整 state；摘要仍可能含业务内容。探测 API 没有会话 trace 绑定，不应期待它出现在某个会话轨迹中。

独立启用 Langfuse 后，宿主将 `jev_call` 映射为当前 turn 下的 `jev.<point>` span。未触发请求的切入点不会产生占位 span。`ok=true` 只说明传输取得非空 answers，不证明对应判断被业务采纳；需结合后续 goal/tool/recovery 事件查看。

| 现象 | 优先检查 |
|------|----------|
| 探测通过但对话无 Jev 请求 | profile 是否 off/mini、activePoints、是否命中触发条件；sagaGate 尚未接线 |
| max 下没有 PTC/记忆选择 | 这些是 custom-only；max 只有四个预设点 |
| 明明选择了 Jev 仍调用主模型 | Jev 不替代主模型；可能正常继续或命中回退 |
| `/predict` 与 `/systemone` 选错 | 检查完整 URL 和有效密钥，包括环境回退 |
| PTC 报 jev 未定义 | 检查 custom + ptcDecide、入口与工具可用性；未启用本来就不注入 |
| trace 有调用，Langfuse 没有 | 检查独立 Langfuse 配置和上报链路 |

## 6. 源码与验证入口

| 内容 | 入口 |
|------|------|
| 配置、预设、密钥回退 | [`jev/settings.ts`](../packages/core/src/jev/settings.ts) |
| 请求与 trace | [`jev/client.ts`](../packages/core/src/jev/client.ts) |
| 切入点与阈值 | [`jev/apply.ts`](../packages/core/src/jev/apply.ts)、[`jev/points/`](../packages/core/src/jev/points/) |
| SDK 宿主接线 | [`runtime/l5-bindings.ts`](../packages/core/src/runtime/l5-bindings.ts) |
| PTC 注入 | [`runtime.ts`](../packages/core/src/runtime.ts)、[`ptc-decide.ts`](../packages/core/src/jev/points/ptc-decide.ts) |
| Lab 界面 | [`JevSettingsCard.tsx`](../apps/web-console/components/JevSettingsCard.tsx) |
| Langfuse 映射 | [`langfuse/settings.ts`](../packages/core/src/langfuse/settings.ts) |

构建后运行现有定向测试（mock 请求，不验证真实服务连通性）：

```bash
pnpm exec tsc -b packages/core
node --experimental-strip-types --test packages/core/test/jev-settings.test.js packages/core/test/jev-points.test.js packages/core/test/jev-trace.test.js packages/core/test/langfuse-settings.test.js
```

真实服务验证应另用 Lab probe，再检查一条满足条件的会话 trace。不能用 mock 单测通过推断真实服务可用、延迟收益或判断准确率。
