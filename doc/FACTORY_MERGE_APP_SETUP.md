# 专用试验仓库的独立合入身份准备

目标：补齐 AC-24，保持原机执行和原有固定发布通道。个人公开仓库也支持 rulesets，组织仓库不是必需前提。

已按用户确认创建本人拥有的私有 GitHub App `Factory Merge Trial 20261019`（ID 5376730，installation 172919600），仅安装到 `magele758/factory-delivery-trial-20261019`：

- Repository contents：read/write（GitHub merge API 所需）。
- Pull requests：read/write。
- Metadata：read；无 Administration、Actions、组织或账户权限。
- Webhooks 关闭；不进行 OAuth 用户授权；不安装到所有仓库。
- 独立私钥仅进入两台原负责机器的 owner-only 发布凭据引用，不进入代码、模型、沙箱、命令参数或返回证据。

服务端分支规则：对 `~ALL` 分支启用 restrict updates，唯一排除 `refs/heads/main`；只允许 repository-admin 角色绕过这条非目标规则。原机既有 owner 身份只做已授权任务分支 push/PR；实际 merge 必须使用独立 App installation token，无 owner/admin 回退。main 的严格 CI 与管理员保护保持生效。受控发布器必须核对规则集处于 active、范围完整、bypass 无该 App 或其他写角色。

专用仓库规则集 `25373764` 已从 disabled 探针更新为 active 的上述完整约束。两台机器均完成真实 retarget 后禁止分支合入被拒绝的证明；Ubuntu2 原任务 PR #4 已通过同一 App 合入 main。

启用前必须真实证明：同一 App 对非 main PR 的合入被服务端拒绝且引用不变；对满足全部门禁的 main PR 可以合入；外部 retarget 竞态不会落到未授权分支。原机仍独立核对最终 PR、目标、候选与实际合入 SHA。验证前自动合入保持关闭。

用户已完成浏览器登录，并明确确认创建与单仓安装。私钥不在聊天中传递。

## 持久配置与私有引用

Lab 交付策略中保存非敏感身份信息：

```json
{"mergeIdentity":{"appId":123,"installationId":456,"credentialRef":"stage3-merge","rulesetId":789}}
```

这里的示例数字必须替换为实际核实值。该配置参与策略修订指纹，变更后旧任务授权不能代表新策略。`credentialRef` 必须不同于 push/PR 凭据引用；策略/API 不接受私钥。

原机 `~/.config/ppeng-factory/publishers/stage3-merge.json` 是 owner-only、非符号链接文件，包含 `repository`、`repositoryNodeId`、`appId`、`installationId` 和 `privateKey`。其中仓库及身份必须与策略一致；私钥不能提交。本机通过 OpenSSL 签署短期 RS256 JWT，安装 token 每次按实际 repository ID 限定单仓，并再次核对返回权限、有效期及仓库 node ID。

真实 Ubuntu2 任务在第 7/8 轮完成，用户明确追加交付时限 2 小时（总额 4 小时）。原 createdAt、已消耗轮次和尝试历史均保留，实际 MERGED 发生于追加时限内。
