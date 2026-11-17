const matrix = new Set([13, 14, 15, 16, 18].flatMap(size => ['zh', 'en'].flatMap(
  lang => [640, 1280].map(width => [size, lang, width].join('/'))
)));

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

function valid(run) {
  return run?.status === 'passed' && Number.isFinite(run.elapsedMs) && run.elapsedMs > 0 &&
    run.cells.length > 0 && run.cells.every(cell => matrix.has(cell)) &&
    run.latencies.every(value => Number.isFinite(value) && value >= 0);
}

function summarizeTime(base, candidate, fraction) {
  const baselineMs = percentile(base, fraction);
  const explorationMs = percentile(candidate, fraction);
  const changePercent = baselineMs > 0 && explorationMs !== null ? 100 * (explorationMs - baselineMs) / baselineMs : null;
  return { baselineMs, explorationMs, changePercent };
}

export function compareRounds(rounds, calibrated) {
  if (!calibrated || !rounds.length || !rounds.every(r => valid(r.baseline) && valid(r.exploration))) {
    return { status: 'incomplete' };
  }
  const baseline = new Set(rounds.flatMap(r => r.baseline.cells));
  const exploration = new Set(rounds.flatMap(r => r.exploration.cells));
  const additionalCells = [...exploration].filter(cell => !baseline.has(cell)).sort();
  const latency = name => rounds.flatMap(r => r[name].latencies);
  const baseTimes = latency('baseline');
  const exploreTimes = latency('exploration');
  return { status: 'complete', totalCells: matrix.size, baselineCells: [...baseline].sort(),
    explorationCells: [...exploration].sort(), additionalCells,
    gainPercentagePoints: 100 * additionalCells.length / matrix.size,
    wallTimeMedian: summarizeTime(rounds.map(r => r.baseline.elapsedMs), rounds.map(r => r.exploration.elapsedMs), 0.5),
    renderLatencyMs: { baselineSamples: baseTimes.length, explorationSamples: exploreTimes.length,
      p50: summarizeTime(baseTimes, exploreTimes, 0.5), p95: summarizeTime(baseTimes, exploreTimes, 0.95) }
  };
}
