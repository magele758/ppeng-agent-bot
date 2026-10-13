/**
 * Tool Output Guardian — from chrome-plugin-gemini lib/agent/tool-guardian.js
 *
 * Intercepts long tool results before they pollute LLM context.
 * Archives large output to ArtifactStore and returns a structured preview with Handle.
 * This prevents a single bash output from consuming the entire context window.
 */

export interface ArtifactManifest {
  handle: string;
  sourceTool: string;
  totalChars: number;
  totalPages: number;
  sessionId: string;
  createdAt: string;
}

export interface ArtifactStore {
  save(input: {
    sessionId: string;
    toolName: string;
    content: string;
  }): Promise<ArtifactManifest>;
}

export interface InterceptResult {
  intercepted: boolean;
  content: string;
  originalLength: number;
  handle?: string;
  manifest?: ArtifactManifest;
}

/** Tools that should never be intercepted (meta-tools that read artifacts). */
export const DEFAULT_SKIP_TOOLS = new Set([
  'search_tool_artifact',
  'read_tool_page',
  'recall',
  'remember',
  'read_artifact_page',
  'search_artifact_content',
  'retrieve_tool_result',
  'history_search',
  'history_read',
  'memory_read',
]);

export const DEFAULT_ARCHIVE_THRESHOLD = 1800;
export const DEFAULT_PREVIEW_CHARS = 900;

export function formatToolArchivePreview(
  manifest: ArtifactManifest,
  fullText: string,
  previewChars = DEFAULT_PREVIEW_CHARS
): string {
  const preview = fullText.slice(0, previewChars).trim();
  const truncated = fullText.length > previewChars ? '\n…' : '';
  return (
    `[Tool result archived — context protected]\n` +
    `Source: ${manifest.sourceTool}\n` +
    `Handle: \`${manifest.handle}\` (${manifest.totalPages} pages / ${manifest.totalChars} chars)\n` +
    `Full content stored locally; not injected into context to protect model window.\n\n` +
    `Next step: read the archive before trying another search:\n` +
    `  • Search content: search_tool_artifact(query="...", handle="${manifest.handle}")\n` +
    `  • Read page: read_tool_page(handle="${manifest.handle}", page=1)\n\n` +
    `Preview:\n${preview}${truncated}`
  );
}

export async function interceptToolOutput(input: {
  sessionId?: string;
  toolName: string;
  content: string;
  artifactStore: ArtifactStore;
  threshold?: number;
  previewChars?: number;
  skipTools?: Set<string>;
}): Promise<InterceptResult> {
  const {
    sessionId = 'default',
    toolName,
    content,
    artifactStore,
    threshold = DEFAULT_ARCHIVE_THRESHOLD,
    previewChars = DEFAULT_PREVIEW_CHARS,
    skipTools = DEFAULT_SKIP_TOOLS,
  } = input;

  const text = String(content ?? '');

  if (!toolName || skipTools.has(toolName) || text.length <= threshold) {
    return { intercepted: false, content: text, originalLength: text.length };
  }

  try {
    const manifest = await artifactStore.save({ sessionId, toolName, content: text });
    return {
      intercepted: true,
      handle: manifest.handle,
      originalLength: text.length,
      content: formatToolArchivePreview(manifest, text, previewChars),
      manifest,
    };
  } catch {
    // Fail open — if archival fails, pass through original
    return { intercepted: false, content: text, originalLength: text.length };
  }
}
