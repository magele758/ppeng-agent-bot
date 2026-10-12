import type { ToolContract } from '../types.js';
import { annotateUntrustedField, fenceExternalContent, sanitizeDescriptiveFields } from '../safety/external-content.js';
import { mcpCallArgs } from '../safety/egress.js';
import { appendTraceEvent } from '../stores/trace.js';
import { envBool } from '../env.js';
import { parseMcpHttpEndpoints, type McpHttpEndpoint } from './mcp-http-config.js';
import { McpHttpSession } from './mcp-http.js';
import type { McpToolInfo } from './mcp-jsonrpc.js';
import { McpStdioSession, parseMcpStdioConfigs, sanitizeMcpToolSuffix } from './mcp-stdio.js';
import { minifyMcpToolInputSchema, parseMcpSchemaMinifyLevel } from './mcp-schema-minify.js';

export interface McpManagerDeps {
  stateDir: string;
  tools: ToolContract<any>[];
  env: Record<string, string | undefined>;
  log: { warn: (msg: string) => void };
}

function fenceMcp(label: string, body: string): string {
  return fenceExternalContent({ source: 'mcp', label, body });
}

function presentMcpTool(
  tool: McpToolInfo,
  fallback: string,
  prepare: (schema?: Record<string, unknown>) => Record<string, unknown>
): { description: string; inputSchema: Record<string, unknown> } {
  const raw = tool.description && tool.description.trim() ? tool.description : fallback;
  const schema = sanitizeDescriptiveFields(tool.inputSchema ?? { type: 'object' });
  return {
    description: annotateUntrustedField({ source: 'mcp', label: tool.name || 'tool', text: raw }),
    inputSchema: prepare(schema as Record<string, unknown>)
  };
}

export class McpManager {
  private httpSessions: McpHttpSession[] = [];
  private httpConnectPromise?: Promise<void>;
  private mcpToolsPromise?: Promise<void>;
  private mcpExpansionDone = false;
  private readonly mcpStdioSessions: McpStdioSession[] = [];
  private readonly mcpSchemaMinifyLevel: number;

  constructor(private readonly deps: McpManagerDeps) {
    this.mcpSchemaMinifyLevel = parseMcpSchemaMinifyLevel(deps.env as NodeJS.ProcessEnv);
  }

  private prepareMcpInputSchema(schema?: Record<string, unknown>): Record<string, unknown> {
    const base = schema ?? { type: 'object' };
    return minifyMcpToolInputSchema(base, this.mcpSchemaMinifyLevel);
  }

  get stdioSessions(): McpStdioSession[] {
    return this.mcpStdioSessions;
  }

  httpConnectedCount(): number {
    return this.httpSessions.filter((session) => session.isConnected).length;
  }

  async ensureLoaded(sessionId: string): Promise<void> {
    if (this.mcpExpansionDone) return;
    if (!this.mcpToolsPromise) {
      this.mcpToolsPromise = this.performMcpExpansion(sessionId);
    }
    await this.mcpToolsPromise;
  }

  /**
   * Connect HTTP sessions after tools are registered.
   * `ensureLoaded` connects only when HTTP tools are expanded, so a bare URL
   * does not open the network. Boot and the settings card call this.
   */
  async warmHttp(): Promise<void> {
    await this.ensureLoaded('mcp-warm');
    await this.connectHttp();
  }

  private connectHttp(): Promise<void> {
    if (this.httpSessions.length === 0) return Promise.resolve();
    if (!this.httpConnectPromise) {
      this.httpConnectPromise = this.connectHttpOnce();
    }
    return this.httpConnectPromise;
  }

  private async connectHttpOnce(): Promise<void> {
    for (const session of this.httpSessions) {
      try {
        await session.connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.warn(`MCP HTTP server ${session.index} connect failed: ${message}`);
      }
    }
  }

