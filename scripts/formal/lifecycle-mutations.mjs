/** Mutate current product SOURCE at the ESM loading boundary; no workspace product file is edited. */
export const MUTATIONS = {
  cancel: {
    file: 'packages/core/src/runtime/session-control.ts',
    from: 'controller?.abort();', to: '/* deliberate fault: do not abort the active run */',
  },
  retry: {
    file: 'packages/agent-loop/src/turn/kernel.ts',
    from: "host.store.updateSession(sid, { status: 'failed' }),\n        aborted ? 'abort' : 'model_error',",
    to: "host.store.updateSession(sid, { status: 'running' }),\n        aborted ? 'abort' : 'model_error',",
  },
  approval: {
    file: 'packages/agent-loop/src/turn/kernel.ts',
    from: 'const results = await input.host.executeToolCalls(',
    to: 'await input.host.executeToolCalls(executable, input.context, picked.allowExternalAiTools, input.sessionId, picked.resolvedTools);\n  const results = await input.host.executeToolCalls(',
  },
};
