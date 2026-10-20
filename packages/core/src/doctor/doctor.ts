/**
 * Doctor: local self-check for env / plugins / gateway / sandbox / skills.
 * Never prints secret values — only presence / shape.
 */

import { existsSync, accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pluginDirsFromEnv, discoverPlugins } from '../plugins/plugin-loader.js';
import { findGatewayConfigPath } from '../gateway-config-channels.js';
import type { CloudflareComputerHealthProbe } from '../sandbox/cloudflare-computer-client.js';
import {
  resolveCloudflareComputer,
  resolveSandboxMode,
  SANDBOX_MODES,
  type SandboxSettingsStore
} from '../sandbox/sandbox-settings.js';
import type { SecretVault } from '../secrets/secret-vault.js';

const requireFromHere = createRequire(import.meta.url);
const PLAYWRIGHT_INSTALL_HINT =
  'pnpm exec playwright install chromium（仓库根目录已有 @playwright/test 时可直接执行）';

export type DoctorSeverity = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  severity: DoctorSeverity;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checkedAt: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
}

export interface DoctorOptions {
  repoRoot: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  store?: SandboxSettingsStore;
  secretVault?: SecretVault;
  /** Injected GET /health probe — never POST /exec (that can bill). */
  cloudflareProbe?: CloudflareComputerHealthProbe;
}

function push(
  checks: DoctorCheck[],
  id: string,
  title: string,
  severity: DoctorSeverity,
  detail: string,
  hint?: string
): void {
  checks.push({ id, title, severity, detail, hint });
}

