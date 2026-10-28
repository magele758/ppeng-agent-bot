# A2UI capability

This project ships an opt-in implementation of Google's [A2UI v0.9](https://a2ui.org/specification/v0.9-a2ui/) Agent-to-UI protocol. When enabled, an agent can render interactive surfaces (forms, task cards, approval prompts, etc.) inline in the Agent Lab chat panel and receive structured action callbacks from the user.

## Quick start

1. Open Lab → Settings → Tools → Interactive cards & domain capabilities and enable interactive cards. The next execution step sees the tools without a daemon restart. `RAW_AGENT_A2UI_ENABLED` is only a fallback until this field has been saved in Lab.
2. From the chat panel, ask the agent something like _"render a confirmation card"_ or _"show my pending tasks as cards"_.
3. The agent calls `a2ui_render` and the surface is rendered inline.
4. When the user clicks a button (or submits a form), the renderer POSTs to `/api/sessions/:id/a2ui/action` and the agent sees the action as a synthetic user message in the next turn.

## Architecture

```
LLM ── tool_call: a2ui_render ──▶ packages/core/src/a2ui (validate)
                                  │
                                  ▼
                         runtime.processToolResults
                                  │
                                  ├─▶ persists SurfaceUpdatePart on the tool message
                                  └─▶ emits ModelStreamChunk { type: 'a2ui_message', ... }
                                                                  │
                                                                  ▼
                                                  apps/daemon SSE → web-console
                                                                  │
                                                                  ▼
                                            <A2uiSurface> folds envelopes,
                                            renders by catalogId+component name,
                                            two-way bindings update local data model
                                                                  │
                                                                  ▼
              user click ── POST /api/sessions/:id/a2ui/action ──▶ runtime.sendUserMessage
                                                                  │
                                                                  ▼
                                                            agent next turn
```

### Persistence

`SurfaceUpdatePart` is just another `MessagePart` on the tool message that produced it. Because parts are stored as JSON, the surface re-renders deterministically on session reload. Older clients (and the model adapter) ignore unknown part types — adding A2UI does not break sessions that don't use it.

### Streaming

`ModelStreamChunk` adds `{ type: 'a2ui_message', surfaceId, envelope }`. The web console folds chunks per `surfaceId` so the surface re-renders in place as updates arrive (mirrors the spec's "progressive rendering" model).

## Tools

| Tool | Args | Notes |
| --- | --- | --- |
| `a2ui_render` | `surfaceId`, `catalogId?`, `messages: A2uiMessage[]` | First message for a new `surfaceId` must be `createSurface`. `version` and `surfaceId` defaults are stamped automatically. |
| `a2ui_delete_surface` | `surfaceId` | Sends a `deleteSurface` envelope. |

Tool descriptions are intentionally short to keep the system prompt lean. Catalog cheat-sheet is in `skills/a2ui/SKILL.md` and only loaded when the skill router triggers on phrases like "渲染 / surface / 卡片 / 表单".

## Catalogs

Two catalogs are registered out of the box:

| Catalog ID | Role |
| --- | --- |
| `https://a2ui.org/specification/v0_9/basic_catalog.json` | A2UI basic v0.9 (Text, Card, Column, Row, Button, TextField, …) |
| `https://ppeng.dev/agent-core/a2ui/v1` | Agent-native domain components (TaskCard, TaskList, AgentBadge, MailboxThread, ApprovalRequest, SessionLink, TodoEditable, DiffView, TraceMini, KnowledgeGraph, ChartCard) |

Each catalog has a server-side spec entry (`packages/core/src/a2ui/catalog/`) used by the validator and a renderer entry (`apps/web-console/components/a2ui/components/`) used by the UI.

## Adding a new component

1. Add a `ComponentSpec` entry to `packages/core/src/a2ui/catalog/agent-native.ts` (or your own catalog file).
2. Implement a renderer in `apps/web-console/components/a2ui/components/<your-file>.tsx`. The renderer receives `RenderProps` (component, render helpers, eval helpers, dispatchAction, setAt).
3. Register the renderer:

   ```ts
   registerCatalogRenderers(MY_CATALOG_ID, { MyComponent: MyComponentRenderer });
   ```

4. Heavy deps (Cytoscape, Recharts, Three, …) should be loaded via `dynamic import` inside the renderer so they don't bloat the main bundle.

The validator does **not** error on unknown component names by default; the renderer ships an `<UnknownComponent>` fallback with the raw JSON so partially-shipped catalogs degrade gracefully.

## Action contract

When the user interacts with an interactive component, the renderer POSTs:

```http
POST /api/sessions/:id/a2ui/action
{
  "surfaceId": "form1",
  "name": "form.submit",
  "context": { "name": "Alice" },
  "dataModel": { "user": { "name": "Alice" } }    // only when sendDataModel: true
}
```

The daemon turns this into a single user message: `[a2ui:action form.submit] {...}`. That message is persisted and triggers a `runSession`, so the agent sees the event on its next turn.

## Future-extension hooks

| Need | Path |
| --- | --- |
| KnowledgeGraph (Cytoscape) | drop-in `apps/web-console/components/a2ui/components/knowledge-graph.tsx` + replace placeholder; protocol layer untouched |
| ChartCard (Recharts/ECharts) | same pattern |
| MCP transport (`application/json+a2ui`) | wrap the same envelopes as MCP `EmbeddedResource`; the protocol module is transport-agnostic |
| A2A binding | each envelope corresponds to a single A2A message Part |
| Third-party catalogs | call `registerCatalog()` (server) + `registerCatalogRenderers()` (web) at boot |

## References

- Protocol: <https://a2ui.org/specification/v0.9-a2ui/>
- Repo: <https://github.com/google/A2UI>
- A2UI over MCP: <https://a2ui.org/guides/a2ui_over_mcp/>
