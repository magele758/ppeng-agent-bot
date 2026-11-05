# Skill 路由基线（改造前后对照）

当前配置入口：Lab「设置 → 工具 → 技能」。路由模式、候选数、严格加载和融合策略保存到 `skill_settings`，后续步骤无需重启即可采用。每个未保存字段独立回退到既有环境配置。显示策略与排序策略分别设置；hybrid 会在排序候选之外合并关键词命中。详见 [Bot 设置与生效范围](BOT_SETTINGS_FLOW.md)。

**改造前（`RAW_AGENT_SKILL_ROUTING_MODE=legacy`）**

- `buildSystemPrompt` 动态块中列出**全部** skill 的 name + description；`matchSkills` 仅对内置 `triggerWords` 做子串匹配，workspace `SKILL.md` 几乎不参与自动命中。
- 正文仅在模型调用 `load_skill(name)` 后进入对话，但路由阶段未系统利用 **body** 做排序。

**改造后（默认 `hybrid`，可切 `lexical`）**

- `routeSkillsLexical` 对 `name`、`description`、`content`（正文前 24k 字符）做加权词法打分，输出 **top-K shortlist**；`hybrid` 再并上 `matchSkills` 的 keyword 命中。
- 在 Lab 启用严格加载时，`load_skill` 可加载当轮 shortlist、当前会话最近一次 `search_skills` 命中的技能，以及当前 Bot 自己保存的技能（支持名称或 ID，无需先搜索）。懒加载模式同样允许搜索结果和自建技能；`legacy` 路由的非懒加载模式不启用 strict。归属、共享、启用状态和会话允许名单仍独立校验。未保存严格加载设置时才回退 `RAW_AGENT_SKILL_LOAD_STRICT`。
- 观测：`trace` 中 `skill_load` 记录 off-shortlist 加载；`buildSkillRouting` 返回 `confidence` 供 prompt 提示歧义场景。

评测数据：`packages/core/test/skill-router-cases.json` + `skill-router.test.js`。
