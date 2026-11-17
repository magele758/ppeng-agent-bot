// Passed to Playwright as an init script and called by a Bombadil browser action.
// Keep it self-contained: Playwright serializes the function without its module.
export function installFontMeter() {
  if (window.__fontComparison) return;
  const key = 'ppeng.benchmark.font.v1';
  const meter = JSON.parse(sessionStorage.getItem(key) || 'null') ||
    { cells: [], latencies: [], violation: null };
  window.__fontComparison = meter;
  let pending;
  let lastMismatch;
  function save() {
    try { sessionStorage.setItem(key, JSON.stringify(meter)); }
    catch { /* The storage-failure regression still measures in memory. */ }
  }
  document.addEventListener('change', event => {
    if (event.target.id === 'font-size-choice') pending = { size: event.target.value, at: performance.now() };
  }, true);
  function sample() {
    requestAnimationFrame(sample);
    const select = document.querySelector('#font-size-choice');
    const preview = document.querySelector('.font-size-preview');
    if (!select || !preview || !preview.getClientRects().length) {
      pending = undefined;
      lastMismatch = undefined;
      return;
    }
    const size = select.value;
    const actual = getComputedStyle(preview).fontSize;
    const applied = document.documentElement.dataset.fontSize;
    // React can commit the control and the root attribute in separate frames.
    const mismatch = actual === size + 'px' && applied === size ? null : [size, applied, actual].join('/');
    if (mismatch && mismatch === lastMismatch && !meter.violation) {
      meter.violation = mismatch;
      save();
    }
    lastMismatch = mismatch;
    if (mismatch) return;
    const lang = document.documentElement.lang.split('-')[0];
    const cell = [size, lang, innerWidth].join('/');
    let changed = false;
    if ([640, 1280].includes(innerWidth) && ['en', 'zh'].includes(lang) && !meter.cells.includes(cell)) {
      meter.cells.push(cell);
      changed = true;
    }
    if (pending?.size === size) {
      meter.latencies.push(performance.now() - pending.at);
      pending = undefined;
      changed = true;
    }
    if (changed) save();
  }
  requestAnimationFrame(sample);
}
