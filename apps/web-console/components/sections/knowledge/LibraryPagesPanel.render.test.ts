import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const localRequire = createRequire(import.meta.url);

type HookState = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  pages: Array<{
    id: string;
    title: string;
    revision: number;
    shareId: string;
    sharePath: string;
    createdAt: string;
    updatedAt: string;
  }>;
  loaded: boolean;
  busy: boolean;
  selectedId: string | null;
  detail: {
    id: string;
    title: string;
    revision: number;
    shareId: string;
    sharePath: string;
    createdAt: string;
    updatedAt: string;
    markdown: string;
  } | null;
  msg: string | null;
  err: string | null;
  load: () => Promise<void>;
  open: (id: string) => Promise<void>;
  back: () => void;
  copyShare: (sharePath: string) => Promise<void>;
  rotate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  create?: (title: string, markdown: string) => Promise<void>;
  update?: (id: string, updates: { title?: string; markdown?: string }) => Promise<void>;
  revisions: Array<{ revision: number; createdAt: string; title: string }>;
  revisionPreview: null | {
    pageId: string;
    revision: number;
    title: string;
    markdown: string;
    createdAt: string;
  };
  openRevision: (id: string, revision: number) => Promise<void>;
  restoreRevision: (id: string, revision: number) => Promise<void>;
};

const noopAsync = async () => undefined;

function translate(key: string, vars?: Record<string, string | number>) {
  const table: Record<string, string> = {
    'knowledge.pages.title': 'Pages',
    'knowledge.pages.desc': 'Library pages',
    'knowledge.pages.back': 'Back',
    'knowledge.pages.refresh': 'Refresh',
    'knowledge.pages.loading': 'Loading…',
    'knowledge.pages.empty': 'No pages yet',
    'knowledge.pages.open': 'Open',
    'knowledge.pages.copyShare': 'Copy share',
    'knowledge.pages.rotate': 'Rotate',
    'knowledge.pages.rotating': 'Rotating…',
    'knowledge.pages.delete': 'Delete',
    'knowledge.pages.deleting': 'Deleting…',
    'knowledge.pages.revision': 'rev {n}',
    'knowledge.pages.sharePath': 'Share',
    'knowledge.pages.updatedAt': 'Updated {time}',
    'knowledge.pages.body': 'Body',
    'knowledge.pages.save': 'Save',
    'knowledge.pages.saving': 'Saving…',
    'knowledge.pages.markdownPlaceholder': 'markdown',
    'knowledge.pages.titlePlaceholder': 'title',
    'knowledge.pages.create': 'Create',
    'knowledge.pages.creating': 'Creating…',
    'knowledge.pages.revisionsTitle': 'Revision history',
    'knowledge.pages.revisionsEmpty': 'No revisions yet.',
    'knowledge.pages.revisionAt': 'r{n} · {time}',
    'knowledge.pages.openRevision': 'Open',
    'knowledge.pages.restoreRevision': 'Restore',
    'knowledge.pages.restoringRevision': 'Restoring…'
  };
  let text = table[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

function samplePage(id = 'page_1') {
  return {
    id,
    title: `Title ${id}`,
    revision: 2,
    shareId: `share_${id}`,
    sharePath: `/pages/share_${id}`,
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T01:00:00Z',
    markdown: '# hello'
  };
}

let hookState: HookState;

function loadPanel() {
  const source = readFileSync(new URL('./LibraryPagesPanel.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as { LibraryPagesPanel?: React.ComponentType } };
  const req = (id: string) => {
    if (id.endsWith('.css') || id.endsWith('.module.css')) return {};
    if (id === 'react') return React;
    if (id === '../../ui' || id.endsWith('/ui') || id.endsWith('/ui/index')) {
      return {
        SettingsGroup: ({
          id: groupId,
          title,
          description,
          children
        }: {
          id?: string;
          title?: string;
          description?: string;
          children?: React.ReactNode;
        }) =>
          React.createElement(
            'section',
            { 'data-testid': 'settings-group', id: groupId, 'data-title': title, 'data-desc': description },
            children
          )
      };
    }
    if (id === './use-library-pages' || id.endsWith('/use-library-pages') || id.endsWith('/use-library-pages.ts')) {
      return { useLibraryPages: () => hookState };
    }
    if (id === './library-pages-model' || id.endsWith('/library-pages-model') || id.endsWith('/library-pages-model.ts')) {
      return {};
    }
    if (
      id === './library-pages-revisions' ||
      id.endsWith('/library-pages-revisions') ||
      id.endsWith('/library-pages-revisions.tsx') ||
      id.endsWith('/library-pages-revisions.ts')
    ) {
      return {
        PageRevisionsSection: () =>
          React.createElement('div', { 'data-testid': 'library-pages-revisions' }, 'revisions')
      };
    }
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', 'React', compiled)(req, mod, mod.exports, React);
  return mod.exports.LibraryPagesPanel!;
}

function baseState(overrides: Partial<HookState> = {}): HookState {
  return {
    t: translate,
    pages: [],
    loaded: false,
    busy: false,
    selectedId: null,
    detail: null,
    msg: null,
    err: null,
    load: noopAsync,
    open: noopAsync,
    back: () => undefined,
    copyShare: noopAsync,
    rotate: noopAsync,
    remove: noopAsync,
    create: noopAsync,
    update: noopAsync,
    revisions: [],
    revisionPreview: null,
    openRevision: noopAsync,
    restoreRevision: noopAsync,
    ...overrides
  };
}

function render(overrides: Partial<HookState> = {}) {
  hookState = baseState(overrides);
  const Panel = loadPanel();
  return renderToStaticMarkup(React.createElement(Panel));
}

test('loading state shows muted hint [AC:lab-library-pages#AC-1]', () => {
  const html = render({ loaded: false, err: null });
  assert.match(html, /Loading…/);
  assert.doesNotMatch(html, /library-pages-list/);
});

test('empty loaded list shows empty marker', () => {
  const html = render({ loaded: true, pages: [] });
  assert.match(html, /id="libraryPagesEmpty"/);
  assert.match(html, /No pages yet/);
});

test('loaded pages render list actions', () => {
  const page = samplePage();
  const html = render({ loaded: true, pages: [page] });
  assert.match(html, /data-testid="library-pages-list"/);
  assert.match(html, /Title page_1/);
  assert.match(html, /\/pages\/share_page_1/);
  assert.match(html, /Open/);
  assert.match(html, /Copy share/);
  assert.match(html, /Rotate/);
  assert.match(html, /Delete/);
  assert.match(html, /Refresh/);
});

test('selected detail shows markdown and back control', () => {
  const page = samplePage();
  const html = render({
    loaded: true,
    selectedId: page.id,
    detail: page,
    pages: [page]
  });
  assert.match(html, /data-testid="library-pages-detail"/);
  assert.match(html, /data-testid="library-pages-markdown"/);
  assert.match(html, /# hello/);
  assert.match(html, /Back/);
  assert.doesNotMatch(html, /library-pages-list/);
});

test('status and error lines render when set', () => {
  const withMsg = render({ loaded: true, pages: [], msg: 'Copied' });
  assert.match(withMsg, /role="status"/);
  assert.match(withMsg, /Copied/);
  const withErr = render({ loaded: true, pages: [], err: 'boom' });
  assert.match(withErr, /role="alert"/);
  assert.match(withErr, /boom/);
});
