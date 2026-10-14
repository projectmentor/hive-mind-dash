// Behaviour tests for the Overview refresh (hive-mind-dash#27). Cuts the real ovAgeDraw, ovSparks, ovFetch and ovTick out of
// dashboard/app.js and runs them in a node vm with a fake getJSON and document.
// Usage: node overview_refresh.js <path to app.js>.   Exit 0 and prints "ok" when every case holds.
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert(i > 0 && j > i, a + ' not found'); return src.slice(i, j); };
const code = cut('const OV_EVERY=', '\n') + '\n' + cut('let OVT=null', '\n') + '\n' + cut('const ovLive=', '\n') + '\n' + cut('const ovAgeDraw=', 'function ovHero(') +
  cut('const OV_ACT_DAYS', '\nconst ovDays') + '\n' + cut('const ovDays=', '\n') + '\n' + cut('function ovSparks(', '/* Corpus growth') + cut('function ovFetch(', "document.addEventListener('visibilitychange'");

function load(opts = {}) {
  const log = { calls: [], age: [], drawn: 0 };
  const els = { ovroot: {}, ovAge: {} };
  const ctx = {
    VIEWER: !!opts.viewer, state: { view: 'overview', node: null, detail: null }, META: {}, OVD: { meta: {} },
    document: { hidden: !!opts.hidden, getElementById: id => els[id] || null },
    html: (s, ...v) => s.reduce((a, x, i) => a + x + (i < v.length ? v[i] : ''), ''),
    put: (el, ...n) => { if (el === els.ovAge) log.age.push(n[0]); },
    $: () => null, encodeURIComponent, Date, Math, Object, Number, String, Array, Promise, clearInterval: () => {},
    empty: () => '', cmdBlock: () => '', failText: () => '',
    ovHero: () => { log.drawn++; }, ovMix: () => {}, ovFleet: () => {}, ovAudit: () => {}, ovGrowth: () => {}, ovSeats: () => {}, ovSpend: () => {},
    ovActivity: () => {}, ovModules: () => {}, ovApprovals: () => {},
    getJSON: url => { log.calls.push(url); return ctx.respond(url); },
    respond: () => Promise.reject(new Error('down')),
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const get = e => vm.runInContext(e, ctx), set = (n, v) => { ctx.tmp = v; vm.runInContext(n + '=tmp', ctx); };
  return { ctx, log, get, set, ovFetch: () => vm.runInContext('ovFetch()', ctx), ovTick: () => vm.runInContext('ovTick()', ctx), ovSparks: () => vm.runInContext('ovSparks()', ctx) };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const cases = [], t = (n, f) => cases.push([n, f]);

t('hidden tab: the timer starts no refresh and no read', async () => {
  const h = load({ hidden: true }); h.set('OVTRY', 1); h.set('OVAT', 1);
  h.ovTick(); await settle();
  assert.strictEqual(h.log.calls.length, 0);
  assert.strictEqual(h.log.drawn, 0, 'a hidden tab does not even redraw');
});
t('visible tab with the period up: the timer starts a refresh', async () => {
  const h = load(); h.set('OVTRY', 1);
  h.ovTick(); await settle();
  assert(h.log.calls.length > 0);
});
t('visible tab inside the period: no refresh, only the age redraws', async () => {
  const h = load(); h.set('OVTRY', Date.now());
  h.ovTick(); await settle();
  assert.strictEqual(h.log.calls.length, 0); assert.strictEqual(h.log.drawn, 1);
});
t('every read fails: OVAT does not move and the failure state shows', async () => {
  const h = load(); h.set('OVAT', 5000);
  h.ovFetch(); await settle();
  assert.strictEqual(h.get('OVAT'), 5000, 'OVAT is the last success');
  assert.strictEqual(h.get('OVFAIL'), true);
  assert(/refresh failed/.test(h.log.age[h.log.age.length - 1]), 'age line says it failed');
  assert(/ago/.test(h.log.age[h.log.age.length - 1]));
});
t('first load fails: no "updated" line, says it could not load', async () => {
  const h = load(); h.ovFetch(); await settle();
  assert.strictEqual(h.get('OVAT'), 0);
  assert(/could not load/.test(h.log.age[h.log.age.length - 1]));
});
t('a failed refresh still waits a full period before the next try', async () => {
  const h = load(); h.ovFetch(); await settle();
  const n = h.log.calls.length; h.ovTick(); await settle();
  assert.strictEqual(h.log.calls.length, n, 'no retry on the next tick');
});
t('one read succeeds: OVAT moves and there is no failure state', async () => {
  const h = load(); h.set('OVAT', 5000);
  h.ctx.respond = u => (u.startsWith('/api/verify') ? Promise.resolve({ ok: true }) : Promise.reject(new Error('down')));
  h.ovFetch(); await settle();
  assert(h.get('OVAT') > 5000); assert.strictEqual(h.get('OVFAIL'), false);
});
t('a later success clears the failure state', async () => {
  const h = load(); h.ovFetch(); await settle(); assert.strictEqual(h.get('OVFAIL'), true);
  h.ctx.respond = () => Promise.resolve({}); h.ovFetch(); await settle();
  assert.strictEqual(h.get('OVFAIL'), false); assert(h.get('OVAT') > 0);
});
t('sparklines: devices sharing a name get no read; others are keyed by node id', async () => {
  const h = load();
  h.get("OVD").tel = { nodes: [
    { node: 'box', node_id: 'id1', reachable: true }, { node: 'box', node_id: 'id2', reachable: true },
    { node: 'solo', node_id: 'id3', reachable: true }, { node: 'gone', node_id: 'id4', reachable: false }] };
  h.ctx.respond = () => Promise.resolve({ by_day: [{ day: '2026-10-01', sessions: 3 }] });
  h.ovSparks(); await settle();
  assert.deepStrictEqual(h.log.calls, ['/api/telemetry?scope=hive&fnode=solo&limit=1']);
  assert.deepStrictEqual(Object.keys(h.get("OVD").perDay), ['id3']);
  assert.strictEqual(h.get("OVD").sameName, 2);
});
t('sparklines: differently named devices each get their own series', async () => {
  const h = load();
  h.get("OVD").tel = { nodes: [{ node: 'a', node_id: 'id1', reachable: true }, { node: 'b', node_id: 'id2', reachable: true }] };
  h.ctx.respond = u => Promise.resolve({ by_day: [{ day: 'd', sessions: u.includes('fnode=a') ? 1 : 2 }] });
  h.ovSparks(); await settle();
  assert.strictEqual(h.get("OVD").perDay.id1.by.d, 1); assert.strictEqual(h.get("OVD").perDay.id2.by.d, 2);
});
(async () => {
  for (const [n, f] of cases) { try { await f(); } catch (e) { console.error('FAIL: ' + n + '\n' + (e.stack || e)); process.exit(1); } }
  console.log('ok ' + cases.length);
})();
