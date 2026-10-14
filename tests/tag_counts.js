// Behaviour test for the tag-picker counts (hive-mind-dash#18 gap 5). Cuts tagCount out of dashboard/app.js and runs it in a node vm.
// Usage: node tag_counts.js <path to app.js>.   Exit 0 and prints "ok" when every case holds.
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');
const i = src.indexOf('const tagCount='), j = src.indexOf('\n', i);
assert(i > 0 && j > i, 'tagCount not found');
const count = (counts, t) => { const ctx = { C: { tagCounts: counts } }; vm.createContext(ctx); return vm.runInContext(src.slice(i, j) + '\ntagCount(' + JSON.stringify(t) + ')', ctx); };
assert.strictEqual(count({ a: 3, b: 0 }, 'a'), 3);
assert.strictEqual(count({ a: 3, b: 0 }, 'b'), 0);          // zero is shown, not hidden
assert.strictEqual(count({ a: 3 }, 'zzz'), null);            // a tag the counts do not name
assert.strictEqual(count(null, 'a'), null);                  // older core: no counts field
assert.strictEqual(count({ a: '3' }, 'a'), null);            // not a number: ignored
console.log('ok');
