# DeepResearch

## Implementation status（与代码对齐）

| 能力 | 状态 |
|------|------|
| SQLite `research_*` 表 + `ResearchStore` | 已实现 |
| HTTP `/api/research/*`、`POST /api/research/tasks/:id/run` | 已实现 |
| `ResearchPipeline`（`packages/core/src/deepresearch/pipeline.ts`） | MVP：占位证据/claim，可扩展 web 采集 |
| Builtin `research_start` / `research_status` | 未单独暴露；优先 HTTP / 运行时 `runResearchTask` |

下文为目标产品与未完全落地能力的规划说明。

---

DeepResearch 把「研究阶段是否值得改代码」升级为可复用能力：多源采集、证据归档、引用、反思、报告、转 backlog。

## 目标

1. 支持用户或 Evolution 发起研究任务。
2. 每个结论都有 evidence 与 citation。
3. 研究报告可转化为能力地图 backlog。
4. 可被 Harness 评测引用完整度、来源多样性与结论可靠性。

## 任务模型

```ts
interface ResearchTask {
  id: string;
  query: string;
  scope?: string;
  status: 'pending' | 'searching' | 'extracting' | 'synthesizing' | 'critiquing' | 'completed' | 'failed';
  capabilityTags: string[];
  sources: ResearchSource[];
  claims: ResearchClaim[];
  reportPath?: string;
  createdAt: string;
  updatedAt: string;
}

interface ResearchSource {
  id: string;
  kind: 'web' | 'rss' | 'github' | 'arxiv' | 'local-note' | 'session' | 'trace';
  url?: string;
  title: string;
  fetchedAt: string;
  trustLevel: 'primary' | 'secondary' | 'unknown';
}

interface ResearchEvidence {
  id: string;
  sourceId: string;
  quote: string;
  location?: string;
  relevance: number;
}

interface ResearchClaim {
  id: string;
  text: string;
  confidence: 'low' | 'medium' | 'high';
  evidenceIds: string[];
  caveats?: string[];
}
```

## 研究循环

```
plan
  -> search
  -> extract evidence
  -> synthesize claims
  -> critique gaps
  -> final report
  -> backlog candidates
```

每一步都要有可审计工件：

| 阶段 | 工件 |
|------|------|
| plan | research plan、关键词、源类型 |
| search | source list、失败源、去重结果 |
| extract | evidence JSONL、摘录片段 |
| synthesize | claims、confidence、caveats |
| critique | missing evidence、contradictions |
| report | Markdown + metadata JSON |

## 多源采集

第一批源：

- RSS / `doc/evolution/inbox`
- `web_fetch`
- GitHub issue / PR / release note
- arXiv RSS / abstract
- 本地 notes（`EVOLUTION_LOCAL_SOURCES`）
- 会话历史与 trace

后续再扩展：

- Slack / 飞书文档
- package advisories
- Sentry / Prometheus / Loki
- Benchmark datasets

## 报告格式

建议输出：

```text
doc/research/YYYY-MM-DD-<slug>.md
doc/research/YYYY-MM-DD-<slug>.json
```

Markdown 结构：

```md
# Research: <query>

## Executive summary

## Claims

### Claim 1
- Confidence: high
- Evidence: [E1], [E3]
- Caveats:

## Sources

## Backlog candidates

## Rejected ideas
```

JSON metadata：

```json
{
  "query": "",
  "capabilityTags": [],
  "sourceCount": 0,
  "primarySourceCount": 0,
  "claimCount": 0,
  "lowConfidenceClaims": 0,
  "backlogCandidates": []
}
```

## 与 Evolution 的关系

DeepResearch 不替代 Evolution research gate，而是作为更重的研究路径：

| 场景 | 用轻 research gate | 用 DeepResearch |
|------|-------------------|-----------------|
| 单条 RSS 是否值得做 | 是 | 否 |
| 新领域调研，如 K8s 部署 | 否 | 是 |
| 安全/合规决策 | 否 | 是 |
| 快速 no-op 判断 | 是 | 否 |
| 形成能力路线图 | 否 | 是 |

DeepResearch 输出的 backlog candidate 可进入 `doc/evolution/inbox` 或调度器 run。

## Harness 评测

DeepResearch 必须被 eval 约束：

| 指标 | 检查 |
|------|------|
| citation completeness | 每个关键 claim 至少一个 evidence |
| source diversity | 至少 N 个不同 source kind |
| primary source ratio | 关键决策优先 primary source |
| unsupported claims | 无 evidence 的 claim 标低置信 |
| contradiction handling | 相互冲突 evidence 必须记录 caveat |

第一批 eval：

- `deepresearch-k8s-deploy`
- `deepresearch-agent-memory`
- `deepresearch-mcp-security`
- `deepresearch-agent-eval-harness`

## API / UI 入口建议

短期：

- CLI：`pnpm run start:cli research "<query>"`
- Web：Agent Lab 增加 Research mode 或从 Orchestration run 触发。

长期：

- `POST /api/research/start`
- `GET /api/research/runs`
- `GET /api/research/runs/:id`
- `GET /api/research/runs/:id/report`

## 预算与停止条件

每个 ResearchTask 必须有默认预算：

- `maxSources: 20`：最多采集 20 个源。
- `maxSearchRounds: 3`：plan → search → extract 最多循环 3 次。
- `maxCostUsd: 1.0`：模型调用成本上限（仅统计，第一阶段不自动熔断）。
- `maxDurationMs: 300000`：单次研究最多 5 分钟。

达到任一上限后进入 `critiquing` → `completed`，并在报告中标注"预算内未覆盖的方向"。

## 增量研究

同一主题的后续研究应支持 `continueFrom: previousResearchId`：

- 复用上一次的 sources 和 evidence（不重新抓取已有源）。
- 只搜索新增源或上次标注的"missing evidence"方向。
- 报告中标注"新增 vs 复用"来源。

## 数据存储说明

`ResearchTask.sources` 和 `claims` 在文档中内联是为了设计可读性。落库时应拆为关联表：

```text
research_tasks        -> id, query, status, ...
research_sources      -> id, task_id, kind, url, ...
research_evidence     -> id, source_id, quote, ...
research_claims       -> id, task_id, text, confidence, ...
research_claim_evidence -> claim_id, evidence_id
```

## 风险与边界

- 不允许无引用强结论进入 backlog。
- 抓取失败要记录，不应伪造证据。
- 研究报告与产品决策分离：报告提出候选，调度器决定是否执行。
- 涉及安全、部署、数据删除的建议必须进入人工审批。

