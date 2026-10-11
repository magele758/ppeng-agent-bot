# @mage-ai-lab/agent-loop

可嵌入的 Agent 循环：装配一轮对话、调用一个工具、拿到折叠后的消息。

```bash
npm install @mage-ai-lab/agent-loop
```

Bot 模式不在这个包里（它在 daemon / RawAgentRuntime 上）。

契约说明与本仓库 `skills/agent-loop/SKILL.md` 相同，装好后读 `node_modules/@mage-ai-lab/agent-loop/SKILL.md`。

## 五分钟上手

`createAssembledLoop({ preset })` 组装循环。`createHandle(sessionId)` 只在 `full` 和 `max` 上提供。下面注册一个工具，再 `run()` 一轮。

```ts quickstart
import { createAssembledLoop, OpenAiChatAdapter } from '@mage-ai-lab/agent-loop';
import { createDefaultMemoryStore, DEFAULT_EMBED_AGENT } from '@mage-ai-lab/agent-loop/mini';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('Set OPENAI_API_KEY');

const { store, surface } = createDefaultMemoryStore({ agent: DEFAULT_EMBED_AGENT });
const session = surface.createSession({
  title: 'weather',
  mode: 'chat',
  agentId: DEFAULT_EMBED_AGENT.id,
});
surface.appendMessage(session.id, 'user', [
  { type: 'text', text: 'What is the weather in Shanghai?' },
]);

const loop = await createAssembledLoop({
  preset: 'full',
  io: {
    store,
    model: new OpenAiChatAdapter({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      useJsonMode: false,
    }),
    tools: [
      {
        name: 'fetch_weather',
        description: 'Query weather for a city',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
        approvalMode: 'never',
        sideEffectLevel: 'none',
        execute: async (_ctx, args) => ({
          ok: true,
          content: `${String(args.city)}: Sunny, 22°C`,
        }),
      },
    ],
  },
});

if (!loop.createHandle) throw new Error('createHandle requires preset full or max');
const handle = loop.createHandle(session.id);
await handle.run();
console.log(await handle.fold());
```

## 浏览器 / 扩展

只导入 mini。不要把 `.`、`./full`、`./max` 打进浏览器包，它们会带上 Node 内置模块。

```js
import { createMiniAssembledLoop } from '@mage-ai-lab/agent-loop/mini';
```
