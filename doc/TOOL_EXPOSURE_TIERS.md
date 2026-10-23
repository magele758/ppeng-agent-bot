# 三层工具暴露方案（已确认）

本清单以 2026-10-21 本机桌面应用 /api/tools 返回的 141 个已注册工具为基线；不是所有安装的固定总数。当前最近活跃的「小卡拉」会话上下文预览含 135 个工具，约 14,826 tokens。别名分别计数，本轮不删除或合并工具。

## 排查结论

- 能力发现已保存为关闭，effective.source=ui，设置确实生效。该开关控制外部能力注册表与网络探查，不是工具暴露模式。
- 当前缺少的六个：web_search（没有有效搜索模板时隐藏）；ask_bot_help（仅子 Agent）；ptc_exec（仅指定 PTC 引擎）；save_as_tool / propose_tool / search_dyn_tools（动态工具关闭）。前述原因分别由运行时代码和动态工具设置核对；不是六个都被按需加载隐藏。
- 所有 on_demand 工具仍按需隐藏，与能力发现开关无关。领域工具搜索和按名称加载故意允许在能力发现关闭时使用；能力卡按 id 加载则被拒绝。
- 因而关闭开关不等于全量加载，不能把本应禁止/不适用的六个工具强行加入。真实问题是开关语义混用与缺少独立暴露模式。
- 存在已批准标准冲突：discovery-default-on AC-2/AC-4 要求关闭时拒绝 tool_search，但 deferred-tool-load 测试明确在关闭状态允许搜索领域工具。现有测试各测一条路径，未消除契约冲突。necessary-tool-injection 又要求未禁用的领域能力可被后续发现。

## 已确认的行为

- 独立设置「工具提供方式」：渐进加载 / 全量可用工具；能力发现明确为「外部服务发现」，不再冒充工具搜索总开关。已有关闭值保留，不自动开启探查。
- 建议未设置过提供方式的用户默认渐进加载；现有会话继承该默认。保存后下一次模型请求生效，不重启，不新增环境变量。用户已于 2026-10-21 确认该默认和迁移行为。
- 全量指当前 Agent/会话已授权、配置可用、模式允许的全部已注册工具；不是无条件暴露整个目录，也不安装未启用插件。全量模式不需要 tool_search/load_capability_tool，二者可从新请求撤下。
- 渐进模式第一层常驻；第二、三层默认只提供简短能力分类目录，无完整参数定义。用户可给具体 Agent 固定启用能力包；固定启用不等于授权。
- tool_search 搜索成功后自动加载最多 5 个匹配工具，明确返回本次加载清单；下一轮直接调用，不要求再调用 load_capability_tool。已知名称仍可通过后者直接加载，保留兼容。只加载不执行。
- 已加载工具在当前会话及应用重启后复用，直到用户禁用、修改权限或清除会话加载记录；新会话不继承临时加载。固定能力包跨会话生效。
- 界面展示已注册、当前可用、已提供、待加载、不可用数量及原因，展示当前模式；这些计数只作工具可见性观测。
- 新注册但未分类的工具显示在第三层「未分类扩展」，可搜索；不默认常驻，也不静默丢失。

## 141 个工具逐项归属

2026-10-23 任务协作增补：`room_route_turn` 注册为第一层计划工具，原 141 项不变，分类总数变为 51 / 23 / 68。该工具仅在群聊上下文保留，仍受显式工具白名单约束；普通会话不会看到它。

### 第一层：日常常驻（50 个）

| 能力组 | 工具 |
|---|---|
| 文件与工作区 | `read_file`、`write_file`、`edit_file`、`grep_files`、`glob_files`、`workspace_list` |
| 执行与产物 | `bash`、`bg_run`、`bg_check`、`work_evidence`、`spill_tool_result`、`retrieve_tool_result`、`read_artifact_page`、`search_artifact_content` |
| 网络与视觉读取 | `web_search`、`web_fetch`、`vision_analyze` |
| 记忆与上下文 | `memory_set`、`memory_get`、`memory_search`、`memory_read`、`memory_delete`、`memory_prefetch`、`save_user_info`、`handoff_state`、`record_summary`、`compact_context`、`history_search`、`history_read` |
| 计划、进度与用户交互 | `TodoWrite`、`submit_plan`、`request_confirmation`、`confirm_plan`、`start_step`、`complete_step`、`fail_step`、`ask_user`、`task_create`、`task_get`、`task_update`、`task_list`、`goal_checkpoint` |
| 技能与工具发现 | `search_skills`、`load_skill`、`tool_search`、`load_capability_tool` |
| 已有 Bot 的查找与通信 | `bot_list`、`bot_get`、`message_agent`、`ask_bot_help` |

### 第二层：工作能力包（23 个）

| 能力组 | 工具 |
|---|---|
| 本机应用操作 | `app_activate`、`app_type_text`、`app_keystroke` |
| 电脑操作 | `lcu_js`、`lcu_js_reset` |
| 团队协作 | `spawn_subagent`、`spawn_teammate`、`list_team`、`send_message`、`read_inbox`、`bot_team_status`、`bot_delegate`、`bot_task_results` |
| 定时与发布 | `cron_create`、`cron_list`、`cron_remove`、`cron_run_now`、`cron_runs`、`schedule_social_post` |
| 专业开发执行 | `lsp_request`、`harness_write_spec`、`ptc_exec` |
| 凭据收集 | `collect_credentials` |

