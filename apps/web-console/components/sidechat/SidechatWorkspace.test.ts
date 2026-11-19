import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const localRequire = createRequire(import.meta.url);
const source = readFileSync(new URL('./SidechatWorkspace.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true
  },
  fileName: 'SidechatWorkspace.tsx'
}).outputText;

type WorkspaceModule = {
  SidechatWorkspace: React.ComponentType<{
    sessionId: string | null;
    enabled: boolean;
    chat: {
      playMessagesRef: React.RefObject<HTMLDivElement | null>;
      playStickToBottomRef: React.MutableRefObject<boolean>;
      feedScrollIntentRef: React.MutableRefObject<unknown>;
      loadedTranscriptSessionId: string | null;
      sessionMessages: unknown[];
      playInput: string;
      setPlayInput: (next: string) => void;
    };
    onNavigate: (id: string) => Promise<void>;
    children: React.ReactNode;
  }>;
  SidechatDock: () => React.ReactNode;
};

function loadWorkspace({ onBindings }: { onBindings?: (sessionId: string) => void } = {}) {
  const SourceContext = React.createContext<unknown>(null);
  const hookReact = {
    ...React,
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === 'function' ? (initial as () => T)() : initial,
      () => undefined
    ] as const,
    useRef: <T,>(initial: T) => ({ current: initial }),
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined
  };
  const mod = { exports: {} as WorkspaceModule };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return hookReact;
    if (id === 'react/jsx-runtime') return localRequire('react/jsx-runtime');
    if (id === '@/lib/reply-end-actions') return { liveReplyHoldIndex: () => null };
    if (id === './rail-reading-line') return { captureLine: () => null, restoreLine: () => false };
    if (id === './source-dom') return { messageRange: () => null };
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key }) };
    if (id === '../../lib/feed-window') return { readFeedAnchor: () => ({ top: 0 }) };
    if (id === '../../lib/reply-quote') return { replyMessageId: () => '', replySourceText: () => '' };
    if (id === './SidechatPanel') {
      return {
        SidechatPanel: () => null,
        useSidechatDraftBook: () => ({}),
        useSidechatThreads: () => ({ threads: [], refresh: () => undefined, error: undefined })
      };
    }
    if (id === './SourceBindings') {
      return {
        SourceBindings: (props: { sessionId: string }) => {
          onBindings?.(props.sessionId);
          return null;
        }
      };
    }
    if (id === './SourceContext') return { SourceContext };
    if (id === './reading-position') return { restoreTop: () => undefined, revealReadingSpot: async () => '' };
    if (id === '@/lib/sidechat-learning') return { appendCitation: (text: string) => text };
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return { ...mod.exports, SourceContext };
}

function makeChat() {
  return {
    playMessagesRef: { current: null },
    playStickToBottomRef: { current: true },
    feedScrollIntentRef: { current: null },
    loadedTranscriptSessionId: null,
    sessionMessages: [],
    playInput: '',
    setPlayInput: () => undefined
  };
}

function directProviderChildPath(node: React.ReactElement): unknown[] {
  const path: unknown[] = [];
  let cursor: unknown = node;
  while (React.isValidElement(cursor) && typeof cursor.type !== 'string') {
    path.push(cursor.type);
    if (typeof cursor.type === 'function') {
      cursor = (cursor.type as (props: unknown) => React.ReactNode)(cursor.props);
    } else {
      const children = (cursor.props as { children?: React.ReactNode }).children;
      cursor = Array.isArray(children) ? children[0] : children;
    }
  }
  if (React.isValidElement(cursor)) path.push(cursor.type);
  return path;
}

test('切换群聊或 Bot 时 SidechatWorkspace 不卸载重建侧栏子树 [AC:bot-group-click-no-list-refresh#AC-1]', () => {
  const bindingsCalls: string[] = [];
  const { SidechatWorkspace, SidechatDock, SourceContext } = loadWorkspace({
    onBindings: (sessionId) => bindingsCalls.push(sessionId)
  });
  const chat = makeChat();
  const child = React.createElement('section', { id: 'panel-play' }, 'sidebar-list');

  const botState = SidechatWorkspace({
    sessionId: 'sess-1',
    enabled: true,
    chat,
    onNavigate: async () => undefined,
    children: child
  } as React.ComponentProps<typeof SidechatWorkspace>) as React.ReactElement;

  const groupState = SidechatWorkspace({
    sessionId: 'sess-1',
    enabled: false,
    chat,
    onNavigate: async () => undefined,
    children: child
  } as React.ComponentProps<typeof SidechatWorkspace>) as React.ReactElement;

  const noSessionState = SidechatWorkspace({
    sessionId: null,
    enabled: false,
    chat,
    onNavigate: async () => undefined,
    children: child
  } as React.ComponentProps<typeof SidechatWorkspace>) as React.ReactElement;

  const nextBotState = SidechatWorkspace({
    sessionId: 'sess-2',
    enabled: true,
    chat,
    onNavigate: async () => undefined,
    children: child
  } as React.ComponentProps<typeof SidechatWorkspace>) as React.ReactElement;

  assert.equal(typeof botState.type, 'function');
  assert.equal(groupState.type, botState.type, 'clicking group chat must keep root component type stable');
  assert.equal(noSessionState.type, botState.type, 'clearing sessionId must keep root component type stable');
  assert.equal(nextBotState.type, botState.type, 'returning to another Bot must keep root component type stable');

  const botPath = directProviderChildPath(botState);
  const groupPath = directProviderChildPath(groupState);
  const noSessionPath = directProviderChildPath(noSessionState);
  const nextBotPath = directProviderChildPath(nextBotState);
  assert.deepEqual(groupPath, botPath);
  assert.deepEqual(noSessionPath, botPath);
  assert.deepEqual(nextBotPath, botPath);

  const observed: Array<{ hasSource: boolean; hasDock: boolean }> = [];
  function SidebarProbe() {
    const source = React.useContext(SourceContext);
    const dock = SidechatDock();
    observed.push({ hasSource: source !== null, hasDock: dock !== null });
    return React.createElement('aside', { id: 'sessionListMini' }, 'list');
  }

  const probeChild = React.createElement(SidebarProbe);
  const activeHtml = renderToStaticMarkup(
    React.createElement(SidechatWorkspace, { sessionId: 'sess-1', enabled: true, chat, onNavigate: async () => undefined }, probeChild)
  );
  const disabledHtml = renderToStaticMarkup(
    React.createElement(SidechatWorkspace, { sessionId: 'sess-1', enabled: false, chat, onNavigate: async () => undefined }, probeChild)
  );
  const nullHtml = renderToStaticMarkup(
    React.createElement(SidechatWorkspace, { sessionId: null, enabled: false, chat, onNavigate: async () => undefined }, probeChild)
  );

  assert.match(activeHtml, /id="sessionListMini"/);
  assert.match(disabledHtml, /id="sessionListMini"/);
  assert.match(nullHtml, /id="sessionListMini"/);
  assert.deepEqual(observed, [
    { hasSource: true, hasDock: false },
    { hasSource: false, hasDock: false },
    { hasSource: false, hasDock: false }
  ]);
  assert.deepEqual(bindingsCalls, ['sess-1']);
});
