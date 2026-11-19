const DROP = 0.10;
const RECOVERY = 0.05;
const MAX_OBSERVATION_SPAN = 24 * 60 * 60 * 1000;
const EPSILON = 1e-12;

const modelKey = row => JSON.stringify([row.provider, row.model]);
const enoughReference = row => row && row.requests >= 5 && row.input >= 20000;
const enoughWindow = row => row.requests >= 3 && row.input >= 10000;

function interval(from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new Error('Expected an increasing interval in epoch milliseconds');
}

function sampleWindow(from, to) {
  return { from, to, requests: 0, input: 0, cached: 0, hitRequests: 0, ratio: null, requestHitRatio: null, lastSampleAt: null };
}

function addCounts(target, requests, input, cached, hitRequests, lastSampleAt) {
  target.requests += requests;
  target.input += input;
  target.cached += cached;
  target.hitRequests += hitRequests;
  target.ratio = target.cached / target.input;
  target.requestHitRatio = target.hitRequests / target.requests;
  target.lastSampleAt = target.lastSampleAt === null ? lastSampleAt : Math.max(target.lastSampleAt, lastSampleAt);
}

function addSample(target, sample) {
  if (!sample.provider || !sample.model || !Number.isSafeInteger(sample.time) || !Number.isSafeInteger(sample.input) || sample.input <= 0
      || !Number.isSafeInteger(sample.cached) || sample.cached < 0 || sample.cached > sample.input) {
    throw new Error('Expected an attributed sample with complete positive input and valid cached tokens');
  }
  addCounts(target, 1, sample.input, sample.cached, Number(sample.cached > 0), sample.time);
}

function combine(windows) {
  const summary = sampleWindow(windows[0].from, windows.at(-1).to);
  for (const row of windows) addCounts(summary, row.requests, row.input, row.cached, row.hitRequests, row.lastSampleAt);
  return summary;
}

const overlapsGap = (from, to, gaps) => gaps.some(gap => gap.from < to && gap.to > from);

/** Sealed post-change reference. All intervals are [from, to), all rates are fractions. */
export function createCacheBaseline(records, { from, to, coverageGaps = [] }) {
  interval(from, to);
  const models = new Map();
  if (!overlapsGap(from, to, coverageGaps)) {
    for (const row of records) {
      if (row.time < from || row.time >= to) continue;
      const key = modelKey(row);
      if (!models.has(key)) models.set(key, { provider: row.provider, model: row.model, ...sampleWindow(from, to) });
      addSample(models.get(key), row);
    }
  }
  return { from, to, models: [...models.values()] };
}

function initialModel(provider, model, seed) {
  const reference = enoughReference(seed) ? seed : null;
  return {
    provider, model, reference, training: reference ? null : seed ?? null, healthyWindows: [],
    incidentOpen: false, previousWindow: null, window: null, status: 'insufficient', lastValidAt: reference?.lastSampleAt ?? null,
  };
}

function expireEvidence(model, at) {
  const cutoff = at - MAX_OBSERVATION_SPAN;
  if (model.previousWindow?.to < cutoff) model.previousWindow = null;
  if (model.training?.to < cutoff) model.training = null;
  model.healthyWindows = model.healthyWindows.filter(w => w.to >= cutoff);
}

function discardEvidence(model) {
  model.previousWindow = null;
  model.healthyWindows = [];
  model.training = null;
}

function insufficient(model, window) {
  if (window.coverageComplete === false) discardEvidence(model);
  model.status = 'insufficient';
  model.window = window;
}

function trainReference(model, window) {
  model.training = model.training ? combine([model.training, window]) : window;
  model.status = 'insufficient';
  if (enoughReference(model.training)) {
    model.reference = model.training;
    model.training = null;
    model.lastValidAt = window.lastSampleAt;
  }
}

function rememberHealthy(model, window) {
  model.healthyWindows = [...model.healthyWindows.slice(-2), window];
  if (model.healthyWindows.length < 3) return;
  const rates = model.healthyWindows.map(w => w.ratio);
  if (Math.max(...rates) - Math.min(...rates) > RECOVERY + EPSILON) return;
  // Three qualified healthy observations within 24 hours can raise the reference for subsequent windows.
  const stable = combine(model.healthyWindows);
  if (stable.ratio > model.reference.ratio) model.reference = stable;
}

function recordTransition(model, kind, window, events) {
  events.push({
    id: JSON.stringify([model.provider, model.model, kind, window.to]), kind,
    provider: model.provider, model: model.model, reference: model.reference,
    previousWindow: model.previousWindow, window,
  });
  model.incidentOpen = kind === 'degraded';
  model.previousWindow = null;
}

