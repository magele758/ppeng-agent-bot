export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnlyHint?: boolean;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Legacy URL list. HTTP transport lives in `mcp-http.ts`. */
export function parseMcpUrls(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RAW_AGENT_MCP_URLS ?? env.RAW_AGENT_MCP_URL ?? '';
  return raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
