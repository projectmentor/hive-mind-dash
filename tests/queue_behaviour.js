// Behaviour test for the dashboard's request queue, getJSON and failText (hdash 0.2 D1). It cuts the real source out of
// dashboard/app.js, runs it in a node vm with a fake fetch, document and setTimeout, and asserts what happens.
// Usage: node queue_behaviour.js <path to app.js>.   Exit 0 and prints "ok" when every case holds.
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('function viewerRefused('), b = src.indexOf('const spin=');
assert(a > 0 && b > a, 'queue source not found in app.js');
const code = src.slice(a, b);

function load(viewer) {
  const notes = [], delays = [], calls = [];
  const note = { hidden: true, textContent: '' };
  const ctx = {
    VIEWER: viewer, QMAX_UNUSED: 0, viewerUrl: u => u, notes, delays, calls, note, rnd: 0,
    document: { getElementById: id => (id === 'vnote' ? note : null) },
    Math: Object.create(Math, { random: { value: () => ctx.rnd } }),
    setTimeout: (f, ms) => { delays.push(ms); f(); },
    fetch: async u => { calls.push(u); return ctx.respond(u); },
    respond: null,
  };
  vm.createContext(ctx);
  const api = vm.runInContext(code + '\n;({getJSON,failText,QMAX,RATE_TEXT})', ctx);
  return { ctx, api, note, delays, calls };
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError('bad json'); return body; } });
const fails = async p => { try { await p; } catch (e) { return e; } assert.fail('expected a rejection'); };
const tick = () => new Promise(r => setImmediate(r));
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

for (const [viewer, max] of [[false, 6], [true, 4]]) {
  t(`queue: at most ${max} requests in flight for ${viewer ? 'a viewer' : 'the operator'}`, async () => {
    const { ctx, api } = load(viewer);
    assert.strictEqual(api.QMAX, max);
    let live = 0, peak = 0; const gates = [];
    ctx.respond = () => new Promise(res => { live++; peak = Math.max(peak, live); gates.push(() => { live--; res(reply(200, { ok: 1 })); }); });
    const all = Array.from({ length: 12 }, (_, i) => api.getJSON('/api/x' + i));
    await tick();
    assert.strictEqual(gates.length, max, 'only QMAX fetches start');
    while (gates.length) { gates.shift()(); await tick(); }
    const got = await Promise.all(all);
    assert.strictEqual(got.length, 12); assert.strictEqual(peak, max);
  });
}
t('queue: a failed request frees its slot', async () => {
  const { ctx, api } = load(false);
  ctx.respond = () => reply(500, { error: 'x' });
  for (let i = 0; i < 20; i++) await fails(api.getJSON('/api/x'));
  ctx.respond = () => reply(200, { v: 1 });
  assert.deepStrictEqual(await api.getJSON('/api/x'), { v: 1 });
});
t('retry: a busy 503 is retried once, after 300 to 800 ms', async () => {
  for (const [rnd, want] of [[0, 300], [0.5, 550]]) {
    const { ctx, api, delays, calls } = load(false); ctx.rnd = rnd;
    let n = 0; ctx.respond = () => (n++ ? reply(200, { v: 2 }) : reply(503, { error: 'server busy' }));
    assert.deepStrictEqual(await api.getJSON('/api/x'), { v: 2 });
    assert.strictEqual(calls.length, 2); assert.deepStrictEqual(delays, [want]);
  }
  const { ctx, api, delays } = load(false); ctx.rnd = 0.999999;
  let n = 0; ctx.respond = () => (n++ ? reply(200, {}) : reply(503, { error: 'busy' }));
  await api.getJSON('/api/x'); assert(delays[0] >= 300 && delays[0] < 800);
});
t('retry: a second busy 503 is thrown with status 503 and busy true, after one retry only', async () => {
  const { ctx, api, calls, delays } = load(false);
  ctx.respond = () => reply(503, { error: 'server busy' });
  const e = await fails(api.getJSON('/api/x'));
  assert.strictEqual(e.status, 503); assert.strictEqual(e.busy, true);
  assert.strictEqual(calls.length, 2); assert.strictEqual(delays.length, 1);
});
t('retry: only a busy 503 is retried', async () => {
  for (const [st, body] of [[503, { error: 'other' }], [503, null], [500, { error: 'server busy' }], [429, {}], [404, {}]]) {
    const { ctx, api, calls } = load(false);
    ctx.respond = () => reply(st, body);
    const e = await fails(api.getJSON('/api/x'));
    assert.strictEqual(calls.length, 1, `${st} ${JSON.stringify(body)}`); assert.strictEqual(e.status, st); assert.strictEqual(e.busy, false);
  }
});
t('getJSON: an ok reply with a body that is not JSON throws, an error reply with none throws its status', async () => {
  const { ctx, api } = load(false);
  ctx.respond = () => reply(200, undefined);
  assert((await fails(api.getJSON('/api/x'))) instanceof SyntaxError);
  ctx.respond = () => reply(502, undefined);
  assert.strictEqual((await fails(api.getJSON('/api/x'))).status, 502);
});
t('viewer note: a refusal from the viewer listener shows the note, with the path and the error', async () => {
  const { ctx, api, note } = load(true);
  ctx.respond = () => reply(403, { error: 'not for viewers', listener: 'viewer' });
  assert.strictEqual((await fails(api.getJSON('/api/secret?a=1'))).status, 403);
  assert.strictEqual(note.hidden, false);
  assert.strictEqual(note.textContent, 'The viewer listener refused /api/secret: not for viewers.');
});
t('viewer note: not shown for a 429 from the viewer listener', async () => {
  const { ctx, api, note } = load(true);
  ctx.respond = () => reply(429, { error: 'rate', listener: 'viewer' });
  await fails(api.getJSON('/api/x')); assert.strictEqual(note.hidden, true);
});
t('viewer note: not shown for a busy 503 from the viewer listener, after the retry', async () => {
  const { ctx, api, note } = load(true);
  ctx.respond = () => reply(503, { error: 'server busy', listener: 'viewer' });
  await fails(api.getJSON('/api/x')); assert.strictEqual(note.hidden, true);
});
t('viewer note: not shown without the viewer marker, nor for the operator', async () => {
  let { ctx, api, note } = load(true);
  ctx.respond = () => reply(403, { error: 'no' });
  await fails(api.getJSON('/api/x')); assert.strictEqual(note.hidden, true);
  ({ ctx, api, note } = load(false));
  ctx.respond = () => reply(403, { error: 'no', listener: 'viewer' });
  await fails(api.getJSON('/api/x')); assert.strictEqual(note.hidden, true);
});
t('failText: 429 is the rate-limit text, busy is the busy text, anything else is the fallback', () => {
  const { api } = load(false);
  const f = api.failText;
  assert.strictEqual(f({ status: 429 }, 'down'), 'rate limited, try again in a moment');
  assert.strictEqual(f({ status: 429, busy: true }, 'down'), 'rate limited, try again in a moment');
  for (const st of [428, 430, 400, 503, 0]) assert.strictEqual(f({ status: st }, 'down'), 'down', String(st));
  assert.strictEqual(f({ status: 503, busy: true }, 'down'), 'the service is busy, try again in a moment');
  for (const e of [null, undefined, {}, new Error('x'), { busy: false }]) assert.strictEqual(f(e, 'down'), 'down');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); } catch (e) { console.error('FAIL: ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
  }
  console.log('ok ' + cases.length);
})();
