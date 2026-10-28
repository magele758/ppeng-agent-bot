# Agent-as-folder + eval 默认开

最小契约：Agent 优先以**目录**形态声明（与 `skills/<name>/SKILL.md` 对齐），评测默认开启。

## 布局

```text
agents/
  helper.json                 # 仍支持（扁平，向后兼容）
  researcher/
    agent.json                # 必填：id/name/role/instructions…
    AGENT.md                  # 可选；非空时覆盖 instructions
```

`agent.json` 可选字段 `eval`：

| 值 | 效果 |
|----|------|
| 省略 | **默认开**（参与 eval 列表） |
| `false` / `0` / `"false"` | 显式关闭 |
| 其它真值 | 开启 |

## API

- `loadAgentFromFolder(dir)` / `discoverAgentFolders(agentsRoot)`
- `agentEvalDefaultOn(raw)` / `agentsWithEvalDefaultOn(folders)`
- 插件加载器在发现扁平 `agents/*.json` 之后，继续发现 `agents/<slug>/` 目录

实现：`packages/core/src/agents/agent-as-folder.ts`；验收：`acceptance/agent-as-folder-eval.yaml`。
