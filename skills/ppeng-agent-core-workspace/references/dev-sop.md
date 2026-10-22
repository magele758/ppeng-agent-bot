# ppeng-agent-core（4090 机）开发 SOP v1

> 用途：ppeng-agent-core 不只是被吸收/对齐的参考上游，它本身也要能**自主开发新特性**。
> 开发模式与 ai-agent-node 相同（协调者 → claude-m 开发 → 只读复审 → 修复 → 合入 → push → 清理）。
> **主干分支：main**。建立时间：2026-10-21。

---

## 0. 角色与定位

| 角色 | 职责 |
|---|---|
| **4090 bot（协调者/我）** | 写需求 prompt、启动/盯任务、读复审结论、做合入/push/清理决策。**不自己读 ppeng 源码**（源码阅读只由 claude-m 做）、不直接改代码 |
| **claude-m**（`/home/shinemo/bin/claude-m`） | 开发、只读复审、修复、冲突解决。全部经 `ssh Win4090` 远程执行 |

- 仓库：`/home/shinemo/penglei/ppeng-agent-core`（**主干 main**）
- ai-agent-node 是吸收方（主干 feat/3.6.0）；ppeng 开发出的能力可随后被 ai-agent-node 吸收（走 ai-agent-node 自己的 SOP，独立流水线）

## 1. 仓库/分支/worktree 约定

| 项 | 规则 |
|---|---|
| 主干 | `main`（集成分支，唯一 push 目标） |
| 特性分支 | `feat/ppeng-<name>`，从 main 切出 |
| worktree | `/home/shinemo/wt/ppeng-<name>` |
| 受保护 worktree | 不动 `typecheck-cleanup`、`baseline-feat360`、`csr-rebase-tmp`、`summary-reply-e2e`（都在 ai-agent-node 侧，别跨仓库误碰）；ppeng 侧现有 `fix/evolution-surface-guard-env` 也不动 |
| 基线 | 开发前先 `git fetch origin main`，以 `origin/main` 为基线（当前 665d041c） |

## 2. 文件约定（/tmp，全部在 Win4090 上）

```
/tmp/ppeng-dev-<name>.prompt.md .out .err .rc .md
/tmp/ppeng-review-<name>.prompt.md .out .err .rc .md    轮次 /tmp/ppeng-review-<name>.round
/tmp/ppeng-fix-<name>-<round>.prompt.md .out .err .rc .md
/tmp/ppeng-merge-<name>.md（合入记录，可选）
```

## 3. 标准流水线（一次只往前走一步）

### step1 开发
- 写 `/tmp/ppeng-dev-<name>.prompt.md`：需求、验收点、禁止项
- 启动：`ssh Win4090 → wsl -d Ubuntu -- bash --norc --noprofile`，`PATH=$HOME/.local/bin:$HOME/bin:$PATH`，unset 全部 `ANTHROPIC_*`，`cd /home/shinemo/wt/ppeng-<name>`，`setsid bash --norc --noprofile /tmp/gap2-run.sh /tmp/ppeng-dev-<name> >out 2>err &`
- 完成判据：**包装 pid 退出 ≠ 完成**。看 claude 子进程（`pgrep` 精确匹配目录名）+ rc + 结果 md。子进程还在就不启动第二个
- 要求 claude-m：改完跑相关测试/typecheck 自查，**提交到当前分支**，输出 md（思路/文件/验证/提交 sha）

### step2 只读复审
- 先验证：**分支 HEAD 已前进** + worktree 未提交干净（教训：fix 完成 ≠ 已提交）
- 复审 claude-m **禁止**改文件/提交/push/merge/rebase/reset/stash/yarn install
- 对照 dev prompt 从入口看到结果，结论四段写 `/tmp/ppeng-review-<name>.md`：
  `结论：通过/不通过` / `问题` / `验收` / `仓库`

### step3 不通过 → 修复
- round+1，问题抄到 `/tmp/ppeng-review-<name>-<round>.md`，同一 worktree 只修这些问题
- **fix 轮上限：今晚 10 轮（平时 6）**；round ≥ 10 仍不通过 → 停该功能 + ask_user，不擅自扩轮

### step4 通过 → 合入
- 主仓库 `git fetch origin main`，整合外部提交（`git merge origin/main`）
- 工作区干净、无 merge 进行中才 `git merge --no-ff feat/ppeng-<name>`
- 冲突：停，冲突文件交主仓库 claude-m 解决（**保留两边行为**），解决后提交。冲突没完成不合下一个

### step5 推送
- 主仓库 main 比 origin 超前、工作区干净、无未完成合并 → `git push origin main`
- push 前必先 fetch + 整合外部提交（外部提交会持续出现）

### step6 清理 worktree
- 分支已是 `origin/main` 祖先 **且** 目录无 claude 子进程 → `git worktree remove --force /home/shinemo/wt/ppeng-<name>`
- 没推送成功的不删；**不删除分支**

## 4. 并发与硬约束

- **claude-m 总数 ≤ 10**（ppeng + ai-agent-node 两条流水线合计）
- 全部命令经 `ssh -o BatchMode=yes -o ConnectTimeout=15 Win4090`，然后 `wsl -d Ubuntu -- bash --norc --noprofile`
- 不 source zshrc；不改 magpie/settings；本地（Mac 侧）不启动 claude 子进程
- 禁止：push/merge 未经验证、rebase、reset、删除分支、改 node_modules、yarn install
- 不贴源码、不贴 token；报告用东八区时间；无变化只回 `[NO_UPDATE]`

## 5. 吸收联动（可选）

ppeng 的 `main` 新特性上线后，如需同步给 ai-agent-node：
1. 确认 ppeng 提交已 push 到 origin/main
2. 走 ai-agent-node SOP（主干 feat/3.6.0，基线同步，分支 feat/gapN-<name>）
3. 两条流水线可并行，claude-m 合计 ≤ 10

## 6. 经验教训（跨仓库通用，来自 gap1~gap4）

- **fix 完成 ≠ 已提交**：claude-m 修完可能不 commit（gap2 rls fix4、gap3 tpi fix2 都踩过）——复审前先验证分支 HEAD 前进 + worktree 未提交干净；没提交的 fix 不算完成
- **包装 pid 退出 ≠ 完成**：claude-m 包装进程退出后可能还在写结果；以 claude 子进程 + rc + md 为准
- **dev 可能静默失败**：out=0 字节 + err 里 `unrecognized_model` 是启动失败（gap4 4 个里 3 个首启失败过）——重启前看 claude 子进程 + out 大小，别只看包装 pid
- **外部 origin 提交会持续出现**：每次 push 前必 fetch + `git merge origin/<branch>` 整合，一次只合一个分支
- **merge 冲突先 abort 再交 claude-m**：协调者先 `git merge --abort` 清状态，再重跑 merge 让冲突状态出现，交主仓库 claude-m 保留两边行为解决（gap4 model-retry 合入时踩过）