#!/usr/bin/env node
/**
 * 真实 Chrome 冒烟：通过 PageLens bridge（~/.pagelens/plcall.py）驱动已运行的 Agent Home 控制台，
 * 逐项打印 PASS / FAIL / SKIP。只读：切换视图、展开/收起面板、在筛选框输入后清空；
 * 不发消息、不新建/删除、不批准/拒绝、不改设置（语言/主题只核对，不点击）。
 *
 * 用法：node scripts/pagelens-smoke.mjs [--base http://127.0.0.1:23000] [--tab <tabId>]
 *        [--only nav,routes,...] [--expect-bots DeskBot,小八] [--json] [--list]
 * 前置：控制台已启动（npm run dev），Chrome 里 PageLens 扩展可用且放行该 origin。
 * 结束时标签页回到 #/chat（对话模式、筛选已清空）。存在 FAIL 时退出码为 1。
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const BASE = opt('base', process.env.AGENT_HOME_URL ?? 'http://127.0.0.1:23000').replace(/\/$/, '');
const EXPECT_BOTS = opt('expect-bots', 'DeskBot,小八').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = opt('only', '')?.split(',').filter(Boolean) ?? [];
const PLCALL = process.env.PLCALL ?? join(homedir(), '.pagelens', 'plcall.py');

function bridge(tool, args) {
  const out = execFileSync('python3', ['-W', 'ignore', PLCALL, tool, JSON.stringify(args)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  const res = JSON.parse(out.slice(out.indexOf('{')));
  if (!res.ok) throw new Error(`${tool}: ${res.error?.message ?? res.error ?? 'bridge failed'}`);
  return res.result;
}

/** run_js 包了一层 {ok,result}；页面内抛错时 ok=false。 */
function runJs(tabId, code) {
  const res = bridge('run_js', { tabId, code });
  if (res && typeof res === 'object' && 'ok' in res) {
    if (!res.ok) throw new Error(res.error?.message ?? res.error ?? 'run_js failed');
    return res.result;
  }
  return res;
}

function probe(tabId) {
  try {
    return runJs(tabId, 'return location.href');
  } catch {
    return null;
  }
}

function acquireTab() {
  const forced = opt('tab');
  if (forced) return Number(forced);
  const origin = new URL(BASE).host;
  const tabs = bridge('list_tabs', { query: origin }).filter((t) => t.url.startsWith(BASE));
  for (const t of tabs) if (probe(t.id)) return t.id;
  const opened = bridge('open_tab', { url: `${BASE}/#/chat`, active: false });
  bridge('wait_for', { tabId: opened.tabId, selector: '#nav-chat', timeoutMs: 20000 });
  return opened.tabId;
}

/** 页面侧公共工具；每个检查都是这段前言 + 一个函数体，返回 { pass, detail } 或 { skip, detail }。 */
const PRELUDE = `
const w = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (el) => !!el && el.getClientRects().length > 0;
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await w(100);
  }
};
const q = (s, root = document) => root.querySelector(s);
const qa = (s, root = document) => [...root.querySelectorAll(s)];
const go = async (hash, sel) => {
  if (location.hash !== hash) location.hash = hash;
  return until(() => { const e = q(sel); return vis(e) && e; }, 10000);
};
const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return r.json();
};
const setVal = (el, v) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const badge = (el) => { const m = (el?.innerText || '').trim().match(/(\\d+)\\s*$/); return m ? Number(m[1]) : 0; };
const surface = async (which) => {
  await go('#/chat', '#panel-play');
  const btn = q(which === 'bot' ? '#playSurfaceBot' : '#playSurfaceChat');
  if (btn.getAttribute('aria-selected') !== 'true') btn.click();
  await until(() => btn.getAttribute('aria-selected') === 'true', 3000);
  await w(400);
};
const railTitles = () => qa('#sessionListMini .list-item').map((e) => (q('.session-item__title', e) || e).innerText.trim());
const ok = (detail) => ({ pass: true, detail });
const bad = (detail) => ({ pass: false, detail });
`;

const SELF_HEAL_TONE = `
const healTone = (s) => ({ completed: 'done', failed: 'bad', blocked: 'bad', stopped: 'idle' })[s] ?? 'running';
const taskFor = (s) => ({ completed: 'completed', failed: 'failed', blocked: 'failed', stopped: 'cancelled' })[s] ?? 'in_progress';
`;

