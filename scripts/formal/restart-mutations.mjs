/** Real product source faults loaded only in disposable process generations. */
export const MUTATIONS = {
  running: { file: 'packages/core/src/runtime.ts', from: 'recoverBotWork(this.store);', to: "recoverBotWork(this.store); for (const s of this.store.listSessions()) { if (s.metadata?.outcome && s.status !== 'waiting_approval') this.store.updateSession(s.id, { status: 'running' }); }", cases: ['terminal-completed-task-SIGKILL'] },
  retry: { file: 'packages/core/src/runtime.ts', from: 'recoverBotWork(this.store);', to: "recoverBotWork(this.store); queueMicrotask(() => { for (const s of this.store.listSessions()) { if (s.metadata?.outcome?.kind === 'aborted') void this.runSession(s.id).catch(() => {}); } });", cases: ['retry-cancelled-chat-SIGKILL'] },
  approval: { file: 'packages/core/src/runtime.ts', from: 'recoverBotWork(this.store);', to: 'recoverBotWork(this.store); this.store.db.exec("UPDATE approvals SET status=\'pending\' WHERE status=\'approved\'");', cases: ['approval-partial-approved-chat-SIGKILL'] },
};
