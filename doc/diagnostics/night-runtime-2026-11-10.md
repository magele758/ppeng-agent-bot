# 2026-11-10 夜间运行排查

采样窗口：2026-11-10 18:00—2026-11-11 00:31，Asia/Shanghai（UTC 10:00—16:31）。

## 数据与实际版本

- 线上 Lab 23000、daemon 37070；进程 24439 的 cwd 为发布目录 `7bca28c4972bd196546a054e394f8c496330a2ac`，启动于 23:10。不是开发目录的 HEAD。
- lsof 确认 daemon 打开主开发目录 `.agent-state/runtime.sqlite`。只读查询该实时 SQLite，结合 `.agent-state/traces/<sessionId>/events.jsonl`；未把 PG 快照当实时数据。
- 76 个有活动 trace 的会话，1,078 个模型 turn_end、165 个 terminal turn_end。两者分开计数，不能把全部 turn_end 当模型调用数。
- 1,548 个 tool_end，其中 217 个 ok=false。工具失败不等于任务失败，日志可能跨轮/重启，不能按 tool_start 与 tool_end 总量差断言缺结果。
- 48 个例行 occurrence：27 completed、20 silent、1 failed。静默有明确 NO_UPDATE 规则，不能一概补发。

## 确认的问题与证据

### 1. 规划技能把长期会话永久限制成规划工具集

会话 `session_2547a9ae098e422889cf9cfb8c8ec227`：22:00 的 seq 487 加载 Planning 后，技能 Manifest 留在 `metadata.activeSkillManifests`。后续新请求、定时任务沿用同一会话，没有结束该能力边界。00:26 的 context snapshot（turn 622）实际只提供 TodoWrite、search_skills、load_skill、task_create/update/list 六种工具；bash、tool_search 确实不在列表。这不是仅凭模型自述推断。

22:00—00:31 的 trace 记录 load_skill 147 次、TodoWrite 146 次，实际工作没有推进。22:00 的例行 occurrence `routine_run_50b408d87c6c4c988ab5f9c30e1470ec` 于 22:16:44 因 abort 失败。原 trace 第 4841 行记录该取消，第 5631 行记录 00:27:49 的取消；后者由本次排查执行，防止继续空转。保留原始历史。

修复：普通请求确定技能边界的生命周期。新请求释放上一请求加载的限制；同一请求重启、重试、转向不解除限制。旧数据根据实际 load_skill 位置迁移，无法确认加载来源的继承限制保守保留。仍保留同工具波次技能先加载、路径/网络/工具边界的全部拒绝测试。

### 2. 重复检测被关闭，风险提示没有终止空转

00:24 读取的 `loop_settings.repeatGuard` 为 off，更新时间 23:11:01。此前默认 weak 也会豁免强模型的内容重复。risk_advisory 不会替代 LoopGuard 终止；maxTurns=0 的会话因此可以持续重复相同成功的待办/技能结果。

现场处置：00:31:53 使用既有 `PATCH /api/loop/settings` 保存 repeatGuard=all，HTTP 200。没有新增环境变量，也没有更改 off/weak/all 的既有语义。SDK 重复检测回归覆盖 all 模式对强模型的相同工具与证据循环终止。

### 3. 资料采集器因已删除任务提前退出，后续任务长期拿旧资料

本机 `agent-home-workflows/source-errors.log` 持续出现 Missing CubeSandbox 四小时巡检，异常来自 material-source.mjs 的逐项更新。异常后未执行后面的信息流评审资料更新。

证据：20:02 的 `feed-2026-11-10-20.md` 已存在；20:30 的 occurrence `routine_run_642b0aed25d642938d27c268f1ea66d4` 仍收到 08:00 文件，因此按“资料过期输出 NO_UPDATE”的规则静默。其主会话 seq 11 为旧资料输入，seq 12 为 NO_UPDATE。

修复：单个目标更新失败记录到日志并继续。给采集器增加 materials-only 入口，仅修复资料投递，不触发群聊或外部发布。原脚本已备份到本机 verification/night-20261111。00:34 手动通过该入口验证：缺失任务仍被准确报告，但评审资料已更新成 20:00 文件，API 读回一致。仓库 scripts/workflows 保存对应脚本与隔离回归。

### 4. 流式显示依赖正文匹配，无法准确对应每一轮已保存消息

原 omitStreamTextSavedOnTurn 只处理正文，思考和工具片段始终留在流式气泡；下一轮相同正文又会被上一轮内容匹配误删。因而历史刷新能同时产生重复与短暂消失。这是对当前源码的确定性复现，不宣称今晚每次闪动都由它导致。

修复：模型步骤保存后发送 assistant_saved(messageId)，SDK 在步骤提交后发送；参考 kernel 在同步 append 后发送。前端以该消息 ID 去掉已经出现在历史中的正文、思考和工具片段。已保存轮与后续轮分段，即使文字相同也不合并、不误删；重试回退保留已提交轮。连接开始时先声明 durableAssistantIds，重连后的第一轮同样按身份处理；done 只代表模型尝试结束，不能提前充当已保存检查点。旧服务器仍走原来的文字匹配兼容路径。

## 其他发现与边界

- trace 中 19 次 stale_writer_rejected、21 次 cancel：有明确主动取消对应的实例，不能仅凭计数断言数据丢失。未关闭写入者保护，也未强行清理其他会话的锁。
- 6 次 request_over_budget、9 次 compact_skipped 仍需按具体轮次判断，不能将预算保护告警当作已复现的新缺陷。
- 工具错误抽样中包含退出码 1 无输出、网络/命令超时、SOURCE_UNAVAILABLE。无匹配命令与真实操作失败分开；已存在的来源不可用拒绝机制保持原状。
- PM2 聚合日志反复出现 Next ECONNRESET/aborted。该文件混合多进程输出，许多行不带时间，不能严谨归因到某次用户请求；它是传输层线索，尚无证据证明导致全部漏回复。没有屏蔽异常来冒充修复。
- 主工作区另有 session-switch-lag 改动，本次在独立检出实现，没有覆盖那批工作。

## 验证与发布

规格 `night-runtime-reliability`。修复前的新增流式与采集隔离测试失败；修复后通过。技能边界测试覆盖新请求、恢复、转向、旧数据与继承限制。SDK 测试校验 assistant_saved 在提交后发出。浏览器 Chat basics 三项通过，覆盖 SSE 上的持久化身份、即时占位和刷新后保留。

完整测试与最终发布状态以本次 PR 的验证记录及本机发布回执为准；现场已生效的处置仅包括停止 RLM 空转、恢复重复检测、更新采集器与修复评审资料。代码合并或测试通过不能代替确认线上进程版本。
