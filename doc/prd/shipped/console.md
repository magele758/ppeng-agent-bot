<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## console-bot-visual
Bot 页视觉与列表状态

Implement the approved console redesign, Bot page only. User approved the v2 Bot structure exactly: pinned (bots and rooms mixed), unpinned rooms, functional groups, ungrouped, shared info; row menu to pin and move group; + creates bot, room, functional group. Do not regroup. Visual only plus matching empty/loading/error states. Sage green, and respect light/dark CSS variables if the shell PR has not landed yet — do not invent a second theme system and do not edit the shell, styles/tokens, or nav.

## console-font-size-preference
控制台字体大小偏好

现在字体又太大了，你在设置里给我加一个字体大小选择的，尺寸参考macos的字体选择吧

## console-home-shell
控制台视觉与外壳

Implement the approved console redesign, batch 1 only: visual tokens and the app shell.
User approved: keep today's top-level nav (Bot and 会话 are separate; do not merge or regroup), sage green accent, light and dark together.
Scope: styles/tokens, theme (light+dark, persisted the way the console already persists preferences — no new env vars), app shell chrome (sidebar, top bar), and the nav labels. Do not restyle section interiors.

## console-knowledge
知识与记忆：分层记忆、搜索与摄取设置

apps/web-console 前端很乱：功能堆在一起，配置太多不好用，交互不清晰。目标是整体重构，让控制台清晰、易用。
知识与记忆区要简单：记忆范围有解释、可搜索、可添加/编辑，摄取设置简化并把不常用项放进「高级」，空状态要有说明。

## console-navigation
控制台主导航与页面结构

apps/web-console 前端很乱：功能堆在一起，配置太多不好用，交互不清晰。目标是整体重构，让控制台清晰、易用。
主导航：Bot / 对话 / Bots 与 Agents / 任务 / 知识与记忆 / 设置。运维不在左侧主导航，从设置进入。

## console-sections-redesign
控制台其余页面视觉与本会话始终允许

Implement the approved console redesign for every console section except the app shell, the Bot page, and the chat page, plus the one new behavior 「本会话始终允许」. Keep the current information architecture: 审批 stays under 任务, 运维 stays under 设置. Do not add a top-level 待处理, 工作, or 运维, and do not add ⌘K. Sage green via CSS variables; do not edit shell, tokens, nav, Bot, or chat components.
「本会话始终允许」: Define "same kind" narrowly and document it in the acceptance criteria: same tool name and same sandbox isolation mode, within the current session only, revocable. Do not widen it to all tools or across sessions. The acceptance criteria must state the allow, the boundary, and the revoke. Persist through the existing settings/session mechanism, no new env flag.

## console-settings
设置页渐进披露与搜索

配置太多不好用。设置要默认简单、分组清晰、可搜索，不常用的放到「高级」。

## console-skin-motion
各外观独立特效与极简黑白

给每个主题都加一些特定的元素和独立的特效，现在全是静态的，按照各种风格去添加特效，要炫酷，再加一套极简黑白风格的设计，分多个Agent去快速完成

## console-skins
多套可切换外观

我觉得可以，可以给圣所主题加一些元素，可以参考data-agent的元素，另外，按照这个模式再帮我开发：赛博朋克2077、恶魔的聚会、机器人大舞台、纯黑白像素风格的这几套主题，供我平时使用，分多个Agent去快速完成开发
再加一套，童趣幼儿园的主题

## console-tasks
任务页：队列、编排运行与审批收件箱

apps/web-console 前端很乱：功能堆在一起，配置太多不好用，交互不清晰。目标是整体重构，让控制台清晰、易用。
任务页要有清晰的任务收件箱与编排运行视图，空状态要有说明。
