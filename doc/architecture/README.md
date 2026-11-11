# 项目架构图稿

基于 2026-11-11 当前源码与本次质量门禁实现整理。图表示模块与调用关系，不表示所有能力已经通过生产现场认证。

- [可编辑 Excalidraw 文件](project-architecture.excalidraw)：导入 Excalidraw 后有 8 个可分别选择的 Frame，方框、文字、箭头均可编辑。
- [整图 SVG](project-architecture.svg)：可放大、检索文字；[总览预览](01.svg)。
- [源码索引](sources.json)：每个节点对应的真实路径；框本身也带源码链接。
- 更新方式：在仓库根目录执行 `node scripts/architecture/generate-project-map.mjs`。生成器会核对路径存在与 core 模块族覆盖。

## 分区

- [01 项目总览 · 产品入口与执行主干](01.svg)：从用户消息到实际工具，再回到持久记录
- [02 单次执行 · Turn Kernel 与上下文循环](02.svg)：工具完成后继续模型循环；结束结果与目标验收分开
- [03 协作与调度 · 多种执行粒度](03.svg)：多个 session 可以协作；各模块的生命周期和验收边界独立
- [04 工具与安全 · 发现、授权、执行、回流](04.svg)：外部内容是证据；工具可见、获准、执行成功是三个不同事实
- [05 知识与状态 · 模型视图不等于存储真相](05.svg)：保存原始记录；压缩与检索构造每次模型看到的有限视图
- [06 部署与持久化 · 当前边界](06.svg)：绿色=当前默认路径；黄色=可选或局部能力；虚线不代表现场认证
- [07 包与扩展 · 产品组合边界](07.svg)：SDK、产品宿主、领域能力与接入层各有职责
- [08 验证与交付 · 成功必须有证据](08.svg)：软件通过、真实模型样本、部署认证分开记录

## 阅读边界

1. 总览是分层地图，不是一条把所有模块依次调用的执行序列。每区箭头表示标注的调用、数据或约束接缝，跨区细节由源码索引展开。
2. Loop 的正常答复、session 结束、Goal 达成、Swarm 验收通过和外部交付完成是不同状态。
3. 持久等待与限定重启恢复已有实现；未知外部副作用不会因为 EventLog / Saga 命名而自动获得恰好一次或自动补偿保证。
4. Swarm 当前只支持 pipeline；Team DAG 是独立执行器，不能把它的能力算作 Swarm 的其他策略。
5. SQLite 仍为主运行状态；PG / Redis / S3 是局部可选端口，Helm 模板不代表完整多 Pod 会话接管已经跑通。
6. 研究、JEV、Factory、领域包与部署各自有授权和验收范围；单个真实模型任务通过不代表长期成功率或生产发布已认证。
7. 图按架构模块族组织，完整覆盖 apps、packages 和 core 的目录级模块；不逐个绘制所有函数与 API。

## core 模块族完整索引

| 模块 | 图中分区 |
|---|---|
| `a2ui` | 05 |
| `agent-inbox` | 02 / 03 |
| `agents` | 07 |
| `app-control` | 07 |
| `approval` | 01 / 04 |
| `artifact` | 04 / 05 |
| `auth` | 01 |
| `bots` | 01 / 02 / 03 / 05 |
| `channels` | 01 / 07 |
| `computer-use` | 01 / 04 |
| `config` | 01 |
| `connectors` | 01 / 07 |
| `cron` | 01 / 03 |
| `daydream` | 05 |
| `deepresearch` | 07 |
| `discovery` | 04 |
| `doctor` | 06 |
| `dyn-tools` | 04 |
| `evolution` | 07 |
| `evolving` | 05 |
| `exports` | 07 |
| `extensions` | 04 / 07 |
| `external-agents` | 04 / 07 |
| `factory` | 01 / 03 |
| `formal` | 08 |
| `goal` | 02 |
| `hooks` | 07 |
| `ingestion` | 05 |
| `jev` | 07 |
| `knowledge` | 05 |
| `langfuse` | 06 |
| `learning` | 04 / 05 |
| `library` | 05 |
| `mcp` | 01 / 04 / 07 |
| `memory` | 05 |
| `model` | 02 |
| `net` | 04 |
| `observability` | 04 / 06 |
| `orchestrator` | 01 / 03 |
| `plugins` | 04 / 07 |
| `ptc` | 04 |
| `quality` | 03 |
| `recovery` | 02 |
| `registered-machines` | 01 / 03 / 06 |
| `rooms` | 01 / 03 |
| `runtime` | 01 / 02 / 03 / 04 / 08 |
| `safety` | 04 |
| `sandbox` | 04 / 06 |
| `secrets` | 04 |
| `self-heal` | 08 |
| `services` | 03 / 05 |
| `session` | 02 / 03 / 05 |
| `skill-proposals` | 04 |
| `skills` | 04 |
| `storage` | 06 |
| `stores` | 02 / 05 / 06 |
| `streaming` | 02 |
| `swarm` | 01 / 03 |
| `teams` | 01 / 03 |
| `tools` | 01 / 04 / 05 |
| `trust` | 04 |
| `turn` | 04 |
| `waits` | 01 / 03 |
| `workspace` | 01 / 06 |

文件格式依据：[Excalidraw 官方 JSON Schema](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/codebase/json-schema.mdx)。
