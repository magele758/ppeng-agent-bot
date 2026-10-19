# 第三阶段验证与审查记录

日期：2026-10-19。工作分支：`codex/multi-machine-controlled-delivery`，基于 `origin/main` 的 `16f1964078f6d42c748813db20bfd1d6f13916cf`。原主工作区的其他改动未纳入本分支。

**两台真实机器的专用远端试跑均已达到 MERGED，最终独立核验通过。** 36 条批准标准保持不变。主项目提交及 PR 合入以交付记录为准；部署继续后置。

## 实现与审查结果

已实现持久交付策略、逐任务授权、同目标队列、原机同步和 CI 修复、固定宿主发布器、可信 CI 核验、操作意图及远端回执恢复、Lab/群状态、证据快照与明确待决。配置经 Lab 保存，不新增功能环境变量。发布凭据不进入开发/测试/评审容器。

审查贯穿群入口 → 授权/API → SQLite → 调度/容量 → 原机执行 → GitHub → 证据 → Lab/群。测试、安全、执行、API/UI、性能、数据迁移、可维护性及对抗复审发现的问题已补回归并修复；没有调整批准标准以通过门禁。

| 问题 | 修复及验证 |
| --- | --- |
| GitHub merge API 无法原子绑定获准 base，外部 retarget 可越过本地检查 | 普通 owner 通道失败关闭；独立 App + active 非目标引用规则提供服务端约束，两机真实 retarget 拒绝及合法 main 合入已验证 |
| 网络请求发出后超时仍记成已完成 | 区分未执行拒绝、已确认成功及结果未知；未知 journal 和队列归属持续保留 |
| 旧 `finished:true` 与旧异常 journal 允许不安全重试 | 旧布尔值不能作为未执行证明；仅新格式明确拒绝允许重试 |
| 证据跨 512 KiB 后仍继续 push/PR/merge | 持久意图后再次检查硬门禁，整条推进链停止 |
| 证据超限将已核实 MERGED 改成延期 | 保留实际 MERGED/merge SHA，证据故障单独标记 |
| 最终发布器 CI 判断弱于协调器 | 精确核对 SHA、交付基线、来源、最新 run/attempt 与重试预算 |
| 相同候选的新待决原因被通知去重吞掉 | 通知指纹包含原因；不变状态仍去重 |
| CI 修复已有 PR 时仍显示“尚未发布” | 开发摘要仅描述本地阶段，交付面板保留已有 PR、候选和部署状态 |
| 旧 GET 晚于暂停 POST，覆盖新状态 | 请求版本与进行中的变更共同防止旧响应覆盖 |
| 慢交付查询阻塞其他机器调度 | 单个受跟踪后台交付轮询，关闭时等待收尾；原调度不等待远端查询 |
| 稳定终态反复取得 SQLite 控制器锁 | 调度入口筛选需要推进或核实的记录 |
| 待核实操作遇到外部 PR 改动后永久冻结 | 停留状态仍只读核实；核实后释放归属，但不自动恢复授权 |
| 停留、暂停或取消时核实读取失败，下一轮自动恢复写入 | 异常路径保留原停留状态和原因，新写入仍需获准继续 |
| 独立评审 CLI 的单个 JSON 代码块被误判无效 | 仅接受完整单代码块或裸 JSON；保留所有 verdict、问题账本及逐项 SHA 关闭门禁 |
| Ubuntu2 的 Git HTTPS 连接失败 | 私有发布连接引用支持严格限定的回环 SOCKS 上游，TLS/凭据边界不变；试验转发已关闭并恢复连接配置 |

回归还覆盖两个真实独立 Node 进程共享 SQLite、持有者退出、未知写入禁止接管，以及真实临时 Git 仓库的基线同步、冻结测试保留、原轮次 CI 修复、全量检查/评审及 bundle 导出。测试中的容器/模型适配与下面两台实际机器试跑分别记账。

## 自动化证据

- TypeScript core/daemon 编译和 Next 生产构建通过。
- 全量 Node 测试：4,037 项，4,033 通过，0 失败，4 项既有跳过；最新交付专项 99/99 通过，含实际发布器 token 权限/有效期/单仓校验及无 owner 回退。
- Agent-loop Vitest：404/404 通过，SDK 源码未改。
- CRAP 门禁通过，未修改债务基线。策略解析函数拆分后通过门禁。
- 全量 Playwright：174/174 通过，包含独立合入身份持久化、旧 GET/暂停竞态和已有 PR 的修复状态。
- 最终交付 + HTTP 路由/访问专项 117/117 通过；契约/UI 复审无未关闭问题。
- formal regression、regression、integration 通过。formal regression 是单元/PBT/MockLLM 回归，不是形式化证明。
- fast eval：22/22 通过；包产物检查通过，未发布包。
- 验收静态门禁通过；静态标签覆盖不代替 AC-35/36 的真实现场证据。

本轮失败测试与原始运行证据保存在忽略的 `.agent-state/factory-delivery-stage3/` 及本机测试日志中；私有配置、机器路径、凭据和完整原始日志不提交。

## 两台真实机器试跑