function observeWindow(model, window, events) {
  expireEvidence(model, window.to);
  model.window = window;
  if (!window.requests || window.coverageComplete === false) return insufficient(model, window);
  if (!model.reference) return trainReference(model, window);
  if (!enoughWindow(window)) return insufficient(model, window);

  model.lastValidAt = window.lastSampleAt;
  const loss = model.reference.ratio - window.ratio;
  const qualifies = model.incidentOpen ? loss <= RECOVERY + EPSILON : loss >= DROP - EPSILON;
  if (qualifies) {
    model.healthyWindows = [];
    if (model.previousWindow) recordTransition(model, model.incidentOpen ? 'recovered' : 'degraded', window, events);
    else model.previousWindow = window;
  } else {
    model.previousWindow = null;
    if (!model.incidentOpen) rememberHealthy(model, window);
  }
  model.status = model.incidentOpen ? 'degraded' : model.previousWindow ? 'watching' : 'healthy';
}

function bucketSamples(records, models, cursor, through, anchor, size) {
  const grouped = new Map();
  for (const row of records) {
    if (row.time < cursor || row.time >= through) continue;
    const key = modelKey(row);
    if (!models.has(key)) models.set(key, initialModel(row.provider, row.model));
    if (!grouped.has(key)) grouped.set(key, new Map());
    const buckets = grouped.get(key);
    const from = anchor + Math.floor((row.time - anchor) / size) * size;
    if (!buckets.has(from)) buckets.set(from, sampleWindow(from, from + size));
    addSample(buckets.get(from), row);
  }
  return grouped;
}

function observeBuckets(model, buckets, cursor, through, size, gaps, events) {
  let next = cursor;
  function idleUntil(to) {
    if (to <= next) return;
    const lastEmpty = sampleWindow(to - size, to);
    if (overlapsGap(next, to, gaps)) discardEvidence(model);
    if (overlapsGap(lastEmpty.from, to, gaps)) lastEmpty.coverageComplete = false;
    observeWindow(model, lastEmpty, events);
  }
  for (const window of [...buckets.values()].sort((a, b) => a.from - b.from)) {
    idleUntil(window.from);
    if (overlapsGap(window.from, window.to, gaps)) window.coverageComplete = false;
    observeWindow(model, window, events);
    next = window.to;
  }
  // Missing days have the same effect as one empty window. Avoid walking an idle model's entire history.
  idleUntil(through);
}

function mergeGaps(gaps, cursor) {
  const merged = [];
  for (const gap of gaps.filter(g => g.to > cursor).sort((a, b) => a.from - b.from)) {
    interval(gap.from, gap.to);
    const previous = merged.at(-1);
    if (previous && previous.to >= gap.from) previous.to = Math.max(previous.to, gap.to);
    else merged.push({ from: Math.max(cursor, gap.from), to: gap.to });
  }
  return merged;
}

/**
 * Evaluate only newly closed windows. Persist state verbatim and retain samples from state.cursor onwards.
 * A gap marks a range where a source is known incomplete even if some valid samples were observed.
 */
export function evaluateCacheWindows(records, { baseline, windowMs, now, state, coverageGaps = [] }) {
  interval(baseline.from, baseline.to);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error('Invalid measurement time or window size');
  if (state && (state.baselineFrom !== baseline.from || state.baselineTo !== baseline.to || state.windowMs !== windowMs)) {
    throw new Error('The stored monitor state belongs to a different reference interval or window size');
  }
  const cursor = state?.cursor ?? baseline.to;
  const gaps = mergeGaps([...(state?.coverageGaps ?? []), ...coverageGaps], cursor);
  const through = Math.max(cursor, baseline.to + Math.floor((now - baseline.to) / windowMs) * windowMs);
  const rows = state ? structuredClone(state.models) : baseline.models.map(row => initialModel(row.provider, row.model, row));
  const modelsByKey = new Map(rows.map(row => [modelKey(row), row]));
  const grouped = bucketSamples(records, modelsByKey, cursor, through, baseline.to, windowMs);
  const events = [];
  for (const [key, model] of modelsByKey) {
    observeBuckets(model, grouped.get(key) ?? new Map(), cursor, through, windowMs, gaps, events);
  }
  const models = [...modelsByKey.values()];
  events.sort((a, b) => a.window.to - b.window.to || a.id.localeCompare(b.id));
  const next = { baselineFrom: baseline.from, baselineTo: baseline.to, windowMs, cursor: through, coverageGaps: mergeGaps(gaps, through), models };
  return { state: next, models, events };
}
