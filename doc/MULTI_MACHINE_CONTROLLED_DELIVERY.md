# 多机工厂：受控远端交付

第三阶段目标是把有效的本地 READY 任务推进到 GitHub PR，并在全部门禁满足后确认 MERGED。当前 GitHub 适配器可以推送和创建/更新 PR；未配置并验证独立合入 App 与服务端规则时，自动合入停止为 WAITING_DECISION。独立 App 通道已通过两机服务端拒绝探针及合法 main 合入验证。部署、服务重启、回滚、清理分支和工作区均不在此授权内。

验收规格：[`multi-machine-controlled-delivery`](../acceptance/multi-machine-controlled-delivery.yaml)。原有只读与受控开发标准继续生效。

## 配置与授权

在 Lab 的设置 → 运维 → 多机工厂 →「受控远端交付」选择原负责机器和项目，保存以下持久配置。默认关闭，保存后立即生效，不使用新功能环境变量。

- GitHub `owner/repository`、核验后的仓库 Node ID、明确的目标分支。
- 可授权用户、允许的操作：任务分支推送及 PR，或额外允许 squash 合入。
- 原机发布凭据引用；可信 CI 的 workflow ID、job 名称及 GitHub App ID。
- 目标分支上已经审查的全部工作流文件路径及 Git blob SHA。
- 已审查的 Actions 仓库变量摘要（存在变量时必填，不向界面返回变量值）。
- 有界的平台重试次数、交付总时限，以及已核对无部署/额外发布的下游影响。

「核对远端就绪条件」查询真实仓库身份、发布账户、权限、目标、保护规则、工作流和外部 webhook。自动合入需要严格的最新基线检查、绑定 App 的必需检查、对管理员也生效的保护，且禁止强推及删除。未知 webhook、未确认工作流、部署影响或合入后自动删除分支会阻止对应交付。配置 PR-only 项目可以不启用 merge。

每个任务仍需要单独授权。开发权限、READY、模型回复、Bot 转发及旧任务都不会自动获得发布权限。Lab 提供「授权此任务推送并创建 PR」和「授权此任务按门禁推进至 MERGED」。原群等价命令：

```text
/factory deliver {"taskId":"factory_...","scope":"PR"}
/factory deliver {"taskId":"factory_...","scope":"MERGED"}
/factory deliver {"taskId":"factory_...","action":"revoke"}
/factory deliver {"taskId":"factory_...","action":"pause"}
/factory deliver {"taskId":"factory_...","action":"cancel"}
/factory status factory_...
```

授权保存决定者、目标、范围及策略版本。范围内不逐轮重问；撤销只停止后续写入，已经发生的远端事实继续保留。已经 MERGED 的任务不会因取消而显示成未合入。确认敏感范围需要明确的当前 SHA，不能关闭隐私扫描或修改门禁来放行。

## 发布凭据边界

首版发布器运行在原负责 Linux 机器的可信宿主进程中。凭据文件位于：

```text
~/.config/ppeng-factory/publishers/<credentialRef>.json
```

文件必须由当前宿主用户拥有、权限 `0600`、不是符号链接；父目录建议 `0700`。内容包含 `repository`、`repositoryNodeId`、`token`，必须绑定到已确认的目标仓库。不要把凭据填进 Lab JSON、任务需求、源码、命令参数或 `.env`。必要时，同一私有引用文件可保存可选 `gitProxy` 上游连接，严格限定 `socks5h://127.0.0.1:<有效端口>`；只用于可信 Git 网络子进程，GitHub API 不经代理，TLS 校验保持开启。不得把代理通道暴露给候选容器。需要能读取仓库、分支保护、webhook、Actions/checks，并具备任务分支及 PR 写权限的 GitHub 用户凭据；权限不足时预检失败，不换用其他账户。

编码、安装、测试、评审继续在第二阶段的 Docker 沙箱内运行：无通用网络、无发布文件挂载、无宿主凭据。发布器只接收固定操作和确切的任务分支，使用独立 bare 对象库，不检出或执行候选代码，不运行仓库 hooks、脚本或候选配置。Git 网络认证不进入 argv。准备产物时重新核对机器、任务代次、SHA、原始基线、长度与 SHA-256，并扫描完整改动文件及新发布历史中的可达 blob/commit 对象；缺失、损坏、超限、隐私告警及未确认敏感改动均停止发布。

## 执行、排队和恢复

执行状态、本地开发阶段、远端交付和部署状态分别展示。`succeeded / READY` 表示本地开发就绪；远端状态另记为 QUEUED、SYNC_WAIT、PUSHED、CI_WAIT、PR_READY、MERGED、VERIFYING、DEFERRED 或 WAITING_DECISION 等。MERGED 始终保留「部署未由本阶段完成」。

远端写队列按仓库 Node ID + 目标分支归一化，跨机器、仓库别名和工厂主体互斥。排队、CI 等待和人工待决不占机器执行槽位；原机的同步、检查和修复重新进入同一个共享执行池。

目标前进时，在原机器、原 Bot 的隔离任务工作区 merge 最新目标；保留原始基线、每次交付基线、原产物和历史，不 rebase 已发布分支。重新运行全部必需检查，并针对当前交付基线完整独立复审候选及关联调用链。原始 RED 测试保持原字节；从已验证目标增加的测试也会运行。编码容器对冻结测试增加只读绑定，原有摘要和提交核验门禁仍保留。

