import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpResourceInfo, McpToolInfo } from './mcp-jsonrpc.js';
import { redactSecrets } from './mcp-redact.js';

export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export function parseMcpStdioConfigs(env: NodeJS.ProcessEnv): StdioMcpConfig[] {
  const raw = env.RAW_AGENT_MCP_STDIO?.trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: StdioMcpConfig[] = [];
    for (const item of parsed) {
      const o = item as Record<string, unknown>;
      const command = typeof o.command === 'string' ? o.command : '';
      if (!command) {
        continue;
      }
      const args = Array.isArray(o.args) ? o.args.map((a) => String(a)) : undefined;
      const cwd = typeof o.cwd === 'string' ? o.cwd : undefined;
      const subEnv = o.env && typeof o.env === 'object' ? (o.env as Record<string, string>) : undefined;
      out.push({ command, args, env: subEnv, cwd });
    }
    return out;
  } catch {
    return [];
  }
}

function toolResultToText(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): {
  text: string;
  isError?: boolean;
} {
  const parts = result.content ?? [];
  const text = parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text as string)
    .join('\n');
  return { text: text || JSON.stringify(result), isError: result.isError };
}

/**
 * One long-lived MCP client over stdio (child process).
 */
export class McpStdioSession {
  readonly index: number;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connected = false;

  constructor(
    index: number,
    private readonly config: StdioMcpConfig
  ) {
    this.index = index;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      cwd: this.config.cwd,
      stderr: 'pipe'
    });
    const client = new Client({ name: 'raw-agent', version: '0.1.0' });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this.connected = true;
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.connect();
    const r = await this.client!.listTools();
    return (r.tools ?? []).map((t) =>
      redactStdioTool(
        {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown> | undefined,
          readOnlyHint: typeof t.annotations?.readOnlyHint === 'boolean' ? t.annotations.readOnlyHint : undefined
        },
        this.config.env
      )
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    await this.connect();
    const result = await this.client!.callTool({ name, arguments: args });
    const { text, isError } = toolResultToText(result as { content?: Array<{ type: string; text?: string }>; isError?: boolean });
    return { content: redactStdioFailure(text, this.config.env), isError };
  }

  async listResources(): Promise<McpResourceInfo[]> {
    await this.connect();
    try {
      const r = await this.client!.listResources();
      return (r.resources ?? []).map((res) => ({
        uri: res.uri,
        name: res.name,
        description: res.description,
        mimeType: res.mimeType
      }));
    } catch {
      return [];
    }
  }

  async readResource(uri: string): Promise<{ text: string; mimeType?: string }> {
    await this.connect();
    const r = await this.client!.readResource({ uri });
    const c = r.contents?.[0];
    if (!c) {
      return { text: JSON.stringify(r) };
    }
    if ('text' in c && c.text !== undefined) {
      return { text: c.text as string, mimeType: c.mimeType };
    }
    if ('blob' in c && typeof c.blob === 'string') {
      return { text: `[base64 blob ${c.blob.length} chars]`, mimeType: c.mimeType };
    }
    return { text: JSON.stringify(c), mimeType: c.mimeType };
  }

  async close(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      /* ignore */
    }
    this.connected = false;
    this.client = undefined;
    this.transport = undefined;
  }
}

/** Credential-shaped names only. Ordinary values such as NODE_ENV=production stay intact. */
const STDIO_SECRET_NAME =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|CREDENTIAL|CREDENTIALS|COOKIE|BEARER)($|_)/i;

function stdioSecretValues(env?: Record<string, string>): string[] {
  if (!env) return [];
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!STDIO_SECRET_NAME.test(name) || value.length < 8) continue;
    values.push(value);
  }
  return values;
}

/** Stdio failures and tool text can echo child env. Strip credential values before trace or the model. */
export function redactStdioFailure(message: string, env?: Record<string, string>): string {
  return redactSecrets(message, stdioSecretValues(env));
}

/** Description text only. Schema names, required, and enum values are protocol fields. */
export function redactStdioTool(tool: McpToolInfo, env?: Record<string, string>): McpToolInfo {
  const description = tool.description ? redactStdioFailure(tool.description, env) : tool.description;
  return { ...tool, description };
}

export function sanitizeMcpToolSuffix(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56) || 'tool';
}
