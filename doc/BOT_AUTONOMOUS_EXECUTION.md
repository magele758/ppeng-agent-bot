# Bot 自动执行能力

Bot 对话保持长期身份，用户只描述目标和约束，无需选择旧会话的执行模式、Agent 或编排引擎。执行决策由目标路由与 Bot 的 `goal_dispatch` 工具完成。

## 执行路径

| 工作 | 执行路径 |
| --- | --- |
| 普通问答 | 原会话直接回答 |
| 研究、浏览器、电脑操作 | 自动匹配任务 profile，检查实际可用工具 |
| 批量工作 | PTC；不可用时只在可满足任务要求时采用可用替代方式 |
| 有依赖任务、多角色流水线 | Team DAG、Swarm |
| 规划、实现、评估 | 原有 planner、generator、evaluator；研究可用 researcher |
| 原会话 Orchestrator | 原有 main Agent，运行于保留 Bot 身份和权限的独立执行会话 |
| 自愈 | 原 SelfHealScheduler 的测试、修复、工作区生命周期 |
| 工厂只读工作 | 原 factory_dispatch |
| 已授权工厂开发 | 原 FactoryDevelopment，保留已批准标准、基线和开发授权检查 |

Bot 可以通过工具参数选择下一阶段的工作类型和专业角色。这些参数面向模型，不新增用户模式选择器。目标的约束、已有成果、完成条件和进度随执行传递；外部结果返回后先检查证据，不把“已启动”当作“已完成”。

## 权限与生命周期

- 专用流程的启动经过现有工具审批网关。自愈和工厂开发仍需必要审批；不会替用户批准标准或扩张权限。
- 自愈根据任务选择既有测试预设（默认单元测试），保留 Bot 的工具、技能、模型和权限限制，默认不合并、不推送、不重启、不预授权外部 CLI。
- 工厂开发只对已有机器授权、开发授权和已批准标准开放；缺少目标或精确基线时需要补充任务信息，无需配置执行模式。
- 执行引用持久保存。目标可查看实际专用流程状态；取消或修改约束会停止原执行，再核对已有产出。
- 已发出的工厂只读远程请求不能强制中断时，目标保持收尾状态，不继续派发工作。自愈正在执行测试命令时同样等待在途步骤收尾，迟到结果不会重新启动已取消目标。
- 自愈 worker 费用计入目标预算；取消或预算阻塞后，后台自愈不能继续推进。

## 当前产品边界

Evolution 当前由已有产品级常量关闭，daemon 也没有 Evolution 启动器。本次不改变这个产品状态。Bot 对此明确报告不可用，不静默回退为普通聊天。工厂发布、合并等既有授权要求继续有效，自动选择执行方式不等于自动授予发布权限。

## 验证

验收规格：`acceptance/bot-autonomous-execution-coverage.yaml`。

测试包含纯路由、真实 SQLite/Runtime 的专业 Agent 分派、审批恢复、自愈真实任务创建、约束修订、取消与迟到结果，以及工厂实际开发服务的授权、去重与取消。模型回合和远程工厂传输使用测试替身，不等同于真实模型质量或远程机器现场验收。

```sh
pnpm exec tsc -b packages/core
node --test packages/core/test/bot-autonomous*.test.js packages/core/test/bot-goal*.test.js packages/core/test/factory*.test.js packages/core/test/self-heal*.test.js
pnpm run test:acceptance
```

### 真实模型 HTTP 验收

`node scripts/bot-live/autonomous-http.mjs` 读取本机既有模型连接配置，使用真实模型适配器、daemon HTTP 路由、真实 Runtime/SQLite 和本地文件工具。测试仓库、状态库与生产会话隔离，不使用 heuristic 或脚本化模型回复。可加 `file|planner|approval|cancel|amend` 单独复跑场景。脚本会产生模型调用费用，完成后输出保留的 `report.json` 路径；断言失败时退出码为 1。

场景覆盖：直接读写并校验文件、原 planner 实际调度、正常审批前禁止写入/批准后执行、运行中取消、中途追加约束后按同一目标的新修订继续。取消和修订均额外等待 32 秒，检查原延迟命令没有覆盖最终状态。真实远程工厂、桌面/浏览器和 Evolution 不属于此脚本的现场验证范围。

真实测试驱动的回归修复：

- 已选择专业执行方式但未实际分派时，不允许仅凭文字结果把目标标为完成；等待子执行时交回调度器。
- 普通工作末尾的“验证结果”不再误判为独立 evaluator 任务；模型仍能按任务需要显式选择专业角色。
- 后台命令结果通过持久化收件箱回流，不携带已经结束的会话写入租约；空闲回合的后台命令也能被取消。
- TodoWrite 的模型可见参数声明补齐 content/status/activeForm，与执行时的校验一致。
