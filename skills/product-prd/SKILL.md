---
name: product-prd
description: 在 ppeng-agent-core 改用户能看到的产品行为，或增删改 skills/**/SKILL.md 时，同步 doc/prd 产品需求目录。目录在根 README 之外：现状说明、已开发功能、待开发功能、仓库技能对照、现状与测试对照、核心用例。Use when shipping or planning a user-visible feature, editing acceptance status, changing a repo skill, or updating the core-case list.
---

# 产品需求目录

同步这套目录，而不是只改 README。

## 放哪里

- 现状：`doc/prd/current/`（手写，除 `skills.md`）
- 已开发：`doc/prd/shipped/`（生成）
- 待开发：`doc/prd/backlog/from-acceptance.md`（生成）和 `doc/prd/backlog/direction.md`（手写）

## 怎么更新

- 用户能看到的行为变了：同一轮改对应的 current 章节。验收规格状态变了就运行 `node scripts/prd/build-catalog.mjs`，不要手改生成文件。
- 增删改技能：只改该技能自己的 `SKILL.md` frontmatter，然后跑同一个脚本刷新 `doc/prd/current/skills.md`。用途只写在各技能的 description 里。
- 新的未实现需求：有验收规格就交给生成器；还没有规格的方向写进 `direction.md`，每条必须包含「还不是承诺」。
- 不要把草稿或仅批准的规格写成已经交付。
- 不要把这套目录抄进根 README 或其他技能。Bot 交互细则仍以 `doc/bot` 为准，current 只摘要并链接。

## 对照表和核心用例

- 对照表是 `doc/prd/trace.md`（机器可读的是 `doc/prd/trace.json`）。它和台账一起由 `node scripts/prd/build-catalog.mjs` 生成，不要手改。
- 核心用例的手写来源是 `doc/prd/core-cases.yaml`。可读页 `doc/prd/core-cases.md` 由同一个脚本生成。
- 只跑这些用例点名的测试：`node scripts/prd/core-cases.mjs`。`--list` 只打印将要运行的测试文件。点名尚未实现或没有测试的功能时，命令失败。
