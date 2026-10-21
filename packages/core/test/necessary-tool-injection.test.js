import test from 'node:test';
import assert from 'node:assert/strict';
import { filterToolsForSession, hiddenDeferredToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import {
  DISCLOSED_TOOL_NAMES_META,
  isOnDemandTool,
  withOnDemandDisclosure
} from '../dist/tools/deferred-disclosure.js';
import { mergeDomainBundles } from '../dist/domain.js';

const FILE_BODY = 'readme body';

function tool(name, description, content = '') {
  return {
    name,
    description,
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content })
  };
}

const general = {
  id: 'general',
  name: 'General',
  role: 'assistant',
  instructions: '',
  capabilities: []
};

function split(tools, { agent = general, metadata = {}, settingsStore } = {}) {
  const input = {
    env: {},
    tools,
    agent,
    session: { id: 's', mode: 'chat', metadata },
    ...(settingsStore ? { settingsStore } : {})
  };
  return {
    visible: filterToolsForSession(input).tools,
    hidden: hiddenDeferredToolsForSession(input)
  };
}

function names(tools) {
  return tools.map((item) => item.name);
}

test('普通对话不带上股票行情和集群查询的完整定义 [AC:necessary-tool-injection#AC-1]', () => {
  const quote = withOnDemandDisclosure(tool('quote_get', 'Get a stock quote'));
  const k8s = withOnDemandDisclosure(tool('k8s_get', 'Query a Kubernetes cluster'));
  const read = tool('read_file', 'Read a repository file', FILE_BODY);
  assert.equal(isOnDemandTool(quote), true);
  assert.equal(isOnDemandTool(k8s), true);
  assert.equal(isOnDemandTool(read), false);
  const { visible, hidden } = split([read, quote, k8s]);
  assert.deepEqual(names(visible), ['read_file']);
  assert.deepEqual(names(hidden), ['quote_get', 'k8s_get']);
});

test('关掉本机桌面操作后桌面工具不能出现也不能被发现 [AC:necessary-tool-injection#AC-3]', () => {
  const desktopOff = {
    getDaemonControl(key) {
      if (key === 'computer_use_settings') return { enabled: false };
      return undefined;
    }
  };
  const { visible, hidden } = split(
    [tool('read_file', 'Read a file', FILE_BODY), tool('lcu_click', 'Click the local desktop')],
    {
      metadata: { [DISCLOSED_TOOL_NAMES_META]: ['lcu_click'] },
      settingsStore: desktopOff
    }
  );
  assert.equal(names(visible).includes('lcu_click'), false);
  assert.equal(names(hidden).includes('lcu_click'), false);
});

test('关掉动态工具后保存和复用工具不能出现也不能被发现 [AC:necessary-tool-injection#AC-4]', () => {
  const dynNames = ['save_as_tool', 'propose_tool', 'search_dyn_tools'];
  const { visible, hidden } = split(
    [
      tool('read_file', 'Read a file'),
      tool('save_as_tool', 'Save a temporary tool'),
      tool('propose_tool', 'Propose a temporary tool'),
      tool('search_dyn_tools', 'Search dynamic tools')
    ],
    { metadata: { [DISCLOSED_TOOL_NAMES_META]: dynNames } }
  );
  const seen = new Set([...names(visible), ...names(hidden)]);
  for (const name of dynNames) {
    assert.equal(seen.has(name), false, name);
  }
});

test('收起领域工具后仍能读取当前文件 [AC:necessary-tool-injection#AC-5]', async () => {
  const quote = withOnDemandDisclosure(tool('quote_get', 'Get a stock quote'));
  const k8s = withOnDemandDisclosure(tool('k8s_get', 'Query a Kubernetes cluster'));
  const read = tool('read_file', 'Read a repository file', FILE_BODY);
  const { visible } = split([read, quote, k8s]);
  const found = visible.find((item) => item.name === 'read_file');
  assert.ok(found);
  const result = await found.execute({}, {});
  assert.equal(result.content, FILE_BODY);
  assert.equal(names(visible).includes('quote_get'), false);
  assert.equal(names(visible).includes('k8s_get'), false);
});

test('Bot 已保存的工具名单以外不能出现股票行情 [AC:necessary-tool-injection#AC-6]', () => {
  const quote = withOnDemandDisclosure(tool('quote_get', 'Get a stock quote'));
  const read = tool('read_file', 'Read a file', FILE_BODY);
  const { visible, hidden } = split([read, quote], {
    agent: { ...general, allowedTools: ['read_file'] },
    metadata: {
      allowedTools: ['read_file'],
      [DISCLOSED_TOOL_NAMES_META]: ['quote_get']
    }
  });
  assert.equal(names(visible).includes('read_file'), true);
  assert.equal(names(visible).includes('quote_get'), false);
  assert.equal(names(hidden).includes('quote_get'), false);
});

test('领域人设固定 SRE 包后留下已授权工具，合并后的领域工具默认按需披露', () => {
  const rawK8s = tool('k8s_get', 'Query a Kubernetes cluster');
  const k8s = withOnDemandDisclosure(rawK8s);
  const read = tool('read_file', 'Read a file');
  const { visible, hidden } = split([read, k8s], {
    settingsStore: {getDaemonControl: key => key === 'tool_exposure_settings' ? {mode:'progressive',pinnedGroups:{'sre-oncall':['sre']}} : undefined},
    agent: {
      id: 'sre-oncall',
      name: 'SRE',
      role: 'assistant',
      instructions: '',
      capabilities: [],
      allowedTools: ['read_file', 'k8s_get']
    }
  });
  assert.equal(names(visible).includes('k8s_get'), true);
  assert.equal(names(hidden).includes('k8s_get'), false);
  assert.equal(isOnDemandTool(rawK8s), false);

  const merged = mergeDomainBundles([
    {
      id: 'sre',
      label: 'SRE',
      agents: [
        {
          id: 'sre-oncall',
          name: 'SRE',
          role: 'assistant',
          instructions: '',
          capabilities: [],
          allowedTools: ['k8s_get']
        }
      ],
      tools: [rawK8s, tool('quote_get', 'Get a stock quote')],
      skills: [{ id: 'sre-skill', name: 'SRE Skill', description: 'cluster help' }]
    }
  ]);
  assert.equal(merged.tools.length, 2);
  assert.ok(merged.tools.every((item) => isOnDemandTool(item)));
  assert.equal(isOnDemandTool(rawK8s), false);
  assert.equal(merged.agents[0].domainId, 'sre');
  assert.deepEqual(merged.agents[0].allowedTools, ['k8s_get']);
  assert.equal(merged.skills[0].name, 'SRE Skill');
  assert.equal(isOnDemandTool(merged.agents[0]), false);
  assert.equal(isOnDemandTool(merged.skills[0]), false);
});
