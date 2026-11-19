import { strict as assert } from 'node:assert';
import { PLAY_FEED_PAGE_SIZE, sessionFeedSearch } from '../../apps/web-console/lib/feed-window.ts';
import { runWithCleanup } from '../e2e-lifecycle.mjs';
import { runIsolatedLab } from '../e2e-run.mjs';
import { envForEphemeralDaemon } from '../spawn-utils.mjs';

const marker = 'Synthetic conversation history for the Lab performance check.';
const httpRounds = 10;
const browserRounds = 3;
const timeoutMs = 15_000;

function metric(name, values, count, percentile) {
  assert(values?.length === count && [...values].every(value => Number.isFinite(value) && value >= 0),
    name + ' requires ' + count + ' complete elapsed-time samples');
  const sorted = [...values].sort((a, b) => a - b);
  return { name, value: sorted[Math.ceil(count * percentile) - 1] };
}

export function summarizeHomepage(requests, pages) {
  const metrics = [
    metric('homepageDocumentP90Ms', requests.map(row => row.document), httpRounds, 0.90),
    metric('homepageAuthP90Ms', requests.map(row => row.auth), httpRounds, 0.90),
    metric('homepageReadinessP90Ms', requests.map(row => row.readiness), httpRounds, 0.90),
    metric('homepageHistoryP90Ms', requests.map(row => row.history), httpRounds, 0.90),
    metric('homepageWorstRequestMs', requests.flatMap(row => [row.document, row.auth, row.readiness, row.history]), httpRounds * 4, 1)
  ];
  if (pages) metrics.push(
    metric('homepageInteractiveMedianMs', pages.home, browserRounds, 0.5),
    metric('botTranscriptMedianMs', pages.bot, browserRounds, 0.5)
  );
  return metrics;
}

function serviceEnvironment() {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return envForEphemeralDaemon({ ...env, TZ: 'UTC', RAW_AGENT_MODEL_PROVIDER: 'heuristic', RAW_AGENT_AGENTS_SKILLS: '0' });
}

function seedConversation(store, { botIds, sessionIds }) {
  const [botId] = botIds;
  const [sessionId] = sessionIds;
  assert(botId && sessionId, 'The homepage fixture requires a Bot conversation');
  const append = (role, text) => store.appendMessage(sessionId, role, [{ type: 'text', text }]);
  store.transaction(() => {
    for (let i = 1; i <= Math.ceil(PLAY_FEED_PAGE_SIZE / 2); i++) {
      append('user', 'Inspect synthetic job ' + i);
      append('assistant', 'Checked the job history. **Job ' + i + '** finished successfully.');
    }
    append('user', 'Summarize the synthetic history.');
    append('assistant', 'Reviewed the previous jobs.');
    append('assistant', 'All jobs have a recorded outcome.');
    append('assistant', marker);
  });
  return { botId, sessionId };
}

async function request(base, path, method = 'GET') {
  const response = await fetch(new URL(path, base), { method, signal: AbortSignal.timeout(timeoutMs) });
  assert(response.ok, method + ' ' + path + ' returned ' + response.status);
  return response;
}

