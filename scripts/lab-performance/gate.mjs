export function checkScenario(name, budgets, samples) {
  const observed = new Map();
  const problems = [];
  if (budgets.length === 0) problems.push('No budgets defined');
  for (const sample of samples) {
    if (observed.has(sample.name)) problems.push(`Duplicate measurement ${sample.name}`);
    observed.set(sample.name, sample.value);
  }
  const metrics = budgets.map(({name, max, unit, reference}) => {
    const value = observed.get(name);
    observed.delete(name);
    const valid = Number.isFinite(value) && value >= 0;
    const validBudget = Number.isFinite(max) && max >= 0;
    if (!valid) problems.push(`Missing or invalid measurement ${name}`);
    if (!validBudget) problems.push(`Invalid budget for ${name}`);
    const metric = {name, value: valid ? value : null, max, unit, passed: valid && validBudget && value <= max};
    if (reference === undefined) return metric;
    if (unit !== 'ms' || !Number.isFinite(reference) || reference < 0 || reference > max) {
      problems.push(`Invalid timing reference for ${name}`);
      return metric;
    }
    const warningAt = Math.max(reference * 1.5, reference + 20);
    return {...metric, reference, warningAt, warning: metric.passed && value > warningAt};
  });
  for (const key of observed.keys()) problems.push(`Unexpected measurement ${key}`);
  const passed = problems.length === 0 && metrics.every(metric => metric.passed);
  return {name, passed, metrics, ...(problems.length ? {error: problems.join(', ')} : {})};
}

export async function runScenarios(revision, scenarios, save = () => {}) {
  const report = {
    revision,
    passed: false,
    scenarios: scenarios.map(({name}) => ({name, passed: false, metrics: [], error: 'Not measured'})),
  };
  save(report);
  for (const [index, scenario] of scenarios.entries()) {
    try {
      report.scenarios[index] = checkScenario(scenario.name, scenario.budgets, await scenario.measure());
    } catch (error) {
      report.scenarios[index].error = error?.message ?? String(error);
    }
    save(report);
  }
  report.passed = report.scenarios.length > 0 && report.scenarios.every(scenario => scenario.passed);
  save(report);
  return report;
}

export function metricValue(metric) {
  if (metric.value === null) return 'missing';
  return metric.unit === 'ms' ? metric.value.toFixed(2) : String(metric.value);
}

function metricResult(metric) {
  if (!metric.passed) return 'FAIL';
  return metric.warning ? 'WARN' : 'pass';
}

export function formatSummary(report) {
  const lines = [
    `### Lab performance · ${report.passed ? 'PASS' : 'FAIL'} · \`${report.revision.slice(0, 12)}\``,
    '', '| Scenario | Metric | Actual | Reference | Maximum | Unit | Result |', '|---|---|---:|---:|---:|---|---|',
  ];
  for (const scenario of report.scenarios) {
    for (const metric of scenario.metrics) {
      lines.push(`| ${scenario.name} | ${metric.name} | ${metricValue(metric)} | ${metric.reference ?? '—'} | ${metric.max} | ${metric.unit} | ${metricResult(metric)} |`);
    }
  }
  for (const scenario of report.scenarios.filter(item => item.error)) {
    lines.push('', `**${scenario.name}** — ${scenario.error}`);
  }
  return lines.join('\n') + '\n';
}
