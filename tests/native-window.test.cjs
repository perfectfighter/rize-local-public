'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSampler, SAMPLE_INTERVAL_MS } = require('../desktop/native-window.cjs');

function harness(overrides = {}) {
  const samples = [], errors = [], cleared = [], scheduled = [];
  let loads = 0, initialized = 0;
  const adapter = { initialize() { initialized++; }, getActiveWindow() { return {
    application: 'Code', title: 'A project', pid: 42,
    path: 'C:\\secret\\Code.exe', icon: 'sensitive-icon', url: 'https://secret.test',
  }; } };
  const sampler = createSampler({
    platform: 'win32', now: () => 1_000,
    powerMonitor: { getSystemIdleTime: () => 3 },
    loadNative() { loads++; return adapter; },
    onSample(sample) { samples.push(sample); }, onError(error) { errors.push(error); },
    setInterval(fn, interval) { scheduled.push({ fn, interval }); return 8; },
    clearInterval(id) { cleared.push(id); },
    ...overrides,
  });
  return { sampler, samples, errors, cleared, scheduled, adapter, get loads() { return loads; }, get initialized() { return initialized; } };
}

test('creation never loads native code or schedules work', () => {
  const h = harness();
  assert.equal(h.loads, 0); assert.equal(h.scheduled.length, 0);
  assert.deepEqual(h.sampler.getStatus(), { running: false, available: false, message: 'Activity tracking is off.' });
});
test('start initializes once, emits only allowed metadata, polls every five seconds', () => {
  const h = harness();
  assert.equal(h.sampler.start(), true);
  assert.equal(h.loads, 1); assert.equal(h.initialized, 1);
  assert.equal(h.scheduled[0].interval, SAMPLE_INTERVAL_MS);
  assert.deepEqual(h.samples[0], { timestamp: '1970-01-01T00:00:01.000Z', app: 'Code', title: 'A project', pid: 42, idleSeconds: 3, available: true });
  h.scheduled[0].fn(); h.sampler.start();
  assert.equal(h.loads, 1); assert.equal(h.scheduled.length, 1); assert.equal(h.samples.length, 2);
});
test('stop prevents later callbacks and clears interval', () => {
  const h = harness(); h.sampler.start(); h.sampler.stop(); h.scheduled[0].fn();
  assert.deepEqual(h.cleared, [8]); assert.equal(h.samples.length, 1);
  assert.equal(h.sampler.getStatus().running, false);
});
test('unsupported platform does not load native addon', () => {
  const h = harness({ platform: 'linux' });
  assert.equal(h.sampler.start(), false); assert.equal(h.loads, 0); assert.equal(h.scheduled.length, 0);
  assert.equal(h.samples[0].available, false);
});
test('native failure is explicit, strips sensitive error detail, and can recover', () => {
  const h = harness();
  h.adapter.getActiveWindow = () => { throw new Error('C:\\private\\somefile'); };
  assert.equal(h.sampler.start(), false);
  assert.equal(h.errors.length, 1); assert.doesNotMatch(h.errors[0].message, /private|somefile/);
  assert.equal(h.samples[0].app, '');
  h.adapter.getActiveWindow = () => ({ application: 'Editor', title: 'Recovered', pid: 8 });
  h.scheduled[0].fn(); assert.equal(h.samples.at(-1).available, true);
});
test('failed lazy initialization retries without starting a second interval', () => {
  let calls = 0;
  const h = harness({ loadNative() { calls++; if (calls === 1) throw new Error('Missing prebuild'); return { initialize() {}, getActiveWindow: () => ({ application: 'Editor', title: 'A' }) }; } });
  assert.equal(h.sampler.start(), false); h.scheduled[0].fn();
  assert.equal(h.samples.at(-1).available, true); assert.equal(calls, 2); assert.equal(h.scheduled.length, 1);
});
test('private browser titles are redacted and URL-like strings omitted', () => {
  const h = harness();
  h.adapter.getActiveWindow = () => ({ application: 'Chrome', title: 'Secret - Incognito', pid: 5 });
  h.sampler.start(); assert.equal(h.samples[0].title, '[Private window]');
  h.adapter.getActiveWindow = () => ({ application: 'Browser', title: 'Visit https://secret.test/account and www.private.test today', pid: 5 });
  h.scheduled[0].fn(); assert.equal(h.samples[1].title, 'Visit [address] and [address] today');
});
test('control characters are stripped and retained fields bounded', () => {
  const h = harness(); h.adapter.getActiveWindow = () => ({ application: 'Ed\0itor\u0085', title: 'A\r\nB\tC\u001b', pid: -1 });
  h.sampler.start(); assert.equal(h.samples[0].app, 'Editor'); assert.equal(h.samples[0].title, 'ABC'); assert.equal(h.samples[0].pid, 0);
});
test('unknown idle status and missing foreground are not recorded as activity', () => {
  const h = harness({ powerMonitor: { getSystemIdleTime: () => NaN } }); h.sampler.start();
  assert.equal(h.samples[0].available, false); assert.equal(h.errors.length, 1);
  const absent = harness(); absent.adapter.getActiveWindow = () => null; absent.sampler.start();
  assert.equal(absent.samples[0].available, false); assert.equal(absent.errors.length, 0);
});
