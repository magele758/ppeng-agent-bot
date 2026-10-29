import { createDurableArtifactPort } from '../artifact/durable-artifact-port.js';
import type { ToolContract } from '../types.js';

export function createArtifactTools(): ToolContract<any>[] {
  const readPage: ToolContract<{
    handle: string;
    page?: number;
    startOffset?: number;
    lineStart?: number;
    lineEnd?: number;
    maxChars?: number;
  }> = {
    name: 'read_artifact_page',
    description:
      '读取超长工具结果或附件归档的分页内容。仅当其他工具返回 artifact handle 或 content_mode=paged_artifact 时使用。' +
      ' 顺序浏览用 page；search_artifact_content 返回的 startOffset / lineStart 可精准定位。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'artifact handle' },
        page: { type: 'integer', description: '页码，从 1 开始' },
        startOffset: { type: 'integer', description: '按字符偏移精准读取' },
        lineStart: { type: 'integer', description: '按行范围：起始行（1-based）' },
        lineEnd: { type: 'integer', description: '按行范围：结束行' },
        maxChars: { type: 'integer', description: '本页最多返回字符数' }
      },
      required: ['handle']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      try {
        const handle = String(args.handle ?? '').trim();
        if (!handle) return { ok: false, content: 'handle 必填' };
        const page = createDurableArtifactPort({ stateDir: context.stateDir }).readPage({
          sessionId: context.session.id,
          handle,
          page: args.page,
          startOffset: args.startOffset,
          lineStart: args.lineStart,
          lineEnd: args.lineEnd,
          maxChars: args.maxChars
        });
        return { ok: true, content: JSON.stringify({ success: true, content_mode: 'paged_artifact_page', ...page }, null, 2) };
      } catch (e) {
        return { ok: false, content: e instanceof Error ? e.message : String(e) };
      }
    }
  };

  const search: ToolContract<{
    handle: string;
    query: string;
    mode?: 'substring' | 'regex';
    maxResults?: number;
    contextChars?: number;
  }> = {
    name: 'search_artifact_content',
    description:
      '在归档 artifact 中搜索关键词，返回 page / startOffset / lineStart，可直接交给 read_artifact_page。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        query: { type: 'string' },
        mode: { type: 'string', enum: ['substring', 'regex'] },
        maxResults: { type: 'integer' },
        contextChars: { type: 'integer' }
      },
      required: ['handle', 'query']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      try {
        const handle = String(args.handle ?? '').trim();
        const query = String(args.query ?? '');
        if (!handle || !query) return { ok: false, content: 'handle 与 query 必填' };
        const result = createDurableArtifactPort({ stateDir: context.stateDir }).search({
          sessionId: context.session.id,
          handle,
          query,
          mode: args.mode === 'regex' ? 'regex' : 'substring',
          maxResults: args.maxResults,
          contextChars: args.contextChars
        });
        return { ok: true, content: JSON.stringify({ success: true, ...result }, null, 2) };
      } catch (e) {
        return { ok: false, content: e instanceof Error ? e.message : String(e) };
      }
    }
  };

  return [readPage, search];
}
