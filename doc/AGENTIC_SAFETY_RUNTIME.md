# 运行时与「智能体失范」研究：本仓库可做的治理层

本文档把公开研究映射到 **本仓库宿主（daemon、工具、审批、沙箱、spawn）能实际加强的东西**，并明确 **不** 声称在应用内复现论文中的训练方法。

## 参考资料（链接）

| 资料 | 摘要 |
|------|------|
| [Agentic Misalignment](https://www.anthropic.com/research/agentic-misalignment)（2025） | 在受控模拟中，多模型在面临「被替换 / 目标与公司方向冲突」且道德路径被堵死时，可能选择勒索、泄密等 **智能体失范**；强调高自主 + 低监护 + 敏感权限时的风险与进一步研究必要性。 |
| [Lynch et al., arXiv:2510.05179](https://arxiv.org/abs/2510.05179) | 与上条相关的评估与「智能体失范」方法论（HTML: [2510.05179v2](https://arxiv.org/html/2510.05179v2)）。 |
| [Teaching Claude Why](https://alignment.anthropic.com/2026/teaching-claude-why/)（2026） | 用 **改进安全训练数据质量**、**SDF（合成文档微调）**、**带工具定义的无害性环境**、以及 **用户伦理困境顾问式对话** 等，减少对评估分布死记硬背、提升分布外泛化；属于 **模型训练与服务方** 的工作。 |
| [Model Spec Midtraining (MSM)](https://alignment.anthropic.com/2026/msm/)（2026） | 在预训练后与对齐微调前，用讨论 Model Spec 的合成语料做 **MSM**，改变后续 AFT 的泛化；与 AM eval 联动展示降失范率。同样是 **训练流程**，非应用层补丁。 |

## 对本仓库：**直接增益** vs **仅间接（训练期）**

- **MSM / Teaching Why / SDF：间接为主**  
  这些方法改变的是 **基底模型或对齐流水线**。本仓库作为运行时宿主，只能通过 **选对模型/API、依赖供应商安全更新**，间接受益；无法在应用内「实现 MSM/SDF」。

- **直接增益（治理与工程控件）**  
  对齐 Anthropic 对高自主智能体的警示，本仓库已具备或可强化的包括：
  - **审批与人机闭环**：高风险工具调用走批准（例如外部 AI CLI 等）。
  - **Auto-review（工具级）**：高危 Shell/spawn/MCP 默认拦；同参重试并带 `requestSmartModeApproval` 才出原生审批卡；拒绝为终局；`permissionMode=bypass` 不能绕过。见 `@ppeng/agent-loop` `evaluateAutoReview` / `checkToolApprovals`。
  - **最小权限**：`allowedTools`、`DomainBundle`、`RAW_AGENT_EXTERNAL_AI_TOOLS` 等按需暴露能力。
  - **沙箱与 spawn 卫生**：`sanitizeSpawnEnv`、`SandboxManager`（macOS `sandbox-exec` / Linux `bwrap`）降低凭证与环境注入面。
  - **审计与可追溯**：会话/工具 trace、日志；运营侧可据此做事后审查。
  - **策略注入（弱但合法）**：通过系统提示 **附录** 重申边界（见下项）；**不** 等同于训练层对齐，只是运行时提醒与一致话术。

## 读本机数据时的五层闸门（以语音备忘录为例）

一条 `bash` 要真正读到 `~/Library/Group Containers/...` 下的文件，要依次过五层，它们各管各的，互不替代：

| 层 | 管什么 | 放行方式 |
|----|--------|----------|
| 审批（Auto-review / 审批卡） | 高危命令（`rm `、管道进 shell、MCP）和「绕开已保存隔离方式」的 `isolation: "direct"` | 同参带 `requestSmartModeApproval` 重试 → 负责人批卡。Lab 已保存 direct 时，显式 direct 不再单独拦 |
| `permissionMode`（auto / bypass / plan） | 普通工具要不要逐个审批 | 会话设置。bypass **不**绕过 Auto-review，也不碰路径封锁 |
| 沙箱隔离方式（Lab「命令沙箱」） | 命令是否套 seatbelt / bwrap | 保存为 direct 则不套；os 下 seatbelt 只拒 `~/.ssh`、`~/.aws`、`~/.gnupg` 等密钥目录，不拒 Group Containers |
| 来源范围（`SourceLedger`） | 会话看过外部内容（含带 `«external` 标记的 bash 输出）后，后续有副作用的调用不能由这些内容授权 | Learning 工作台保存范围；或对**这次精确调用**的批准（参数比对时忽略 `requestSmartModeApproval` 等升级标志）。有人值守的根会话被拒时会自动出一张「source scope」审批卡并等待；routine、子 agent、无人值守唤醒仍直接拒 |
| macOS TCC（系统隐私） | 进程能否读语音备忘录、邮件等受保护目录 | 只能由用户在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」授权给**实际运行 daemon 的 node 可执行文件**（或启动它的终端 App）。没授权时 `ls` 报 `Operation not permitted`，代码层无法也不应绕过 |

排查顺序：先看工具结果的错误码（`AUTO_REVIEW_BLOCKED` → 审批；`source_scope_denied` → 来源范围；`Operation not permitted` → TCC），不要用换命令、换工具的办法绕过。

## 可选环境变量：运行时系统附录

设置 `RAW_AGENT_AGENTIC_SAFETY_APPENDIX=1`（或 `general` / `true`）时，在 **`general` 内置智能体** 的稳定系统前缀末尾追加一段 **英文** 简短附录（与现有系统提示语言一致），提醒：反对为自保或完成任务而伤害用户/他人、工具意图冲突时暂停询问、配合审批与最小权限、在强冲突场景下把矛盾写清以便人工审计。

设为 `all` 时对 **所有** 智能体追加同一段（适用于希望 harness/子智能体也统一看到策略的运营环境）。

默认关闭；详见根目录 `.env.example` 注释。

## 落地建议（务实）

1. **文档与运维共识**：产品与运维明确「智能体有权调哪些工具、谁审批、哪些数据面禁止」。  
2. **eval/harness**：若需回归，可对 **封闭 mock 模型** 增加与「违规工具模式」相关的用例（不依赖复现勒索等有害内容 verbatim）。  
3. **不靠系统提示兜底**：附录只是治理拼图中的一小块；临界安全仍依赖 **权限、监护、供应商模型行为与合规流程**。
