/**
 * max assembly: full + PTC/vm (dynamic), shell-policy, guardian,
 * vault / otel / cbom / case-governance orchestration via io.
 */

import type { AssembledLoop, CreateAssembledLoopInput } from './io.js';
import { createFullAssembledLoop } from './full-host.js';
import {
  classifyModelTier,
  modelIdentity,
  repeatLimitsActive,
  resolveRepeatGuardMode,
} from '../recovery/repeat-guard.js';
import { DEFAULT_SHELL_POLICY_CONFIG, checkShellPolicy, shellHistoryFromFold } from '../tools/shell-policy.js';
import { interceptToolOutput } from '../tools/tool-result-guardian.js';
import type { ToolExecResult } from '../turn/host.js';

export async function createMaxAssembledLoop(
  input: CreateAssembledLoopInput = {}
): Promise<AssembledLoop> {
  const assembled = await createFullAssembledLoop({ ...input, preset: 'full' });
  const io = input.io ?? {};
  const loaded = new Set(assembled.loadedModules);
  loaded.add('shell-policy');
  if (io.archiveToolResult) loaded.add('guardian');

  const innerExecute = assembled.host.executeToolCalls.bind(assembled.host);
  assembled.host.executeToolCalls = async (
    toolCalls,
    context,
    allowExternal,
    sessionId,
    turnTools
  ) => {
    const gated: typeof toolCalls = [];
    const blockedResults: ToolExecResult[] = [];
    for (const tc of toolCalls) {
      if (tc.name === 'bash' || tc.name === 'exec') {
        const cmd = typeof tc.input.command === 'string' ? tc.input.command : '';
        const history = shellHistoryFromFold(
          assembled.host.store.foldMessages(context.session.id)
        );
        const session = assembled.host.store.getSession(context.session.id) ?? context.session;
        const adapter = assembled.host.resolveModelAdapter?.(session) ?? assembled.host.modelAdapter;
        const historyLimits = repeatLimitsActive(
          resolveRepeatGuardMode(assembled.host.store),
          classifyModelTier(
            modelIdentity({
              modelName: adapter.modelName,
              adapterName: adapter.name,
              metadata: session.metadata,
            })
          )
        );
        const decision = checkShellPolicy(cmd, history, DEFAULT_SHELL_POLICY_CONFIG, { historyLimits });
        if (decision.blocked) {
          blockedResults.push({
            toolCallId: tc.toolCallId,
            name: tc.name,
            ok: false,
            content: decision.reason ?? 'blocked by shell-policy',
          });
          continue;
        }
      }
      gated.push(tc);
    }

    const run = () => innerExecute(gated, context, allowExternal, sessionId, turnTools);
    const raw = io.withSecretRefs
      ? await io.withSecretRefs(run)
      : io.vault?.runWithSecretRefs
        ? await io.vault.runWithSecretRefs(
            io.vault.resolveNamed(io.parseSecretRefs?.(context.session.metadata) ?? {}),
            run
          )
        : await run();

    // Executed tools export their span inside executeSingleTool (normal-host
    // wires io.otel there); only policy-blocked calls need one here.
    for (const r of blockedResults) {
      io.otel?.exportSpan?.(sessionId, `tool.${r.name}`, { ok: 'false', blocked: 'shell-policy' });
    }
    const results = [...raw, ...blockedResults];
    for (const r of results) {
      if (io.archiveToolResult && r.content.length > 1800) {
        const intercepted = await interceptToolOutput({
          sessionId,
          toolName: r.name,
          content: r.content,
          artifactStore: {
            async save(req) {
              const handle = io.archiveToolResult!(req);
              return {
                handle,
                sourceTool: req.toolName,
                totalChars: req.content.length,
                totalPages: 1,
                sessionId: req.sessionId,
                createdAt: new Date().toISOString(),
              };
            },
          },
        });
        r.content = intercepted.content;
      }
    }
    return results;
  };

  if (io.createPtcExecTool) {
    try {
      const extra = await io.createPtcExecTool(assembled.host.tools);
      if (extra && !assembled.host.tools.some((t) => t.name === extra.name)) {
        assembled.host.tools = [...assembled.host.tools, extra];
      }
      if (extra) loaded.add('ptc');
    } catch {
      /* ptc optional */
    }
  }

  if (io.vault || io.withSecretRefs) loaded.add('vault');
  if (io.otel) loaded.add('otel');
  if (io.cbom) loaded.add('cbom');
  if (io.onCaseGovernance) loaded.add('case-governance');
  if (io.resolveTurnTools) loaded.add('dyn-tools');

  if (io.onCaseGovernance) {
    const prev = assembled.host.onSessionOutcome;
    assembled.host.onSessionOutcome = (outcome) => {
      try {
        io.onCaseGovernance?.();
      } catch {
        /* fail-soft */
      }
      prev?.(outcome);
    };
  }

  return {
    ...assembled,
    preset: 'max',
    loadedModules: [...loaded],
  };
}
