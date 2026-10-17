'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrackingEngine } = require('../desktop/tracking-engine.cjs');

function state(overrides = {}) { return { onboarded: true, demo: false, settings: { trackingEnabled: true, idleSeconds: 300 }, rules: [], clients: [], projects: [], tasks: [], ...overrides }; }
function sample(time, overrides = {}) { return { timestamp: typeof time === 'string' ? time : new Date(time).toISOString(), app: 'Code', title: 'Project', idleSeconds: 0, available: true, ...overrides }; }
function engine() { let id = 0; return createTrackingEngine({ idFactory: () => ++id }); }

test('requires explicit onboarding, non-demo, and tracking opt-in', () => {
  for (const overrides of [{ onboarded: false }, { demo: true }, { settings: { trackingEnabled: false } }, { settings: {} }]) {
    const e = engine(), s = state(overrides); assert.deepEqual(e.consume(sample(0), s), []); assert.deepEqual(e.consume(sample(5000), s), []);
  }
});
test('first point makes no entry; consecutive points retain precise bounds and upsert id', () => {
  const e = engine(), s = state(); assert.deepEqual(e.consume(sample(123), s), []);
  const first = e.consume(sample(5123), s)[0];
  assert.equal(first.start, '1970-01-01T00:00:00.123Z'); assert.equal(first.end, '1970-01-01T00:00:05.123Z'); assert.equal(first.durationMs, 5000);
  const second = e.consume(sample(10128), s)[0]; assert.equal(second.id, first.id); assert.equal(second.durationMs, 10005);
  assert.equal(first.durationMs, 5000); assert.equal(second.status, 'pending'); assert.equal(second.source, 'automatic');
  assert.equal('signature' in second, false); assert.equal('localDay' in second, false);
});
test('window switches produce separate records without zero-duration artifacts', () => {
  const e = engine(), s = state(); e.consume(sample(0), s);
  const a = e.consume(sample(5000, { app: 'Word', title: 'Document' }), s)[0];
  const b = e.consume(sample(10000, { app: 'Word', title: 'Document' }), s)[0];
  assert.equal(a.app, 'Code'); assert.equal(b.app, 'Word'); assert.notEqual(a.id, b.id); assert.equal(b.start, a.end);
});
test('idle crossing, unavailable samples, and sleep gaps never fabricate missing time', () => {
  for (const bad of [{ idleSeconds: 300 }, { idleSeconds: NaN }, { available: false }, { app: '' }]) {
    const e = engine(), s = state(); e.consume(sample(0), s); assert.deepEqual(e.consume(sample(5000, bad), s), []);
    assert.deepEqual(e.consume(sample(10000), s), []); assert.equal(e.consume(sample(15000), s)[0].durationMs, 5000);
  }
  const e = engine(), s = state(); e.consume(sample(0), s); assert.deepEqual(e.consume(sample(60000), s), []);
  assert.equal(e.consume(sample(65000), s)[0].durationMs, 5000);
});
test('flush closes at last sample and does not credit a quit or lock tail', () => {
  const e = engine(), s = state(); e.consume(sample(0), s); const a = e.consume(sample(5000), s)[0];
  assert.deepEqual(e.flush(90000, s), [a]); assert.deepEqual(e.flush(90000, s), []);
  assert.deepEqual(e.consume(sample(100000), s), []);
});
test('turning tracking off resets continuity; pausing timer does not stop automatic activity', () => {
  const e = engine(), s = state(); e.consume(sample(0), s);
  assert.deepEqual(e.consume(sample(5000), state({ settings: { trackingEnabled: false } })), []);
  assert.deepEqual(e.consume(sample(10000), s), []);
  assert.equal(e.consume(sample(15000), { ...s, timer: { status: 'paused' } })[0].durationMs, 5000);
  assert.deepEqual(e.consume(sample(20000), { ...s, trackingPaused: true }), []);
});
test('explicit exclusion is stronger than other matches and never saves the excluded window', () => {
  const s = state({ rules: [{ keyword: 'Project', action: 'productive' }, { keyword: 'Project', action: 'exclude' }] }), e = engine();
  e.consume(sample(0), s); assert.deepEqual(e.consume(sample(5000), s), []); assert.deepEqual(e.flush(10000, s), []);
});
test('classification and keyword tags resolve a task and its project/client ancestors', () => {
  const s = state({ clients: [{ id: 'c', name: 'Acme' }], projects: [{ id: 'p', clientId: 'c', keywords: 'Acme,Launch' }], tasks: [{ id: 't', projectId: 'p', keywords: ['Launch'] }] });
  const e = engine(); e.consume(sample(0, { title: 'Launch' }), s);
  const a = e.consume(sample(5000, { title: 'Launch' }), s)[0];
  assert.deepEqual([a.clientId, a.projectId, a.taskId, a.category], ['c', 'p', 't', 'productive']);
  const ruled = state({ ...s, rules: [{ keyword: 'Launch', action: 'distracting', projectId: 'p' }] });
  const f = engine(); f.consume(sample(0, { title: 'Launch' }), ruled);
  const b = f.consume(sample(5000, { title: 'Launch' }), ruled)[0]; assert.equal(b.category, 'distracting'); assert.equal(b.projectId, 'p'); assert.equal(b.taskId, '');
});
test('unknown linked entities are not invented', () => {
  const e = engine(), s = state({ rules: [{ keyword: 'Project', action: 'neutral', clientId: 'missing', projectId: 'missing', taskId: 'missing' }] });
  e.consume(sample(0), s); const a = e.consume(sample(5000), s)[0]; assert.deepEqual([a.clientId, a.projectId, a.taskId], ['', '', '']);
});
test('splits at local midnight and credits only actual interval on each side', () => {
  const start = new Date(2026, 9, 19, 23, 59, 58, 123).getTime();
  const midnight = new Date(2026, 9, 20, 0, 0, 0, 0).getTime();
  const e = engine(), s = state(); e.consume(sample(start), s); const rows = e.consume(sample(start + 5000), s);
  assert.equal(rows.length, 2); assert.equal(rows[0].durationMs, midnight - start); assert.equal(rows[1].durationMs, start + 5000 - midnight); assert.notEqual(rows[0].id, rows[1].id);
});
test('schedule boundaries clip exact intervals rather than counting all or nothing', () => {
  const s = state({ settings: { trackingEnabled: true, scheduleEnabled: true, scheduleStart: '09:00', scheduleEnd: '17:00', workDays: [1] } });
  const start = new Date(2026, 9, 19, 8, 59, 58, 123).getTime();
  const e = engine(); e.consume(sample(start), s); const rows = e.consume(sample(start + 5000), s);
  assert.equal(rows.length, 1); assert.equal(rows[0].start, new Date(2026, 9, 19, 9).toISOString()); assert.equal(rows[0].durationMs, 3123);
  const weekend = engine(), t = new Date(2026, 9, 18, 10).getTime(); weekend.consume(sample(t), s); assert.deepEqual(weekend.consume(sample(t + 5000), s), []);
});
test('overnight schedule follows the shift start day across midnight', () => {
  const s = state({ settings: { trackingEnabled: true, scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '06:00', workDays: [1] } });
  const t = new Date(2026, 9, 20, 5, 59, 58).getTime(), e = engine(); e.consume(sample(t), s);
  const rows = e.consume(sample(t + 5000), s); assert.equal(rows[0].durationMs, 2000);
  const after = engine(); after.consume(sample(t + 5000), s); assert.deepEqual(after.consume(sample(t + 10000), s), []);
});
test('duplicate and reversed samples cannot extend records or duplicate time', () => {
  const e = engine(), s = state(); e.consume(sample(0), s); e.consume(sample(5000), s);
  assert.deepEqual(e.consume(sample(5000), s), []); assert.deepEqual(e.consume(sample(4000), s), []);
  assert.equal(e.consume(sample(10000), s)[0].durationMs, 10000);
});
test('engine independently strips control chars, redacts URLs and private titles', () => {
  const e = engine(), s = state(), a = { app: 'Br\0owser', title: 'Secret - InPrivate' };
  e.consume(sample(0, a), s); const rows = e.consume(sample(5000, a), s);
  assert.equal(rows[0].title, '[Private window]'); assert.equal(rows[0].app, 'Browser'); assert.equal(rows[0].description, '[Private window]');
});
