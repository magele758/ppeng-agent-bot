# 07 — Skills 与路由

> **设计目标**：让 Agent 的知识可以按需扩展，而不是把所有领域知识塞进 system prompt。Skill 是"可热加载的专家模块"——只在相关时注入，不相关时零开销。

---

## 问题：为什么不把所有知识写进 prompt？

1. **Token 成本**：100 个 skill 各 2k token = 200k token/轮。即使有 1M 窗口也不可接受。
2. **注意力稀释**：塞 200k 无关知识会降低模型对相关指令的遵从度。
3. **更新摩擦**：任何知识变更都需要改 prompt + 重部署。

### 解法：路由式按需加载

```
用户消息 → 路由器评分 → top-K shortlist → 只注入相关 skill
```

送入 dynamic prompt 的 skill 条目由全量清单缩小为 top-k；路由计算本身仍需扫描候选集合，不应把整体复杂度写成 O(K)。

---

## 三层架构

### Layer 1: 发现

```
allSkills() = builtinSkills ⊕ merge(workspace, agentsDir, cloud, domainExtras)
```

| 来源 | 路径 | 场景 |
|------|------|------|
| 工作区 | `<repoRoot>/skills/**/SKILL.md` | 项目特定知识 |
| 用户全局 | `~/.agents/**/SKILL.md` | 跨项目通用技能 |
| 云 catalog | `cloudSkillsLoader()` | SaaS 版共享技能库 |
| 领域包 | `RuntimeOptions.extraSkills` | 预打包的行业包 |
| 内置 | `builtin-skills.ts` | 极少，系统级 |

**合并规则**：同 name 后来者覆盖（`~/.agents` > workspace）——用户可以 fork 任何 skill 做定制。

### Layer 2: 路由

每轮 user 消息到达时，给全量 skill 评分取 top-K：

| Mode | 算法 | 适用场景 |
|------|------|----------|
| `legacy` | 全量注入（不路由） | 技能极少（<5 个）时 |
| `lexical` | TF-IDF tokenize + cosine | 轻量、可解释 |
| `hybrid`（默认） | lexical × fusion 多通道 | 技能多、描述有重叠 |

#### Hybrid Fusion 设计亮点

```
query → [lexical channel] → scores₁
      → [alias channel]   → scores₂  (技能别名匹配)
      → [relationship]    → scores₃  (关联技能互拉票)
      → weighted merge → final ranking
```

**Relationship cache**：预计算 skill 间的 token 重叠度。当用户消息匹配了 skill A，与 A 高度关联的 skill B 也会获得加分。这解决了"用户用不同词描述同一个需求"的问题。

#### 路由质量评估

- **Confidence**：top-1 与 top-2 的分差。`high` = 明确命中；`low` = 多个 skill 分数接近
- **Robustness**：对 query 做扰动（同义词替换）→ 多次路由 → 结果稳定性

### Layer 3: 加载

模型可以在对话中显式调用 `load_skill({ name })` 加载 skill。

**安全约束**：`RAW_AGENT_SKILL_LOAD_STRICT=1` 时只允许加载当轮 shortlist 内的 skill——防止模型绕过路由加载不相关技能（减少 prompt injection 风险）。

**高危面强制 skill**（始终开启，不是环境变量开关）：购物 / 登录 / 外发 / 支付相关工具在本会话成功 `load_skill` 对应技能之前 fail-closed，不执行工具。对照表在 `packages/core/src/skills/mandatory-skill-gate.ts`（`vault_fill`、`vault_get`、`collect_credentials`、结账意图下的 `browser_click` / `browser_type`、卡号或 CVV 的 `secure_form`、`schedule_social_post`）。拒绝文案要求先调用 `load_skill(name)`。Manifest 或 SKILL frontmatter 的 `requiredSkills` 在加载该 skill 时一并视为已满足。通过后仍受 Auto-review 与 Manifest allowTools 约束。

---

## 设计取舍

1. **SKILL.md 即接口**：一个 markdown 文件就是一个技能——不需要写代码、不需要注册 API。降低了 skill 创建的门槛到"会写文档"的水平。
2. **覆盖机制**：用户可以在 `~/.agents/` 里 fork 并覆盖任何内置 skill，无需修改源码。
3. **未命中正文不注入**：skill 不在 shortlist 时，正文不进入 prompt；清单和路由说明本身仍有 token 开销。
4. **Fusion 多通道**：不依赖单一匹配策略，别名、关联关系都是额外信号——鲁棒性高。

---

## 如何评估路由

使用固定 query → expected skill 数据集分别统计 top-1、top-k、off-shortlist load 和 strict reject。`skill_load` trace 可用于收集真实选择，但不能把“模型最终调用了某 skill”自动当成路由正确标签。

---

## 关键文件

| 路径 | 说明 |
|------|------|
| `skills/skill-router.ts` | 路由主逻辑 + env 解析 |
| `skills/skill-matcher.ts` | TF-IDF / fusion / robustness |
| `skills/skill-registry.ts` | 文件系统 glob + SKILL.md 解析 |
| `skills/skill-disclosure.ts` | 格式化注入内容 |
| `skills/mandatory-skill-gate.ts` | 高危面未 load_skill 则 fail-closed |
