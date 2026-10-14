// Behaviour tests for the D4 follow-ups (hive-mind-dash#32). Cuts scanOr and openHash out of dashboard/app.js and runs them in a node vm.
// Usage: node corpus_followups.js <path to app.js>.   Exit 0 and prints "ok" when every case holds.
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert(i > 0 && j > i, a + ' not found'); return src.slice(i, j); };
const orCode = cut('async function scanOr(', 'const cappedNote');
const setHashCode = cut('function setHash(', 'const ID_RE') + cut('const restHash=', 'function applySub');
const hashCode = cut('async function openHash(', "window.addEventListener('hashchange'");

async function sorted(sort, kind, rowsByTag) {
  const ctx = { C: { q: '', sort, status: 'all', mode: 'or', tags: Object.keys(rowsByTag), scan: {} }, KIND_KEY: { fact: 'facts', decision: 'decisions' }, SCAN_PER: 200, OR_MAX: 8,
    URLSearchParams, String, JSON, Promise, Map, capped: 0,
    getJSON: async u => ({ [kind === 'fact' ? 'facts' : 'decisions']: rowsByTag[new URL(u, 'http://x').searchParams.get('tag')] }) };
  vm.createContext(ctx);
  const r = await vm.runInContext(orCode + ';scanOr(' + JSON.stringify(kind) + ')', ctx);
  return JSON.stringify(r.rows.map(x => x.sid));
}
function hashCase(viewer, hash) {
  const log = { applied: null, rendered: 0, replaced: [], nav: null };
  const ctx = { VIEWER: viewer, location: { hash, pathname: '/', search: '' }, SUB_SET: { search: 1, 'latest-facts': 1, entities: 1 },
    state: { view: 'overview', node: null, detail: null }, C: { sub: 'search' },
    history: { replaceState: (a, b, u) => { log.replaced.push(u); ctx.location.hash = ''; } },
    applySub: s => { log.applied = s; ctx.C.sub = s; }, setNav: v => { log.nav = v; }, render: () => { log.rendered++; }, openById: async () => false };
  vm.createContext(ctx);
  ctx.run = () => vm.runInContext(setHashCode + hashCode + ';openHash()', ctx);
  return { ctx, log };
}
const cases = [], t = (n, f) => cases.push([n, f]);
t('OR + decisions + confidence: newest first, not grouped by tag', async () => {
  const got = await sorted('confidence', 'decision', { a: [{ sid: 'a1', created: '2026-01-01' }, { sid: 'a2', created: '2026-03-01' }], b: [{ sid: 'b1', created: '2026-02-01' }, { sid: 'b2', created: '2026-04-01' }] });
  assert.strictEqual(got, JSON.stringify(['b2', 'a2', 'b1', 'a1']));
});
for (const s of ['importance', 'utility']) t(`OR + decisions + ${s}: newest first`, async () => {
  assert.strictEqual(await sorted(s, 'decision', { a: [{ sid: 'a1', created: '2026-01-01' }], b: [{ sid: 'b1', created: '2026-02-01' }] }), JSON.stringify(['b1', 'a1']));
});
t('OR + facts + confidence still sorts by confidence', async () => {
  assert.strictEqual(await sorted('confidence', 'fact', { a: [{ sid: 'a1', confidence: 0.2, created: '2026-09-01' }], b: [{ sid: 'b1', confidence: 0.9, created: '2026-01-01' }] }), JSON.stringify(['b1', 'a1']));
});
t('viewer opening #corpus/entities lands on Search and keeps the corpus view', async () => {
  const { ctx, log } = hashCase(true, '#corpus/entities'); assert.strictEqual(await ctx.run(), true);
  assert.strictEqual(log.applied, 'search'); assert.strictEqual(ctx.state.view, 'corpus'); assert.strictEqual(log.rendered, 1); assert.strictEqual(log.nav, 'corpus');
  assert.strictEqual(ctx.location.hash, '', 'the stale entities hash is dropped');
});
t('operator opening #corpus/entities gets Entities', async () => {
  const { ctx, log } = hashCase(false, '#corpus/entities'); assert.strictEqual(await ctx.run(), true); assert.strictEqual(log.applied, 'entities');
});
t('an unknown sub-tab is still refused', async () => {
  const { ctx } = hashCase(true, '#corpus/nope'); assert.strictEqual(await ctx.run(), false);
});
(async () => { for (const [n, f] of cases) { try { await f(); } catch (e) { console.error('FAIL', n, '\n', e.message); process.exit(1); } } console.log('ok ' + cases.length); })();