const CHECKS = [
  {
    id: 'nav',
    title: '主导航：六项、默认「对话」高亮',
    code: `
await go('#/chat', '#panel-play');
const links = qa('nav a');
const ids = links.map((a) => a.id).join(',');
const want = 'nav-chat,nav-agents,nav-tasks,nav-knowledge,nav-ops,nav-settings';
const hrefs = links.map((a) => a.getAttribute('href')).join(',');
const cur = links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.id);
if (ids !== want) return bad('nav ids=' + ids);
if (hrefs !== '#/chat,#/agents,#/tasks,#/knowledge,#/ops,#/settings') return bad('hrefs=' + hrefs);
if (cur.join() !== 'nav-chat') return bad('aria-current=' + cur.join());
return ok('6 links, current=nav-chat');`
  },
  {
    id: 'routes',
    title: '哈希路由：8 个页面各落到对应区块并高亮导航',
    code: `
const routes = [
  ['#/chat', 'nav-chat', '#panel-play'], ['#/agents', 'nav-agents', '#section-agents'],
  ['#/tasks', 'nav-tasks', '#section-tasks-queue'], ['#/tasks/inbox', 'nav-tasks', '#section-tasks-inbox'],
  ['#/knowledge', 'nav-knowledge', '#section-knowledge'], ['#/ops', 'nav-ops', '#section-ops-trajectory'],
  ['#/ops/health', 'nav-ops', '#section-ops-health'], ['#/settings', 'nav-settings', '#section-settings']
];
const fails = [];
for (const [hash, nav, sel] of routes) {
  const el = await go(hash, sel);
  const cur = qa('nav a[aria-current="page"]').map((a) => a.id).join();
  if (!el) fails.push(hash + ' section ' + sel + ' not visible');
  else if (cur !== nav) fails.push(hash + ' current=' + cur);
}
await go('#/chat', '#panel-play');
return fails.length ? bad(fails.join('; ')) : ok(routes.length + ' routes ok');`
  },
  {
    id: 'bot-mode',
    title: '对话 / Bot 模式切换与 Bots 名册',
    code: `
const expected = ${JSON.stringify(EXPECT_BOTS)};
const bots = (await api('/api/bots')).bots.filter((b) => !b.hidden);
const sessions = (await api('/api/sessions')).sessions;
const botTitles = sessions.filter((s) => s.metadata && s.metadata.botId).map((s) => s.title);
try {
  await surface('chat');
  const leaked = railTitles().filter((t) => botTitles.includes(t));
  if (leaked.length) return bad('chat mode lists bot chats: ' + leaked.join(','));
  await surface('bot');
  if (!q('#botSelect')) return bad('#botSelect missing in Bot mode');
  const opts = qa('#botSelect option').filter((o) => o.value).map((o) => o.textContent.trim());
  const names = bots.map((b) => b.name);
  if ([...opts].sort().join() !== [...names].sort().join()) return bad('botSelect=' + opts + ' api=' + names);
  const missing = expected.filter((n) => !opts.includes(n));
  if (missing.length) return bad('expected bots missing: ' + missing.join(','));
  const rail = railTitles();
  if (rail.length !== bots.length) return bad('roster rail has ' + rail.length + ' entries, api ' + bots.length);
  await surface('chat');
  if (q('#botSelect')) return bad('#botSelect still present after switching back');
  return ok('bots=' + opts.join('/') + ', rail=' + rail.length);
} finally {
  await surface('chat');
}`
  },
  {
    id: 'session-filter',
    title: '会话筛选：输入收窄、乱码为空、清空恢复',
    code: `
await surface('chat');
const input = q('#panel-play input[type=search]');
if (!input) return bad('session filter input missing');
const before = railTitles();
if (before.length === 0) return { skip: true, detail: 'no chat sessions' };
const kw = before[0].slice(0, 3).toLowerCase();
try {
  setVal(input, kw); await w(500);
  const hit = railTitles();
  if (hit.length < 1 || hit.length > before.length) return bad('keyword "' + kw + '" -> ' + hit.length + '/' + before.length);
  setVal(input, 'zzzz-no-such-session-' + Date.now()); await w(500);
  const none = railTitles();
  if (none.length !== 0) return bad('nonsense keyword still lists ' + none.length);
  setVal(input, ''); await w(500);
  const after = railTitles();
  if (after.join('|') !== before.join('|')) return bad('clear did not restore list');
  return ok('kw="' + kw + '" hit=' + hit.length + ', restored=' + after.length);
} finally {
  setVal(input, '');
}`
  },
  {
    id: 'approvals',
    title: '审批收件箱：无已处理的陈旧审批，徽标与列表一致',
    code: `
const all = (await api('/api/approvals')).approvals;
const pending = all.filter((a) => !a.status || a.status === 'pending').length;
const section = await go('#/tasks/inbox', '#section-tasks-inbox');
if (!section) return bad('inbox not visible');
await w(1200);
const listed = qa('#listApprovals .list-item').length;
const tabBadge = badge(q('#section-tasks-tab-inbox'));
const navBadge = badge(q('#nav-tasks'));
const detail = 'api pending=' + pending + '/' + all.length + ', list=' + listed + ', tab badge=' + tabBadge + ', nav badge=' + navBadge;
await go('#/chat', '#panel-play');
if (listed !== pending || tabBadge !== pending || navBadge !== pending) return bad(detail);
return ok(detail);`
  },
  {
    id: 'selfheal',
    title: '自愈：任务状态、运维›系统健康卡片与 API 一致',
    code: `${SELF_HEAL_TONE}
const runs = (await api('/api/self-heal/runs?limit=200')).runs;
const tasks = (await api('/api/tasks')).tasks;
const byId = new Map(tasks.map((t) => [t.id, t]));
const mismatched = runs
  .filter((r) => r.taskId && byId.has(r.taskId) && byId.get(r.taskId).status !== taskFor(r.status))
  .map((r) => r.id.slice(0, 14) + ':' + r.status + '->' + byId.get(r.taskId).status);
if (mismatched.length) return bad('task status != run status: ' + mismatched.join(', '));

const active = (await api('/api/self-heal/status')).active;
const recent = (await api('/api/self-heal/runs?limit=5')).runs;
if (!(await go('#/ops/health', '[data-testid=ops-card-selfheal]'))) return bad('health card missing');
await until(() => qa('[data-testid=ops-card-selfheal] .ops-run').length === recent.length, 8000);
const card = q('[data-testid=ops-card-selfheal]');
const tones = qa('.ops-run', card).map((e) => (e.className.match(/ops-run--(\\w+)/) || [])[1]);
const wantTones = recent.map((r) => healTone(r.status));
const wantCard = active.length > 0 ? 'run' : wantTones.includes('bad') ? 'warn' : 'idle';
const cardTone = (card.className.match(/ops-card--(\\w+)/) || [])[1];
const headlineN = (q('.ops-card__headline', card).innerText.match(/\\d+/) || [0])[0] | 0;
const detail = 'runs=' + runs.length + ', recent tones=' + tones.join('/') + ', card=' + cardTone + ', active=' + active.length;
if (tones.join() !== wantTones.join()) return bad(detail + ' want ' + wantTones.join('/'));
if (cardTone !== wantCard) return bad(detail + ' want card ' + wantCard);
if (headlineN !== active.length) return bad(detail + ' headline n=' + headlineN);

const det = q('details', card);
if (det) { det.open = true; await w(200); det.open = false; }

await go('#/tasks/queue', '#taskStatusFilter');
await w(800);
const chip = (id) => badge(q('#taskStatusFilter [data-testid=status-filter-' + id + ']'));
const count = (s) => tasks.filter((t) => t.status === s).length;
for (const s of ['failed', 'in_progress', 'completed', 'pending', 'cancelled']) {
  if (chip(s) !== count(s)) { await go('#/chat', '#panel-play'); return bad('queue chip ' + s + '=' + chip(s) + ' api=' + count(s)); }
}
await go('#/chat', '#panel-play');
return ok(detail);`
  },
  {
    id: 'ops-health',
    title: '运维›系统健康：总体结论、服务卡片、无 Evolution 入口',
    code: `
const ready = await api('/api/readiness');
if (!(await go('#/ops/health', '[data-testid=ops-overall]'))) return bad('overall banner missing');
await until(() => ['ok', 'warn', 'fail'].includes(q('[data-testid=ops-overall]').dataset.level), 8000);
const level = q('[data-testid=ops-overall]').dataset.level;
const service = q('[data-testid=ops-card-service]');
const svcTone = (service.className.match(/ops-card--(\\w+)/) || [])[1];
const evo = q('[data-testid=ops-card-evolution]') || q('a[href="/evolution"]');
let detail = 'overall=' + level + ', service=' + svcTone + ', ready=' + ready.ready;
if (!['ok', 'warn', 'fail'].includes(level)) return bad(detail);
if (ready.ready === true && (svcTone !== 'ok' || level === 'fail')) return bad(detail);
if (evo) return bad(detail + ', Evolution entry present');
const toggle = qa('#card-effective-config button').find((b) => /显示全部|Show all/i.test(b.textContent));
if (toggle) {
  const rows = () => qa('#card-effective-config li').length;
  const n0 = rows(); toggle.click(); await w(400);
  const n1 = rows();
  const hide = qa('#card-effective-config button').find((b) => b !== toggle && /收起|Collapse|Hide/i.test(b.textContent)) || toggle;
  hide.click(); await w(300);
  detail += ', config rows ' + n0 + '->' + n1;
  if (n1 <= n0) { await go('#/chat', '#panel-play'); return bad(detail); }
}
await go('#/chat', '#panel-play');
return ok(detail);`
  },
  {
    id: 'ops-banner-consistency',
    title: '运维›系统健康：总体结论不与自愈卡片矛盾',
    code: `
if (!(await go('#/ops/health', '[data-testid=ops-overall]'))) return bad('overall banner missing');
await until(() => ['ok', 'warn', 'fail'].includes(q('[data-testid=ops-overall]').dataset.level), 8000);
await w(800);
const level = q('[data-testid=ops-overall]').dataset.level;
const tones = qa('.ops-card').map((c) => (c.className.match(/ops-card--(\\w+)/) || [])[1]);
const rank = { ok: 0, idle: 0, run: 0, warn: 1, fail: 2 };
const worst = Math.max(...tones.map((t) => rank[t] ?? 0));
const detail = 'overall=' + level + ', cards=' + tones.join('/');
await go('#/chat', '#panel-play');
if (level === 'ok' && worst > 0) return bad(detail + ' (banner says all good while a card is flagged)');
return ok(detail);`
  },
  {
    id: 'agents',
    title: 'Agents 页：卡片数与 API 一致，搜索过滤后可恢复',
    code: `
const agents = (await api('/api/agents')).agents;
if (!(await go('#/agents', '#agentsView'))) return bad('agents view missing');
await until(() => qa('[data-testid^=agent-card-]').length === agents.length, 6000);
const n = () => qa('[data-testid^=agent-card-]').length;
const input = q('#agentsView input[type=search]');
let detail = 'cards=' + n() + ' api=' + agents.length;
if (n() !== agents.length) return bad(detail);
try {
  setVal(input, 'zzzz-no-such-agent'); await w(400);
  if (n() !== 0) return bad(detail + ', nonsense filter -> ' + n());
} finally { setVal(input, ''); await w(300); }
if (n() !== agents.length) return bad(detail + ', clear did not restore');
await go('#/chat', '#panel-play');
return ok(detail);`
  },
  {
    id: 'bots-roster',
    title: 'Bots 页：名册与 API 一致（含期望的 Bot）',
    code: `
const expected = ${JSON.stringify(EXPECT_BOTS)};
const bots = (await api('/api/bots')).bots.filter((b) => !b.hidden);
if (!(await go('#/agents/bots', '#botsView'))) return bad('bots view missing');
await until(() => qa('[data-testid^=bot-card-]').length === bots.length, 6000);
const names = qa('[data-testid^=bot-card-] .ag-card__title').map((e) => e.textContent.trim());
await go('#/chat', '#panel-play');
if (names.length !== bots.length) return bad('cards=' + names + ' api=' + bots.map((b) => b.name));
const missing = expected.filter((n) => !names.includes(n));
return missing.length ? bad('missing ' + missing.join(',')) : ok('bots=' + names.join('/'));`
  },
  {
    id: 'tasks-queue',
    title: '任务队列：筛选条数量与列表条数与 API 一致',
    code: `
const tasks = (await api('/api/tasks')).tasks;
if (!(await go('#/tasks/queue', '#taskStatusFilter'))) return bad('queue missing');
await w(1000);
const all = badge(q('#taskStatusFilter [data-testid=status-filter-all]'));
const items = () => qa('#listTasks .list-item').length;
const detail = 'chip all=' + all + ', list=' + items() + ', api=' + tasks.length;
let failedBtn = q('#taskStatusFilter [data-testid=status-filter-failed]');
const failedN = tasks.filter((t) => t.status === 'failed').length;
let filtered = -1;
if (failedN > 0) { failedBtn.click(); await w(400); filtered = items(); q('#taskStatusFilter [data-testid=status-filter-all]').click(); await w(400); }
const restored = items();
await go('#/chat', '#panel-play');
if (all !== tasks.length || restored !== tasks.length) return bad(detail + ', restored=' + restored);
if (failedN > 0 && filtered !== failedN) return bad(detail + ', failed filter=' + filtered + ' api=' + failedN);
return ok(detail);`
  },
  {
    id: 'knowledge',
    title: '知识与记忆：五个记忆范围',
    code: `
if (!(await go('#/knowledge', '#section-knowledge-memory'))) return bad('memory tab missing');
await until(() => qa('[data-testid^=memory-scope-]').length >= 5, 6000);
const scopes = qa('[data-testid^=memory-scope-]').map((e) => e.dataset.testid.replace('memory-scope-', ''));
await go('#/chat', '#panel-play');
const want = ['session.scratch', 'session.long', 'user.memory', 'team.memory', 'project.memory'];
return want.every((s) => scopes.includes(s)) && scopes.length === 5 ? ok(scopes.join(',')) : bad('scopes=' + scopes);`
  },
  {
    id: 'settings',
    title: '设置：语言/主题控件反映当前状态，搜索可过滤并清空',
    code: `
if (!(await go('#/settings', '#section-settings'))) return bad('settings missing');
await w(500);
const pressed = qa('[data-testid=language-toggle] button[aria-pressed=true]').map((b) => b.textContent.trim());
const lang = document.documentElement.lang;
const wantLabel = lang.startsWith('zh') ? '中文' : 'English';
if (pressed[0] !== wantLabel) return bad('language pressed=' + pressed + ' html lang=' + lang);
const checked = qa('#card-theme input[type=radio]').find((r) => r.checked);
const dt = document.documentElement.getAttribute('data-theme');
if (!checked) return bad('no theme radio checked');
if (checked.value !== 'system' && checked.value !== dt) return bad('theme radio=' + checked.value + ' data-theme=' + dt);
if (!['light', 'dark'].includes(dt)) return bad('data-theme=' + dt);
const search = q('#settingsSearch');
try {
  setVal(search, 'zzzz-no-such-setting'); await w(500);
  if (q('#setting-language')) return bad('nonsense search still shows language card');
  setVal(search, ''); await w(500);
  if (!q('#setting-language')) return bad('clearing search did not restore cards');
} finally { setVal(search, ''); }
await go('#/chat', '#panel-play');
return ok('lang=' + lang + ', theme=' + checked.value + '/' + dt);`
  }
];

