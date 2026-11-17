import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRounds } from './comparison.mjs';

const run = (cells, elapsedMs = 300, latencies = [15, 18]) => ({ status: 'passed', cells, elapsedMs, latencies });
test('按同一行为分母去重，联合覆盖只计新增 [AC:bombadil-comparison#AC-1]', () => {
  const compare = compareRounds([{ baseline: run(['14/zh/640','14/zh/640']), exploration: run(['14/zh/640','18/en/1280'], 450) }], true);
  assert.equal(compare.status, 'complete');
  assert.equal(compare.totalCells, 20);
  assert.deepEqual(compare.additionalCells, ['18/en/1280']);
  assert.equal(compare.gainPercentagePoints, 5);
  assert.equal(compare.wallTimeMedian.explorationMs, 450);
  assert.equal(compare.wallTimeMedian.changePercent, 50);
});
test('两组和校准必须成功，无渲染耗时不算零 [AC:bombadil-comparison#AC-2]', () => {
  const done = run(['14/zh/640'], 200, []);
  assert.equal(compareRounds([], true).status, 'incomplete');
  assert.equal(compareRounds([{baseline: done}], true).status, 'incomplete');
  assert.equal(compareRounds([{baseline: done, exploration: done}], false).status, 'incomplete');
  assert.equal(compareRounds([{baseline: done, exploration: run([])}], true).status, 'incomplete');
  assert.equal(compareRounds([{baseline: done, exploration: done}], true).renderLatencyMs.p50.changePercent, null);
});

test('同一页面探针只记录可见组合和已完成的交互，连续两帧异常被保留 [AC:bombadil-comparison#AC-1]', async () => {
  const { runInNewContext } = await import('node:vm');
  const { installFontMeter } = await import('./font-meter.mjs');
  const input = { id: 'font-size-choice', value: '14' };
  const preview = { getClientRects: () => [1] };
  const html = { lang: 'zh-CN', dataset: { fontSize: '14' } };
  let frame, change, time = 5, css = '14px';
  const window = {};
  const env = { window, innerWidth: 640, performance: { now: () => time },
    sessionStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: fn => { frame = fn; }, getComputedStyle: () => ({fontSize: css}),
    document: { documentElement: html, querySelector: key => key.startsWith('#') ? input : preview,
      addEventListener: (_type, fn) => { change = fn; } } };
  runInNewContext('(' + installFontMeter.toString() + ')()', env);
  frame();
  frame();
  input.value = '18';
  change({target: input});
  html.dataset.fontSize = '18';
  css = '18px';
  time = 21;
  frame();
  const meter = window.__fontComparison;
  assert.deepEqual([...meter.cells], ['14/zh/640', '18/zh/640']);
  assert.deepEqual([...meter.latencies], [16]);
  css = '1px';
  frame();
  assert.equal(meter.violation, null);
  frame();
  assert.equal(meter.violation, '18/18/1px');
});
