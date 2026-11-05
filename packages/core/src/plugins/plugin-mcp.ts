import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { repoOwnedPath } from '../trust/repo-trust.js';
import { pluginMcpCommand, type LoadedPlugin } from './plugin-loader.js';

/** Stdio MCP launch for one granted plugin. `env` is already passed through `sanitizeSpawnEnv`. */
export interface PluginMcpConnectConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function spawnEnv(base?: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized = sanitizeSpawnEnv(base ? { base } : undefined);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * Plugins whose MCP command may be spawned.
 * Ungranted plugins are omitted. An untrusted repo also omits plugins that live inside it.
 */
export function pluginMcpConnectPlan(
  plugins: readonly LoadedPlugin[],
  options: {
    granted: (plugin: LoadedPlugin) => boolean;
    repoRoot?: string;
    repoTrusted?: boolean;
    env?: NodeJS.ProcessEnv;
  }
): PluginMcpConnectConfig[] {
  const env = spawnEnv(options.env);
  const out: PluginMcpConnectConfig[] = [];
  for (const plugin of plugins) {
    if (options.repoTrusted === false && options.repoRoot && repoOwnedPath(options.repoRoot, plugin.root)) continue;
    const cmd = pluginMcpCommand(plugin, options.granted(plugin));
    if (!cmd) continue;
    out.push({ command: cmd.command, args: cmd.args, env });
  }
  return out;
}

/** Call `connect` once per planned server. The caller supplies the spawn, so tests never start a process. */
export async function connectGrantedPluginMcp(
  plugins: readonly LoadedPlugin[],
  options: {
    granted: (plugin: LoadedPlugin) => boolean;
    repoRoot?: string;
    repoTrusted?: boolean;
    env?: NodeJS.ProcessEnv;
  },
  connect: (config: PluginMcpConnectConfig) => Promise<void>
): Promise<number> {
  const plan = pluginMcpConnectPlan(plugins, options);
  for (const config of plan) await connect(config);
  return plan.length;
}