async function checkEntryAssets(base, html) {
  const paths = [...new Set(Array.from(html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+?\.(?:js|css)(?:\?[^"]*)?)"/g), match => match[1]))];
  assert(paths.length, 'The Lab document must reference static assets');
  await Promise.all(paths.map(async path => {
    const response = await request(base, path);
    assert.match(response.headers.get('content-type') ?? '', /javascript|text\/css/);
    assert((await response.arrayBuffer()).byteLength > 0, 'Empty Lab asset ' + path);
  }));
}

async function documentTime(base, verifyAssets) {
  const started = performance.now();
  const html = await (await request(base, '/')).text();
  assert(html.includes('data-boot-loading') && /<script[^>]+src="\/_next\/static\//.test(html),
    'The Lab document must contain its startup screen and production JavaScript');
  if (verifyAssets) await checkEntryAssets(base, html);
  return performance.now() - started;
}

async function jsonTime(base, path, check, method) {
  const started = performance.now();
  const body = await (await request(base, path, method)).json();
  assert(check(body), 'Unexpected response from ' + path);
  return performance.now() - started;
}

const schedulerTick = base => jsonTime(base, '/api/scheduler/run', body => body.ok === true, 'POST');

async function httpRound(base, sessionId, verifyAssets = false) {
  // One real scheduler tick per round also exercises the same daemon as the proxied reads.
  const [, document, auth, readiness, history] = await Promise.all([
    schedulerTick(base),
    documentTime(base, verifyAssets),
    jsonTime(base, '/api/auth/me', body => body.loginRequired === false && body.user === null),
    jsonTime(base, '/api/readiness', body => body.ready === true),
    jsonTime(base, '/api/sessions/' + encodeURIComponent(sessionId) + '?' + sessionFeedSearch(),
      body => body.session?.id === sessionId && body.hasMore === true && body.messages?.length === PLAY_FEED_PAGE_SIZE && body.messages.some(row =>
        row.role === 'assistant' && row.parts?.some(part => part.type === 'text' && part.text === marker)))
  ]);
  return { document, auth, readiness, history };
}

async function measurePage(page, base, botId) {
  const started = performance.now();
  const [login, navigation] = await Promise.all([
    page.waitForResponse(res => res.url() === base + '/api/auth/me'),
    page.goto(base + (botId ? '/#/bot' : '/'), { waitUntil: 'domcontentloaded' })
  ]);
  assert(navigation?.ok() && login.ok(), 'Navigation or login check failed');
  const composer = page.locator('.lab-shell [data-surface="bot"] #playInput');
  await composer.fill('benchmark draft');
  await page.locator('#playTitle').getByTestId('bot-detail-toggle').waitFor();
  const reply = page.locator('.chat-reply-run').filter({ has: page.getByText(marker, { exact: true }) });
  if (botId) await reply.getByText(marker, { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), 'benchmark draft', 'The conversation must retain input typed during startup');
  const elapsed = performance.now() - started;
  if (botId) {
    const gaps = await reply.locator('.chat-bubble__md').evaluateAll(blocks => blocks.slice(1).map((block, i) =>
      block.getBoundingClientRect().top - blocks[i].getBoundingClientRect().bottom));
    assert.equal(gaps.length, 2, 'Expected all three parts of the seeded reply');
    assert(gaps.every(gap => gap >= 6 && gap <= 10), 'Unexpected spacing between adjacent reply segments: ' + gaps);
  }
  return elapsed;
}

async function visit(browser, base, botId) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 865, height: 803 } });
  try {
    if (botId) await context.addInitScript(id => localStorage.setItem('lab.selectedBot', id), botId);
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const faults = [];
    const isAsset = req => ['script', 'stylesheet'].includes(req.resourceType());
    page.on('pageerror', error => faults.push(error.message));
    page.on('requestfailed', req => { if (isAsset(req)) faults.push(req.url()); });
    page.on('response', res => { if (isAsset(res.request()) && !res.ok() && res.status() !== 304) faults.push(res.url()); });
    // Queue the real tick after Chromium is ready to navigate. Only the work needed for interaction is timed.
    const [, elapsed] = await Promise.all([schedulerTick(base), measurePage(page, base, botId)]);
    assert.deepEqual(faults, []);
    return elapsed;
  } finally {
    await context.close();
  }
}

async function browserSamples(base, botId) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const samples = { home: [], bot: [] };
    for (let round = 0; round <= browserRounds; round++) {
      for (const surface of ['home', 'bot']) {
        const elapsed = await visit(browser, base, surface === 'bot' ? botId : undefined);
        if (round) samples[surface].push(elapsed);
      }
    }
    return samples;
  } finally {
    await browser.close();
  }
}

export async function runHomepage({ browser = false } = {}) {
  const env = serviceEnvironment();
  let metrics, fixture, failure;
  const code = await runWithCleanup(registry => runIsolatedLab(registry, async ({ PLAYWRIGHT_BASE_URL: base }) => {
    await httpRound(base, fixture.sessionId, true);
    const requests = [];
    for (let round = 0; round < httpRounds; round++) requests.push(await httpRound(base, fixture.sessionId));
    const pages = browser ? await browserSamples(base, fixture.botId) : undefined;
    metrics = summarizeHomepage(requests, pages);
    return 0;
  }, {
    serviceEnv: env,
    allowBuild: false,
    async prepareState(stateDir) {
      const { seedIdleDatabase } = await import('./idle-history.mjs');
      fixture = await seedIdleDatabase(stateDir, seedConversation);
    }
  }), { log(error) { if (error instanceof Error) failure = error; console.error(error); } });
  if (failure) throw failure;
  assert.equal(code, 0, 'The isolated Lab homepage benchmark did not finish');
  return metrics;
}
