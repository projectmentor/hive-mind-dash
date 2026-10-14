// Behaviour test for the peers last-seen display (hive-mind-dash#18 gap 3). Cuts fmtSeen out of dashboard/app.js and runs it in a node vm.
// Usage: node seen_at.js <path to app.js>.   Exit 0 and prints "ok" when every case holds.
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');
const i = src.indexOf('const fmtSeen='), j = src.indexOf('\n', i);
assert(i > 0 && j > i, 'fmtSeen not found');
const seen = p => { const ctx = {}; vm.createContext(ctx); return vm.runInContext(src.slice(i, j) + '\nfmtSeen(' + JSON.stringify(p) + ')', ctx); };
assert.strictEqual(seen({ seen: '2026-10-14', seen_at: '2026-10-14T09:30:00+00:00' }), '2026-10-14 09:30 UTC');
assert.strictEqual(seen({ seen: '2026-10-14', seen_at: '2026-10-14T11:30:00+02:00' }), '2026-10-14 09:30 UTC');   // any offset, shown in UTC
assert.strictEqual(seen({ seen: '2026-10-14' }), '2026-10-14');                                                    // older core: no seen_at
assert.strictEqual(seen({ seen: '—', seen_at: null }), '—');                                                      // never seen
assert.strictEqual(seen({ seen: '2026-10-14', seen_at: 'garbage' }), '2026-10-14');                               // unparseable: the date
console.log('ok');