  private async performMcpExpansion(sessionId: string): Promise<void> {
    const env = this.deps.env as NodeJS.ProcessEnv;
    const endpoints = parseMcpHttpEndpoints(env);
    const stdioConfigs = parseMcpStdioConfigs(env);
    const expandStdio = envBool(env, 'RAW_AGENT_MCP_EXPAND_STDIO', true);
    const expandHttp = envBool(env, 'RAW_AGENT_MCP_EXPAND_HTTP', false);

    if (endpoints.length === 0 && stdioConfigs.length === 0) {
      this.mcpExpansionDone = true;
      return;
    }

    try {
      this.httpSessions = endpoints.map(
        (endpoint, index) =>
          new McpHttpSession(index, endpoint, {
            env,
            onTransportFallback: (info) => {
              this.deps.log.warn(
                `MCP HTTP server ${index} fell back from streamable-http to SSE after HTTP ${info.status} (${info.url})`
              );
            }
          })
      );
      this.registerHttpTools(endpoints);
      if (expandHttp) await this.connectHttp();
      if (expandHttp) await this.expandListedHttpTools();
      await this.connectStdioMcpServers(stdioConfigs, expandStdio, sessionId);
      this.registerResourceTools();
    } finally {
      this.mcpExpansionDone = true;
    }
  }

