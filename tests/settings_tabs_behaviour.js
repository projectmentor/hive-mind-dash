// Behaviour test for Settings › Node tabs (hive-mind-dash#41). Cuts the real settingsSplit, fleetNote and settingsTabSwitch out of
// dashboard/app.js and runs them in a node vm with fake elements.
// Usage: node settings_tabs_behaviour.js <path to app.js>.   Exit 0 and prints "ok" when every case holds.
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(process.argv[2], 'utf8');
const i = src.indexOf("const SETTINGS_TABS="), j = src.indexOf('function settingsPanel(', i);
assert(i > 0 && j > i, 'tab source not found in app.js');
const api = vm.runInContext(src.slice(i, j) + '\n;({settingsSplit,fleetNote,settingsTabSwitch})', vm.createContext({}));
const el = () => { const e = { hidden: false, on: false, classList: { toggle: (c, f) => { assert.strictEqual(c, 'active'); e.on = f; } } }; return e; };
const cases = [], t = (n, f) => cases.push([n, f]);

t('split: governed keys are Fleet, every other class is This device', () => {
  const keys = [{ id: 'a', class: 'governed' }, { id: 'b', class: 'node' }, { id: 'c', class: 'module' }, { id: 'd' }, { id: 'e', class: 'governed' }];
  const { fleet, dev } = api.settingsSplit(keys);
  assert.strictEqual(fleet.map(k => k.id).join(), 'a,e');
  assert.strictEqual(dev.map(k => k.id).join(), 'b,c,d');
  assert.strictEqual(JSON.stringify(api.settingsSplit([])), '{"fleet":[],"dev":[]}');
});
t('owner-key note: shown when there are fleet keys to change, absent when there are none', () => {
  assert(/unlocked owner key/.test(api.fleetNote(3)));
  assert(!/unlocked owner key/.test(api.fleetNote(0)));
  assert(/shared by every device/.test(api.fleetNote(0)));
});
t('tab switch: only the chosen pane shows and its button is active', () => {
  const btns = { fleet: el(), device: el() }, panes = { fleet: el(), device: el() };
  api.settingsTabSwitch('fleet', btns, panes);
  assert.strictEqual(panes.fleet.hidden, false); assert.strictEqual(panes.device.hidden, true);
  assert.strictEqual(btns.fleet.on, true); assert.strictEqual(btns.device.on, false);
  api.settingsTabSwitch('device', btns, panes);
  assert.strictEqual(panes.fleet.hidden, true); assert.strictEqual(panes.device.hidden, false);
  assert.strictEqual(btns.fleet.on, false); assert.strictEqual(btns.device.on, true);
});
t('tab switch keeps the pane elements (so unsaved input survives): it never replaces them', () => {
  const btns = { fleet: el(), device: el() }, panes = { fleet: el(), device: el() };
  const keep = { ...panes };
  panes.device.draft = 'typed'; api.settingsTabSwitch('fleet', btns, panes); api.settingsTabSwitch('device', btns, panes);
  assert.strictEqual(panes.device, keep.device); assert.strictEqual(panes.device.draft, 'typed');
});

for (const [name, fn] of cases) {
  try { fn(); } catch (e) { console.error('FAIL: ' + name + '\n' + (e && e.stack || e)); process.exit(1); }
}
console.log('ok ' + cases.length);