只使用正常推送更新 `factory/<taskId>`。新提交续接同一 PR，旧提交、旧基线和旧 CI 轮次不能代表新候选通过。CI 以真实 workflow/run/attempt/job/check-suite/App 身份核对，不以名称或本地进程退出为依据。所有已观察结果和平台提供的历史重跑均保留；没有“重跑直到绿”的操作。真实代码阻塞回原机器修复，并消耗原任务剩余轮次，不重置开发预算。耗尽后只有任务授权用户明确追加有界轮次才能继续；追加记录保留已消耗轮次。`verify-current` 只重验停止任务的保留代码，不追加修复预算。

推送、建 PR 和合入前先持久化操作意图；成功后分别查询实际远端 ref、唯一 PR 和合入映射。丢失响应、重启或取消后先核对已有副作用。未知执行或结果保留队列资格，租期到达不能授予第二个写入者。协调进程锁只在确认原进程消失后接管；远端发布器另有固定目标互斥及操作回执。无法核实则保持 VERIFYING，不假装失败或完成。

GitHub REST 的 merge 请求只提供 head SHA 前置条件，没有获准 base ref 的原子比较。严格分支保护、重复查询和本地锁不能弥补外部 retarget 竞态，因此普通 owner 身份通道明确拒绝自动 merge。独立 App 通道要求 active ruleset 覆盖 `~ALL` 分支、唯一排除获准目标，且 bypass 仅有 repository-admin；App 不具有管理权限。最终合入仅使用绑定 App/installation 的单仓短期 token，无 owner 回退；严格 CI 与精确 head 前置条件继续由平台核对。启用该通道须具备真实非目标拒绝、合法目标成功及 retarget 竞态证据，不能以直接修改目标 ref 或绕过规则替代。配置与最小权限见 [独立 App 准备说明](FACTORY_MERGE_APP_SETUP.md)。外部已发生的合入仍独立核对 PR、目标分支可达性、实际 merge SHA、父基线和候选 tree，分别记录测试 SHA 与合入 SHA。

## 证据与待决

Lab 和原群关联同一任务、候选、PR、原因、下一步及明确决定历史。重复通知去重；上海时间 01:00–08:00 只回报新推送、合入、卡点或待决。正常队列/CI 等待不触发执行卡住判断。

HTTP 接口：

```text
GET/PATCH /api/factory/delivery/:machine/:repository
POST      /api/factory/delivery/:machine/:repository/preflight
GET       /api/factory/delivery/tasks/:id
POST      /api/factory/delivery/tasks/:id/grant
POST      /api/factory/delivery/tasks/:id/control
POST      /api/factory/delivery/tasks/:id/decision
POST      /api/factory/delivery/tasks/:id/verify
GET       /api/factory/delivery/queue
GET       /api/factory/delivery/tasks/:id/evidence/:digest?offset=0
```

配置写入要求管理员权限；任务、决定、队列和证据均按工厂主体隔离。审计记录包括授权者、发布者、原始/同步基线、候选/合入 SHA、CI 各次结果、开发执行及问题关闭证据、操作意图和远端确认。

交付视图超过 512 KiB 会停止推进，保存最多 4 MiB 的完整脱敏快照，并明确标记 `evidenceRecoveryRequired` 和快照可用性。快照按 64 KiB 字节分页返回，`base64` 可重组原字节并核对摘要，`text` 用于查看；不能静默丢弃历史后继续合入。Lab 可以逐页查看，缺失或超出快照预算需要人工恢复完整证据。开发回执、增量 bundle 和问题账本仍沿用第二阶段各自的限制。

冲突、权限变化、保护能力不足、外部 PR 修改、轮次耗尽、凭据/平台故障及证据问题都会保留已有代码并转入明确待决/延期。可确认策略、增加原任务开发轮次、处理当前 SHA 的敏感范围或撤销授权；这些决定不包含部署、直接快进目标、清理或外部私信。

## 验证入口

```bash
pnpm exec tsc -b packages/core apps/daemon
node --test packages/core/test/factory-*.test.js
node --test scripts/test/factory-delivery-routes.test.mjs scripts/test/route-access-contract.test.mjs
pnpm run test:acceptance
pnpm run test:e2e e2e/factory-delivery.spec.ts e2e/factory-development.spec.ts e2e/factory-readonly.spec.ts e2e/factory-http-integration.spec.ts
node scripts/factory-delivery-pilot.mjs /private/config.json /private/evidence-dir
```

真实试跑脚本要求两台机器、各自的开发运行参数和专用 GitHub 仓库的交付策略。它通过真实群命令提交/授权，保存持久协调状态；在真实推送成功后丢弃响应并重启专用协调进程，再独立读取 GitHub 和两台机器核对。配置、凭据、原始日志和机器路径保持私有。已有试验使用 `--resume` 恢复；`--resume-stopped` 仅在确认原执行已结束并决定继续时恢复停止的开发任务，不能增加修复预算。

GitHub 规则依据：[严格必需检查](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)、[受保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、[workflow run 与 attempt](https://docs.github.com/en/rest/actions/workflow-runs)。

本轮实现与未完成事项见 [`第三阶段验证与阻塞记录`](MULTI_MACHINE_CONTROLLED_DELIVERY_REVIEW.md)。

即使授权已撤销、策略关闭或预算到期，任务所有者仍可在 Lab 选择“只读核对实际远端状态”；该动作只读取并核对原远端事实，不恢复写权限、不消耗修复轮次，也不重置时限。