  private registerHttpTools(endpoints: McpHttpEndpoint[]): void {
    if (endpoints.length === 0 || this.deps.tools.some((tool) => tool.name === 'mcp_invoke')) return;
    const sessions = this.httpSessions;
    this.deps.tools.push({
      name: 'mcp_invoke',
      description:
        'Invoke a tool on an HTTP MCP server. server is the 0-based index into RAW_AGENT_MCP_HTTP, then legacy RAW_AGENT_MCP_URLS.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'number', description: 'MCP server index (from env URL list)' },
          tool: { type: 'string' },
          arguments: { type: 'object' }
        },
        required: ['server', 'tool']
      },
      approvalMode: 'auto',
      sideEffectLevel: 'system',
      needsApproval: () => true,
      execute: async (_ctx, args: { server: number; tool: string; arguments?: Record<string, unknown> }) => {
        const index = Math.floor(args.server);
        const session = sessions[index];
        if (!session) return { ok: false, content: `Invalid MCP server index ${args.server}` };
        const callArgs = mcpCallArgs(args.arguments ?? {});
        try {
          const out = await session.callTool(args.tool, callArgs);
          return { ok: !out.isError, content: fenceMcp(args.tool, out.content) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, content: fenceMcp(args.tool, message) };
        }
      }
    } as ToolContract<{ server: number; tool: string; arguments?: Record<string, unknown> }>);
  }

  private async expandListedHttpTools(): Promise<void> {
    for (const session of this.httpSessions) {
      let listed: McpToolInfo[] = [];
      try {
        listed = await session.listTools();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.warn(`Failed to list tools from MCP HTTP server ${session.index}: ${message}`);
        continue;
      }
      const hi = session.index;
      for (const tool of listed) {
        const name = `mcp_h${hi}_${sanitizeMcpToolSuffix(tool.name)}`;
        if (this.deps.tools.some((existing) => existing.name === name)) continue;
        const toolName = tool.name;
        const presented = presentMcpTool(tool, `MCP HTTP server ${hi} tool ${toolName}`, (schema) =>
          this.prepareMcpInputSchema(schema)
        );
        this.deps.tools.push({
          name,
          description: presented.description,
          inputSchema: presented.inputSchema,
          approvalMode: 'auto',
          sideEffectLevel: 'system',
          needsApproval: () => true,
          execute: async (_ctx, args) => {
            const callArgs = mcpCallArgs((args ?? {}) as Record<string, unknown>);
            try {
              const out = await session.callTool(toolName, callArgs);
              return { ok: !out.isError, content: fenceMcp(toolName, out.content) };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { ok: false, content: fenceMcp(toolName, message) };
            }
          }
        });
      }
    }
  }

  private async connectStdioMcpServers(
    stdioConfigs: ReturnType<typeof parseMcpStdioConfigs>,
    expandStdio: boolean,
    sessionId: string
  ): Promise<void> {
    for (let si = 0; si < stdioConfigs.length; si++) {
      const cfg = stdioConfigs[si];
      if (!cfg) continue;
      const session = new McpStdioSession(si, cfg);
      try {
        await session.connect();
        this.mcpStdioSessions.push(session);
        if (!expandStdio) continue;
        const listed = await session.listTools();
        for (const tool of listed) {
          const name = `mcp_s${si}_${sanitizeMcpToolSuffix(tool.name)}`;
          if (this.deps.tools.some((existing) => existing.name === name)) continue;
          const toolName = tool.name;
          const presented = presentMcpTool(tool, `MCP stdio server ${si} tool ${toolName}`, (schema) =>
            this.prepareMcpInputSchema(schema)
          );
          this.deps.tools.push({
            name,
            description: presented.description,
            inputSchema: presented.inputSchema,
            approvalMode: 'auto',
            sideEffectLevel: 'system',
            needsApproval: () => true,
            execute: async (_ctx, args) => {
              const callArgs = mcpCallArgs((args ?? {}) as Record<string, unknown>);
              try {
                const out = await session.callTool(toolName, callArgs);
                return { ok: !out.isError, content: fenceMcp(toolName, out.content) };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false, content: fenceMcp(toolName, message) };
              }
            }
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void appendTraceEvent(this.deps.stateDir, sessionId, {
          kind: 'model_error',
          payload: { mcpStdio: si, message }
        });
      }
    }
  }

  private registerResourceTools(): void {
    const httpSessions = this.httpSessions;
    const totalServers = httpSessions.length + this.mcpStdioSessions.length;
    if (totalServers === 0) return;
    const mgr = this;

    if (!this.deps.tools.some((tool) => tool.name === 'mcp_list_resources')) {
      this.deps.tools.push({
        name: 'mcp_list_resources',
        description:
          'List MCP resources. server index: 0..N-1 where HTTP endpoints (RAW_AGENT_MCP_HTTP, then RAW_AGENT_MCP_URLS) come first, then stdio servers.',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'number' } },
          required: ['server']
        },
        approvalMode: 'auto',
        sideEffectLevel: 'system',
        needsApproval: () => false,
        execute: async (_ctx, args: { server: number }) => {
          const index = Math.floor(args.server);
          if (index < 0 || index >= totalServers) return { ok: false, content: `Invalid server ${args.server}` };
          if (index < httpSessions.length) {
            const session = httpSessions[index];
            if (!session) return { ok: false, content: 'Invalid URL index' };
            try {
              const listed = await session.listResources();
              return { ok: true, content: fenceMcp('resources', JSON.stringify(listed, null, 2)) };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { ok: false, content: fenceMcp('resources', message) };
            }
          }
          const stdio = mgr.mcpStdioSessions[index - httpSessions.length];
          if (!stdio) return { ok: false, content: 'Stdio server not connected' };
          try {
            const listed = await stdio.listResources();
            return { ok: true, content: fenceMcp('resources', JSON.stringify(listed, null, 2)) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, content: fenceMcp('resources', message) };
          }
        }
      } as ToolContract<{ server: number }>);
    }

    if (!this.deps.tools.some((tool) => tool.name === 'mcp_read_resource')) {
      this.deps.tools.push({
        name: 'mcp_read_resource',
        description: 'Read one MCP resource by URI (same server indexing as mcp_list_resources).',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'number' }, uri: { type: 'string' } },
          required: ['server', 'uri']
        },
        approvalMode: 'auto',
        sideEffectLevel: 'system',
        needsApproval: () => true,
        execute: async (_ctx, args: { server: number; uri: string }) => {
          const index = Math.floor(args.server);
          if (index < 0 || index >= totalServers) return { ok: false, content: `Invalid server ${args.server}` };
          if (index < httpSessions.length) {
            const session = httpSessions[index];
            if (!session) return { ok: false, content: 'Invalid URL index' };
            try {
              const resource = await session.readResource(args.uri);
              const text = resource.mimeType ? `${resource.mimeType}\n\n${resource.text}` : resource.text;
              return { ok: true, content: fenceMcp(args.uri, text) };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { ok: false, content: fenceMcp(args.uri, message) };
            }
          }
          const stdio = mgr.mcpStdioSessions[index - httpSessions.length];
          if (!stdio) return { ok: false, content: 'Stdio server not connected' };
          try {
            const resource = await stdio.readResource(args.uri);
            const text = resource.mimeType ? `${resource.mimeType}\n\n${resource.text}` : resource.text;
            return { ok: true, content: fenceMcp(args.uri, text) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, content: fenceMcp(args.uri, message) };
          }
        }
      } as ToolContract<{ server: number; uri: string }>);
    }
  }

  async destroy(): Promise<void> {
    for (const session of this.httpSessions) {
      try {
        await session.close();
      } catch {
        /* best effort */
      }
    }
    this.httpSessions = [];
    this.httpConnectPromise = undefined;
    for (const session of this.mcpStdioSessions) {
      try {
        await session.close();
      } catch {
        /* best effort */
      }
    }
    this.mcpStdioSessions.length = 0;
  }
}