### 第三层：专项与管理能力（68 个）

| 能力组 | 工具 |
|---|---|
| 动态工具与技能管理 | `save_as_tool`、`propose_tool`、`search_dyn_tools`、`skill_manage`、`skill_propose` |
| 工厂 | `factory_dispatch`、`factory_status`、`factory_settings_save`、`factory_patrol_set`、`factory_list_repos` |
| Bot 配置 | `bot_create`、`create_bot`、`bot_update`、`bot_open`、`bot_work_control_set`、`bot_shared_context_get`、`bot_shared_context_set` |
| 群聊管理与操作 | `bot_room_list`、`bot_room_get`、`bot_room_create`、`create_room`、`bot_room_update`、`bot_room_add_member`、`bot_room_remove_member`、`bot_room_delete`、`bot_room_messages`、`bot_room_post`、`bot_room_stop`、`bot_room_resume` |
| Bot 分组管理 | `bot_group_list`、`bot_group_create`、`bot_group_rename`、`bot_group_delete`、`bot_group_assign` |
| Lab 会话管理 | `lab_session_list`、`lab_session_create`、`lab_session_update`、`lab_session_delete` |
| Lab 设置与模型管理 | `lab_settings_list`、`lab_settings_get`、`lab_settings_update`、`lab_model_providers_list`、`lab_model_provider_upsert`、`lab_model_provider_delete`、`lab_model_default_set` |
| 项目与目标管理 | `lab_project_list`、`lab_project_create`、`lab_project_update`、`lab_project_delete`、`lab_goal_upsert`、`lab_goal_list`、`goal_dispatch` |
| 团队计划与 Swarm 管理 | `lab_team_plan_list`、`lab_team_plan_get`、`lab_team_plan_create`、`lab_team_plan_start`、`lab_team_plan_resume`、`lab_swarm_run_list`、`lab_swarm_run_create`、`lab_swarm_run_start` |
| 研究与编排管理 | `lab_research_task_list`、`lab_research_task_create`、`lab_research_task_update`、`lab_orchestration_run_list`、`lab_orchestration_run_create`、`lab_orchestration_run_status` |
| 外部服务发现 | `tailscale_list_devices`、`tailscale_get_device` |

## 未注册到本机目录的扩展规则

这些不计入 141 个，但规定未来注册后的默认归属：

- 第二层浏览器：browser_navigate、browser_snapshot、browser_screenshot、browser_click、browser_type。
- 第二层外部编程助手：claude_code、codex_exec、cursor_agent。
- 第三层股票：quote_get、fundamentals_get、news_search；SRE：prom_query、loki_query、k8s_get、pagerduty_list；Tailscale 运维：tailscale_ping（及安装实际提供的其他运维工具）。
- 专用 Agent 可以固定相关能力包；任何包都不能绕过功能开关、白名单、审批或沙箱。

## 已确认并同步的旧标准调整

用户于 2026-10-21 确认以下语义变更；实施已同步更新旧标准并保留追溯：

- discovery-default-on AC-2/AC-4：关闭只拒绝外部服务发现；已授权本地工具的搜索/加载由工具提供方式管理。其他默认/持久化要求保留。
- necessary-tool-injection AC-1：不注入无关领域完整定义适用于渐进模式且未固定对应包；显式全量模式是用户选择的例外。AC-2 至 AC-6 的可达性和禁用/白名单约束保留。

关联验收：`acceptance/tool-exposure-tiers.yaml`。

## 实施接入

Lab 设置 → 工具与技能 → 工具提供方式。支持全量/渐进、Agent 固定包、会话可用性明细和清除临时加载。配置保存在当前应用状态目录；无需环境变量。

明确的工具提供策略优先于旧 Jev toolSelect 二次缩减；本地两套内核和上下文预览均不再为工具名单另发一次 Jev 请求。其他 Jev 插入点保持有效。

形式验证夹具显式选择全量模式以维持既有工具、审批、取消、重启及并发场景；渐进加载另由真实 Agent 循环和新验收测试覆盖。

## 2026-10-21 实施验证

- 先观察失败：新核心用例首跑 9 失败、2 通过；界面/API 首跑因路由不存在返回 404。后续补充白名单不等于固定包、禁用能力不可搜索、Jev 不二次缩减的失败用例后实现。
- 最终相关回归：213 项通过；提示词、运行档位、可选工具组补充回归 66 项通过。
- 浏览器验收：3 项通过，覆盖中英说明、模式持久化、会话明细与清除、固定包保存及非法配置拒绝。
- Core/daemon TypeScript 构建及 Next 生产构建通过。
- Quick gate 通过；`pnpm run test:acceptance` 静态追踪门禁通过，965/965 条受门禁约束的标准均有测试关联。此统计不代表运行了全仓全部测试。
- `pnpm run test:concurrency` 通过：7,062 个模型状态、15,884 次迁移、62 个真实多进程场景；重启、生命周期、工具配对及源码故障注入通过，源码映射复核通过。详细报告在 `coverage/formal/concurrency/report.md`。
- 本次未运行完整发布/部署门禁，也未更新正在运行的桌面应用。实现位于 `codex/tool-exposure-tiers` 独立工作树。
