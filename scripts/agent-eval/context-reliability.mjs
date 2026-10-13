/** Long-dialogue fixtures and evidence classification; no model self-grading. */
export function buildContextSuite() {
  const scenarios = [
    { category: 'constraint', first: '切换到任务 Atlas；目标：准备发布计划；约束：仅限 staging-eu 环境；不得部署生产。仅回复收到。', question: 'Continue Atlas. Return only the permitted deployment environment.', answer: 'staging-eu' },
    { category: 'correction', first: '切换到任务 Atlas；目标：准备发布计划；约束：负责人为 Iris。仅回复收到。', middle: ['把“负责人为 Iris”改为“负责人为 Noura”。仅回复收到。'], question: 'Continue Atlas. Return only the current release owner.', answer: 'Noura' },
    { category: 'task-switch', first: '切换到任务 Atlas；目标：准备发布；约束：预算为 73；约束：仅限 sandbox。仅回复收到。', middle: ['切换到任务 Birch；目标：整理文档；约束：预算为 19；约束：只读文档。仅回复收到。', '切回任务 Atlas。仅回复收到。'], question: 'Continue the active task. Return only its budget as a number.', answer: '73' },
    { category: 'post-compact', first: 'Inspection of archive:release-17 found the exact rollback identifier RLB-Q739. Keep the source available; this identifier is not a recommendation.', question: 'What exact rollback identifier did the inspection find? Return only the identifier. Read the source if the summary is insufficient.', answer: 'RLB-Q739', compact: true },
    { category: 'cross-session', first: 'Prepare to locate an earlier deployment decision.', question: 'Search earlier conversations for lighthouse-october. Read the matching original source and return only its approved rollback identifier.', answer: 'RB-X928', previous: 'Deployment decision lighthouse-october: the approved rollback identifier is RB-X928. The rejected alternative was RB-X927.' }
  ];
  return scenarios.flatMap(s => ['normal', 'bot'].map(mode => ({
    id: `${s.category}-${mode}`, category: s.category, critical: true,
    turns: [s.first, ...(s.middle ?? []), s.question], expected: { exact: s.answer, state: {}, ...(s.previous ? { requiredTools: ['history_search', 'history_read'] } : {}) },
    contextSeed: { mode, compact: true, ...(s.previous ? { previous: s.previous } : {}),
      history: Array.from({ length: 64 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Unrelated completed checkpoint ${i + 1}. No changes to the active task or its constraints.`, paddingRepeats: 48 })) },
    script: [s.first, ...(s.middle ?? [])].map(() => ({ text: '收到。' })).concat(s.previous ? [{ tool: 'history_search', input: { query: 'lighthouse-october' } }, { tool: 'history_read', refFromLastSearch: true }] : [], { text: s.answer })
  })));
}

export function summarizeContextEvidence(suite, records, { trials = 1, simulation = false, invalidReasons = [] } = {}) {
  if (!Number.isInteger(trials) || trials < 1) throw new Error('trials must be positive');
  const rows = records.filter(r => r.variant === 'candidate');
  const keys = new Set(), ids = new Set(suite.map(c => c.id));
  const invalid = rows.some(r => {
    const key = `${r.caseId}/${r.trial}`;
    const bad = keys.has(key) || !ids.has(r.caseId) || !Number.isInteger(r.trial) || r.trial < 0 || r.trial >= trials;
    keys.add(key); return bad;
  });
  const live = rows.every(r => !r.skipped && !r.infrastructureError && r.modelCalls > 0 &&
    ['openai-compatible', 'anthropic-compatible'].includes(r.model?.provider) && typeof r.pass === 'boolean' &&
    r.contextEvidence?.seededMessages >= 120 && r.contextEvidence?.compactRounds?.length === 2 &&
    r.contextEvidence.compactRounds.every(round => round.replaced) &&
    (suite.find(c => c.id === r.caseId)?.category !== 'cross-session' || r.contextEvidence.historySourceVerified === true));
  const semanticStatus = invalid || invalidReasons.length > 0 ? 'invalid' : !rows.length ? 'not_run' : simulation || !live ? 'not_validated'
    : rows.length !== suite.length * trials ? 'incomplete' : rows.some(r => !r.pass) ? 'failed' : 'passed_samples';
  return { schemaVersion: 1, semanticStatus, evaluationKind: simulation ? 'simulation' : !rows.length ? 'not_run' : 'live',
    promotionEligible: false, invalidReasons, expectedTrials: suite.length * trials, observedTrials: rows.length,
    categories: Object.fromEntries([...new Set(suite.map(c => c.category))].map(category => {
      const group = rows.filter(r => suite.find(c => c.id === r.caseId)?.category === category);
      return [category, { observed: group.length, recordedPasses: group.filter(r => r.pass === true).length, semanticPasses: !simulation && live ? group.filter(r => r.pass === true).length : null }];
    })),
    limitation: 'Passed samples are descriptive evidence only; this suite does not establish statistical non-inferiority or guarantee future model behavior.' };
}

export function compactRecallPassed(report) {
  return report.skipped !== true && Array.isArray(report.runs) && report.runs.length > 0 &&
    report.runs.every(row => row.recalled === true && !row.error);
}