专用远端仓库：[`magele758/factory-delivery-trial-20261019`](https://github.com/magele758/factory-delivery-trial-20261019)。没有业务部署、强推、工作区删除或自动分支清理。

| 机器 / 任务 | 当前结果 | 候选与实际合入 |
| --- | --- | --- |
| Ubuntu1 / `factory_e57dd611-37d0-4407-b503-53fff7344fb1` | [PR #1](https://github.com/magele758/factory-delivery-trial-20261019/pull/1) 已合入，真实 CI 通过 | 候选 `c132872984702cada979952ee43e3773f1ee38b3`；squash `735a8737dcf2302798df3fa710e5d332f94eb753` |
| Ubuntu2 / `factory_50bf128e-d571-4b0b-a528-03c0f2595f71` | [PR #4](https://github.com/magele758/factory-delivery-trial-20261019/pull/4) 已正常更新，真实 CI 由失败变通过；独立 App 合入 main，MERGED | 失败候选 `3bf6c50d57159aefd98930a5cf3f31aeaaaab100`；修复候选 `6539b10180ea4136248e62fbb31f21a25336b4ef`；squash `75d224a5dfbee693525251c346d9985ec9e3b92f` |

Ubuntu1 的合入发生在本轮安全审查修复之前，已保留并独立核对实际结果，**不能用来证明修复后的自动合入路径可用**。

Ubuntu2 真实 CI 在独立兼容性运行时发现生产代码的空值合并语法无法解析。原机器修复生产代码后重新执行冻结测试、全部检查及独立评审，正常推送到同一 PR，真实 [CI job](https://github.com/magele758/factory-delivery-trial-20261019/actions/runs/39202879100/job/117899399861) 成功。兼容性运行时只用于专用试验契约。没有修改或删除失败测试、放宽工作流或重跑失败候选直到变绿。

用户明确批准该任务仅追加 2 轮：总额 8，已消耗 7；原先消耗的 6 轮和完整历史全部保留。评审输出格式修复后执行保留代码重验，没有重新获得未消耗的修复轮次。平台连接失败的尝试及恢复决定也保留，没有重置累计尝试数。

2026-10-19 13:56（北京时间）最终独立现场观察：

- 两个物理机器身份不同；两处源 HEAD、refs、branch、status 和 diff 摘要与试跑前一致。
- 任务分支 2，任务 PR 2，实际合入 2；基础设施试验 PR 单独统计。
- 交付队列 0，机器占用 0，任务控制进程和任务容器存活数 0。
- 首个真实推送成功后丢弃响应并重启专用协调器，恢复时识别已有分支/PR，没有重复创建。
- `verifyDeliveryPilot` 确认两个物理身份、两个真实 MERGED、至少一次真实 CI 修复及基线前进；AC-35/36 的完整现场条件通过。

## 服务端目标授权证明

批准的 AC-24 要求：远端无法强制保证合入条件时停止自动合入。GitHub [REST merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) 的 `sha` 是 head 条件，没有获准 base ref 的原子比较；严格保护和重复 GET 无法阻止最后一次检查后发生 retarget。因此普通 owner 通道保持失败关闭，不能以直接更新目标 ref、管理员绕过或人工修改本地状态冒充完成。

个人公开仓库支持所需 ruleset，无需组织仓库。用户确认后创建私有 App `Factory Merge Trial 20261019`（App ID 5376730，installation 172919600），只安装至专用试验仓库，contents/PR write、metadata read，无管理、Actions、组织或账户权限。两机原宿主仅通过 owner-only 引用签署 JWT，merge 使用单仓短期 installation token，无 owner 回退。

规则集 `25373764` 已 active：限制更新 `~ALL`，唯一排除 `refs/heads/main`，bypass 仅 repository-admin 角色。App 不拥有该绕过权限；main 原有严格 CI、管理员保护及禁止强推/删除保持有效。

真实 [PR #5 探针](https://github.com/magele758/factory-delivery-trial-20261019/pull/5)：分别在 Ubuntu2 与 Ubuntu1 使用实际发布器，先取得 main/head 快照，再用 owner 把 PR 改向禁止分支，最后以独立 App token 请求合入。两次均 HTTP 405，平台明确返回 `Repository rule violations found / Cannot update this protected ref`；PR 未合入，禁止目标及 main 引用均不变。探针分支保留，不计入任务分支/PR 数。

合法目标的反向证明是 Ubuntu2 原任务 PR #4：同一 App 在严格 CI 门禁下正常合入 main，随后协调器通过独立远端读取核对 PR、目标可达性、实际 merge SHA、父基线及候选 tree，记录 MERGED。Ubuntu1 早期合入与新 App 路径分开记账；两机均已真实验证新 App 身份与服务端拒绝路径。

时限经用户明确追加 2 小时，总额 4 小时，原 createdAt 不变，截止为当日 15:20（北京时间）；第 7/8 轮、累计连接尝试及历史保持不变。未重置预算或创建替代任务。

一次最终现场读取遇到本机 HTTP ECONNRESET，保留失败记录后重新执行完整独立核验，最终通过；未因此重复发布或重置任务。重新授权后旧待决原因仍显示的问题已补失败测试并清除当前 reason，审计历史保留。详细权限与配置见 [独立 App 说明](FACTORY_MERGE_APP_SETUP.md)。