function main() {
  if (flag('list')) {
    for (const c of CHECKS) console.log(`${c.id}\t${c.title}`);
    return 0;
  }
  const selected = ONLY.length ? CHECKS.filter((c) => ONLY.includes(c.id)) : CHECKS;
  let tabId;
  try {
    tabId = acquireTab();
  } catch (e) {
    console.error(`FAIL  (setup) cannot reach ${BASE} through PageLens: ${e.message}`);
    return 2;
  }
  console.log(`# PageLens smoke  base=${BASE}  tab=${tabId}`);
  const results = [];
  for (const c of selected) {
    let r;
    try {
      r = runJs(tabId, `${PRELUDE}\n${c.code}`);
    } catch (e) {
      r = { pass: false, detail: `error: ${e.message}` };
    }
    const status = r?.skip ? 'SKIP' : r?.pass ? 'PASS' : 'FAIL';
    results.push({ id: c.id, title: c.title, status, detail: r?.detail ?? '' });
    if (!flag('json')) console.log(`${status}  ${c.id.padEnd(22)} ${c.title}\n      ${r?.detail ?? ''}`);
  }
  try {
    const end = runJs(
      tabId,
      `${PRELUDE}
await surface('chat');
const f = q('#panel-play input[type=search]'); if (f && f.value) setVal(f, '');
return location.hash;`
    );
    if (!flag('json')) console.log(`RESTORE  tab ${tabId} -> ${end}`);
  } catch (e) {
    console.error(`WARN  could not restore tab to #/chat: ${e.message}`);
  }
  const fail = results.filter((r) => r.status === 'FAIL').length;
  if (flag('json')) console.log(JSON.stringify({ base: BASE, tabId, results }, null, 2));
  else console.log(`# ${results.filter((r) => r.status === 'PASS').length} pass, ${fail} fail, ${results.filter((r) => r.status === 'SKIP').length} skip`);
  return fail ? 1 : 0;
}

process.exitCode = main();