export function runDoctor(opts: DoctorOptions): DoctorReport {
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const repoRoot = opts.repoRoot;
  const stateDir = opts.stateDir ?? env.RAW_AGENT_STATE_DIR?.trim() ?? join(repoRoot, '.raw-agent');

  // Node
  const major = Number(process.versions.node.split('.')[0] ?? 0);
  if (major >= 22) {
    push(checks, 'node', 'Node.js version', 'ok', `v${process.versions.node}`);
  } else {
    push(checks, 'node', 'Node.js version', 'fail', `v${process.versions.node}`, 'Need Node >= 22');
  }

  // Model env (presence only)
  const baseUrl = env.RAW_AGENT_BASE_URL?.trim();
  const apiKey = env.RAW_AGENT_API_KEY?.trim();
  const model = env.RAW_AGENT_MODEL_NAME?.trim();
  if (baseUrl && apiKey && model) {
    push(
      checks,
      'model_env',
      'Model credentials',
      'ok',
      `BASE_URL set, API_KEY present (${apiKey.length} chars), model=${model}（.env 回退；优先在 Lab 配置服务商）`
    );
  } else {
    const missing = [
      !baseUrl && 'RAW_AGENT_BASE_URL',
      !apiKey && 'RAW_AGENT_API_KEY',
      !model && 'RAW_AGENT_MODEL_NAME'
    ].filter(Boolean);
    push(
      checks,
      'model_env',
      'Model credentials',
      'warn',
      `未配置 .env 回退（${missing.join(', ')}）`,
      '在 Agent Lab「更多 → 模型服务商」填写 Base URL / API Key 并扫描模型；.env 仅作从未保存过时的回退'
    );
  }

  // State dir
  try {
    if (!existsSync(stateDir)) {
      push(checks, 'state_dir', 'State directory', 'warn', `${stateDir} does not exist yet`, 'Daemon creates it on first boot');
    } else {
      accessSync(stateDir, constants.R_OK | constants.W_OK);
      push(checks, 'state_dir', 'State directory', 'ok', stateDir);
    }
  } catch {
    push(checks, 'state_dir', 'State directory', 'fail', `Not writable: ${stateDir}`);
  }

  // Sandbox
  const sandboxMode = resolveSandboxMode(opts.store, env);
  const sandboxSource = opts.store ? 'lab_or_env' : 'env';
  push(
    checks,
    'sandbox',
    'Sandbox mode',
    (SANDBOX_MODES as readonly string[]).includes(sandboxMode) ? 'ok' : 'warn',
    `${sandboxSource}=${sandboxMode}`,
    sandboxMode === 'direct' ? 'direct skips OS sandbox — use only in trusted envs' : undefined
  );

  const cf = resolveCloudflareComputer(opts.store, env, opts.secretVault);
  if (sandboxMode === 'cloudflare-computer' || cf.endpoint) {
    const configured = Boolean(cf.endpoint);
    const bits = [
      configured ? `endpoint set` : 'endpoint missing',
      `workspace=${cf.workspaceName}`,
      `token=${cf.tokenPresent ? `present (${cf.tokenSource})` : 'absent'}`
    ];
    if (cf.accountId) bits.push('account tagged');
    if (cf.backend) bits.push(`backend=${cf.backend}`);
    const probe = opts.cloudflareProbe;
    if (probe?.probed) {
      bits.push(probe.reachable ? `reachable ${probe.path}` : `unreachable: ${probe.detail}`);
    } else if (configured) {
      bits.push('reachability not probed');
    }
    const severity: DoctorSeverity =
      sandboxMode === 'cloudflare-computer' && !configured
        ? 'warn'
        : probe?.probed && !probe.reachable && sandboxMode === 'cloudflare-computer'
          ? 'warn'
          : 'ok';
    push(
      checks,
      'cloudflare_computer',
      'Cloudflare Computer',
      severity,
      bits.join('; '),
      sandboxMode === 'cloudflare-computer' && !configured
        ? 'Lab 沙箱填写 Worker endpoint；token 用密钥库名或 CLOUDFLARE_COMPUTER_TOKEN'
        : undefined
    );
  } else {
    push(
      checks,
      'cloudflare_computer',
      'Cloudflare Computer',
      'ok',
      'idle (auto 不选用；需在 Lab 沙箱显式选择 cloudflare-computer)'
    );
  }

  // Skills
  const agentsSkillsOff = env.RAW_AGENT_AGENTS_SKILLS === '0';
  const skillsDir = env.RAW_AGENT_AGENTS_SKILLS_DIR?.trim() || join(process.env.HOME ?? '', '.agents');
  if (agentsSkillsOff) {
    push(checks, 'skills', 'User skills (~/.agents)', 'ok', 'Disabled via RAW_AGENT_AGENTS_SKILLS=0');
  } else if (existsSync(skillsDir)) {
    push(checks, 'skills', 'User skills (~/.agents)', 'ok', `Found ${skillsDir}`);
  } else {
    push(checks, 'skills', 'User skills (~/.agents)', 'warn', `${skillsDir} missing`, 'Optional; repo skills/ still load');
  }
  const repoSkills = join(repoRoot, 'skills');
  if (existsSync(repoSkills)) {
    push(checks, 'repo_skills', 'Repo skills/', 'ok', repoSkills);
  } else {
    push(checks, 'repo_skills', 'Repo skills/', 'warn', 'skills/ not found under repo root');
  }

  // Plugins
  const pluginDirs = pluginDirsFromEnv(env);
  if (pluginDirs.length === 0) {
    push(checks, 'plugins', 'Plugins', 'ok', 'RAW_AGENT_PLUGINS_DIR unset (optional)');
  } else {
    const found = discoverPlugins(pluginDirs);
    const missing = pluginDirs.filter((d) => !existsSync(d));
    if (missing.length) {
      push(
        checks,
        'plugins',
        'Plugins',
        'warn',
        `Dirs missing: ${missing.join(', ')}; loaded ${found.length} plugin(s)`
      );
    } else {
      push(
        checks,
        'plugins',
        'Plugins',
        'ok',
        `Loaded ${found.length} plugin(s) from ${pluginDirs.length} dir(s)`
      );
    }
  }

  // Gateway config
  try {
    const gwPath = findGatewayConfigPath(repoRoot);
    if (gwPath) {
      push(checks, 'gateway', 'Gateway config', 'ok', gwPath);
    } else {
      push(
        checks,
        'gateway',
        'Gateway config',
        'warn',
        'No gateway.config.json found',
        'Optional unless messaging/learn is enabled'
      );
    }
  } catch (e) {
    push(checks, 'gateway', 'Gateway config', 'warn', e instanceof Error ? e.message : String(e));
  }

  // Permission / hooks surface
  const perm = env.RAW_AGENT_PERMISSION_MODE?.trim();
  if (perm && !['plan', 'ask', 'acceptEdits', 'auto', 'bypass'].includes(perm)) {
    push(checks, 'permission_mode', 'Permission mode env', 'fail', `Invalid RAW_AGENT_PERMISSION_MODE=${perm}`);
  } else {
    push(
      checks,
      'permission_mode',
      'Permission mode env',
      'ok',
      perm ? `RAW_AGENT_PERMISSION_MODE=${perm}` : 'default auto (session can override)'
    );
  }

  // Optional feature flags summary
  const flags = [
    env.RAW_AGENT_BROWSER_TOOLS === '1' && 'browser',
    env.RAW_AGENT_CRON_TOOLS === '1' && 'cron',
    env.RAW_AGENT_EXTERNAL_AI_TOOLS === '1' && 'external_ai',
    env.RAW_AGENT_A2UI_ENABLED === '1' && 'a2ui'
  ].filter(Boolean);
  push(
    checks,
    'feature_flags',
    'Optional features',
    'ok',
    flags.length ? `enabled: ${flags.join(', ')}` : 'no optional feature flags set'
  );

  {
    let pwOk = false;
    try {
      requireFromHere.resolve('playwright');
      pwOk = true;
    } catch {
      try {
        requireFromHere.resolve('playwright-core');
        pwOk = true;
      } catch {
        pwOk = false;
      }
    }
    push(
      checks,
      'browser_playwright',
      'Playwright browser',
      pwOk ? 'ok' : 'warn',
      pwOk
        ? 'playwright 模块已安装；若工具报 browser_not_installed / launch 失败，请安装 Chromium 二进制'
        : 'playwright 模块未安装，browser_* 工具会返回结构化错误（非假成功）',
      PLAYWRIGHT_INSTALL_HINT
    );
  }

  // Dist presence (dev hygiene)
  const coreDist = join(repoRoot, 'packages', 'core', 'dist', 'runtime.js');
  if (existsSync(coreDist)) {
    push(checks, 'build', 'Core build (dist)', 'ok', 'packages/core/dist present');
  } else {
    push(checks, 'build', 'Core build (dist)', 'warn', 'packages/core/dist missing', 'Run: pnpm exec tsc -b packages/core');
  }

  const summary = {
    ok: checks.filter((c) => c.severity === 'ok').length,
    warn: checks.filter((c) => c.severity === 'warn').length,
    fail: checks.filter((c) => c.severity === 'fail').length
  };

  return {
    ok: summary.fail === 0,
    checkedAt: new Date().toISOString(),
    checks,
    summary
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `ppeng doctor — ${report.ok ? 'OK' : 'ISSUES'} (${report.summary.ok} ok / ${report.summary.warn} warn / ${report.summary.fail} fail)`,
    `checkedAt: ${report.checkedAt}`,
    ''
  ];
  for (const c of report.checks) {
    const tag = c.severity.toUpperCase().padEnd(4);
    lines.push(`[${tag}] ${c.title}: ${c.detail}`);
    if (c.hint) lines.push(`       hint: ${c.hint}`);
  }
  return lines.join('\n');
}
