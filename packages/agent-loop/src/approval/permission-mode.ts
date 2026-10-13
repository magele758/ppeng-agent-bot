/**
 * Session permission modes (Claude Code-inspired spectrum).
 *
 * - plan: deny side-effect tools (write/edit/bash/bg/external); allow read-only
 * - ask: every non-never tool requires approval (unless already approved)
 * - acceptEdits: auto-approve write_file/edit_file/notebook_edit; other auto tools still ask
 * - auto: defer to tool.approvalMode + needsApproval + policy (default product behavior)
 * - bypass: never require approval (dangerous; opt-in only)
 */
export type PermissionMode = 'plan' | 'ask' | 'acceptEdits' | 'auto' | 'bypass';

const VALID: ReadonlySet<string> = new Set(['plan', 'ask', 'acceptEdits', 'auto', 'bypass']);

const MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  ask: 1,
  acceptEdits: 2,
  auto: 3,
  bypass: 4
};

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep_files',
  'glob_files',
  'web_fetch',
  'web_search',
  'vision_analyze',
  'memory_get',
  'memory_search',
  'memory_list',
  'retrieve_tool_result',
  'list_team',
  'read_inbox',
  'load_skill',
  'search_skills',
  'TodoWrite',
  'task_list',
  'task_get',
  'lsp_request',
  'browser_snapshot',
  'cron_list'
]);

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit']);

export function parsePermissionMode(raw: unknown): PermissionMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  return VALID.has(v) ? (v as PermissionMode) : undefined;
}

function envModeFromInput(
  envOrMode?: string | NodeJS.ProcessEnv
): string | undefined {
  if (typeof envOrMode === 'string') return envOrMode;
  return envOrMode?.RAW_AGENT_PERMISSION_MODE;
}

/**
 * Session metadata wins. Second arg accepts A's string (`PERMISSION_MODE`)
 * or B's `process.env` (`RAW_AGENT_PERMISSION_MODE`).
 */
export function resolvePermissionMode(
  sessionMetadata: Record<string, unknown> | undefined,
  envOrMode?: string | NodeJS.ProcessEnv
): PermissionMode {
  const fromSession = parsePermissionMode(sessionMetadata?.permissionMode);
  if (fromSession) return fromSession;
  const fromEnv = parsePermissionMode(envModeFromInput(envOrMode));
  return fromEnv ?? 'auto';
}

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

export function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Read-only: side-effect tools (write/edit/bash/external) are denied';
    case 'ask':
      return 'Every non-readonly tool requires human approval';
    case 'acceptEdits':
      return 'Auto-approve file edits; other risky tools still ask';
    case 'auto':
      return 'Defer to tool.approvalMode + policy + needsApproval';
    case 'bypass':
      return 'Never require approval (dangerous)';
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

/** Elevate = more autonomous; demote = more restrictive. */
export function shiftPermissionMode(
  current: PermissionMode,
  direction: 'elevate' | 'demote'
): PermissionMode {
  const order: PermissionMode[] = ['plan', 'ask', 'acceptEdits', 'auto', 'bypass'];
  const i = order.indexOf(current);
  if (direction === 'elevate') return order[Math.min(order.length - 1, i + 1)]!;
  return order[Math.max(0, i - 1)]!;
}

export function comparePermissionMode(a: PermissionMode, b: PermissionMode): number {
  return MODE_RANK[a] - MODE_RANK[b];
}

export type PermissionModeGate =
  | { action: 'proceed' }
  | { action: 'deny'; reason: string; code: string; remediation: string }
  | { action: 'require_approval'; reason: string; code: string; remediation: string };

/**
 * Apply permission mode before tool.approvalMode / file policy.
 * Returns undefined when the mode does not force a decision (caller continues).
 */
export function applyPermissionModeGate(
  mode: PermissionMode,
  toolName: string,
  toolApprovalMode: 'never' | 'auto' | 'always'
): PermissionModeGate | undefined {
  if (mode === 'bypass') {
    return { action: 'proceed' };
  }

  if (mode === 'plan') {
    if (isReadOnlyTool(toolName) || toolApprovalMode === 'never') {
      if (
        toolName === 'bash' ||
        toolName === 'bg_run' ||
        toolName === 'write_file' ||
        toolName === 'edit_file' ||
        toolName.startsWith('claude_') ||
        toolName.startsWith('codex_') ||
        toolName.startsWith('cursor_')
      ) {
        return {
          action: 'deny',
          code: 'PERMISSION_MODE_PLAN_SIDE_EFFECT',
          reason: `permissionMode=plan blocks side-effect tool ${toolName}`,
          remediation:
            'Elevate session permissionMode to ask|acceptEdits|auto via PATCH /api/sessions/:id { permissionMode } or CLI: session permission <id> elevate'
        };
      }
      return { action: 'proceed' };
    }
    return {
      action: 'deny',
      code: 'PERMISSION_MODE_PLAN_READONLY',
      reason: `permissionMode=plan allows only read-only tools (blocked: ${toolName})`,
      remediation:
        'Switch to ask (approve each call) or auto. Example: PATCH /api/sessions/:id {"permissionMode":"ask"}'
    };
  }

  if (mode === 'ask') {
    if (toolApprovalMode === 'never' && isReadOnlyTool(toolName)) {
      return { action: 'proceed' };
    }
    return {
      action: 'require_approval',
      code: 'PERMISSION_MODE_ASK',
      reason: `permissionMode=ask requires approval for ${toolName}`,
      remediation: 'Approve via POST /api/approvals/:id or elevate to acceptEdits/auto/bypass'
    };
  }

  if (mode === 'acceptEdits') {
    if (isEditTool(toolName)) {
      return { action: 'proceed' };
    }
    return undefined;
  }

  return undefined;
}

/** Explain what a mode would do for a given tool (Lab UX). */
export function explainToolUnderMode(
  mode: PermissionMode,
  toolName: string,
  toolApprovalMode: 'never' | 'auto' | 'always' = 'auto'
): {
  mode: PermissionMode;
  toolName: string;
  decision: 'proceed' | 'deny' | 'require_approval' | 'defer_to_policy';
  reason: string;
  remediation?: string;
} {
  const gate = applyPermissionModeGate(mode, toolName, toolApprovalMode);
  if (!gate) {
    return {
      mode,
      toolName,
      decision: 'defer_to_policy',
      reason: `mode=${mode} does not force a decision; tool.approvalMode=${toolApprovalMode} + policy apply`
    };
  }
  if (gate.action === 'proceed') {
    return { mode, toolName, decision: 'proceed', reason: `mode=${mode} allows ${toolName}` };
  }
  return {
    mode,
    toolName,
    decision: gate.action,
    reason: gate.reason,
    remediation: gate.remediation
  };
}
