'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore, toCsv, splitAtMidnight } = require('../desktop/store.cjs');

const baseTime = Date.parse('2026-10-17T09:00:00.000Z');
function fixture(options = {}) {
  let time = options.time ?? baseTime;
  const store = createStore({ ...options, now: () => time });
  return { store, set(value) { time = typeof value === 'string' ? Date.parse(value) : value; }, advance(ms) { time += ms; } };
}
const command = (store, type, payload = {}) => store.mutate({ type, payload });
const workspace = store => command(store, 'workspace.create', { displayName: 'Ada' });
const entry = (overrides = {}) => ({ id: 'entry-1', start: '2026-10-17T09:00:00.123Z', end: '2026-10-17T09:30:00.456Z', description: 'Implementation', app: 'Code', title: 'Project', status: 'pending', source: 'automatic', category: 'productive', ...overrides });
function directory(t) {
  const root = path.resolve(__dirname, '.store-fixtures');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('new workspace is empty, tracking is opt-in, and copies are defensive', () => {
  const { store } = fixture();
  const empty = store.getState();
  assert.equal(empty.onboarded, false);
  assert.equal(empty.settings.trackingEnabled, false);
  assert.equal(empty.entries.length, 0);
  empty.settings.trackingEnabled = true;
  empty.entries.push(entry());
  assert.equal(store.getState().entries.length, 0);
  const created = workspace(store);
  assert.equal(created.onboarded, true);
  assert.equal(created.settings.displayName, 'Ada');
  created.settings.displayName = 'Mutated copy';
  assert.equal(store.getState().settings.displayName, 'Ada');
});

test('demo data is explicit and cannot enable real tracking', () => {
  const { store } = fixture();
  const demo = command(store, 'workspace.demo');
  assert.equal(demo.demo, true);
  assert.equal(demo.entries.length, 15);
  assert.throws(() => command(store, 'settings.update', { trackingEnabled: true }), /own workspace/);
  const real = workspace(store);
  assert.equal(real.demo, false);
  assert.equal(real.entries.length, 0);
});

test('entry duration derives from timestamps preserving milliseconds', () => {
  const { store } = fixture();
  workspace(store);
  const value = command(store, 'entry.upsert', entry({ durationMs: 1 }));
  assert.equal(value.entries[0].durationMs, 1800333);
  const reviewed = command(store, 'entry.review', { id: 'entry-1', status: 'approved' });
  assert.equal(reviewed.entries[0].start, '2026-10-17T09:00:00.123Z');
  assert.equal(reviewed.entries[0].end, '2026-10-17T09:30:00.456Z');
});

test('invalid mutation is transactional and cannot erase valid data', () => {
  const { store } = fixture();
  workspace(store);
  command(store, 'entry.upsert', entry());
  const before = store.getState();
  assert.throws(() => command(store, 'entry.upsert', entry({ end: '2026-10-17T08:00:00.000Z' })), /end after/);
  assert.throws(() => command(store, 'entry.upsert', entry({ start: '2026-02-30T09:00:00.000Z' })), /valid ISO/);
  assert.throws(() => command(store, 'settings.update', { idleSeconds: -1 }), /Idle threshold/);
  assert.throws(() => command(store, 'missing.command'), /Unknown command/);
  assert.deepEqual(store.getState(), before);
});

test('entity hierarchy derives parent IDs and rejects incompatible tags', () => {
  const { store } = fixture();
  workspace(store);
  command(store, 'client.upsert', { id: 'a', name: 'Client A', hourlyRate: 100 });
  command(store, 'client.upsert', { id: 'b', name: 'Client B' });
  command(store, 'project.upsert', { id: 'p', name: 'Project', clientId: 'a', keywords: 'Website, Design' });
  command(store, 'task.upsert', { id: 't', name: 'Task', projectId: 'p' });
  const result = command(store, 'entry.upsert', entry({ taskId: 't' }));
  assert.equal(result.entries[0].projectId, 'p');
  assert.equal(result.entries[0].clientId, 'a');
  assert.deepEqual(result.projects[0].keywords, ['Website', 'Design']);
  assert.throws(() => command(store, 'entry.upsert', entry({ clientId: 'b', projectId: 'p', taskId: '' })), /does not belong/);
});

test('parent reassignment and deletion preserve valid dependent links', () => {
  const { store } = fixture();
  workspace(store);
  command(store, 'client.upsert', { id: 'a', name: 'A' });
  command(store, 'client.upsert', { id: 'b', name: 'B' });
  command(store, 'project.upsert', { id: 'p', name: 'Project', clientId: 'a' });
  command(store, 'task.upsert', { id: 't', name: 'Task', projectId: 'p' });
  command(store, 'entry.upsert', entry({ taskId: 't' }));
  const moved = command(store, 'project.upsert', { id: 'p', clientId: 'b' });
  assert.equal(moved.tasks[0].clientId, 'b');
  assert.equal(moved.entries[0].clientId, 'b');
  command(store, 'project.delete', { id: 'p' });
  const deleted = command(store, 'client.delete', { id: 'b' });
  assert.equal(deleted.tasks[0].projectId, '');
  assert.equal(deleted.tasks[0].clientId, '');
  assert.equal(deleted.entries[0].projectId, '');
  assert.equal(deleted.entries[0].clientId, '');
  assert.equal(deleted.entries[0].taskId, 't');
});

test('approved review edits survive stale native upserts without changing time', () => {
  const { store } = fixture();
  workspace(store);
  store.upsertActivity([entry()]);
  command(store, 'entry.upsert', { id: 'entry-1', description: 'Reviewed description', end: '2026-10-17T09:20:00.456Z', status: 'approved' });
  const reviewed = store.getState().entries[0];
  store.upsertActivity([entry({ end: '2026-10-17T10:00:00.000Z', description: 'Stale native metadata' })]);
  assert.deepEqual(store.getState().entries[0], reviewed);
});

test('pending native upserts replace a single ongoing entry and sanitize controls', () => {
  const { store } = fixture();
  workspace(store);
  store.upsertActivity([entry()]);
  store.upsertActivity([entry({ end: '2026-10-17T10:00:00.000Z', title: 'Window\u0000 title\u0007' })]);
  const state = store.getState();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].title, 'Window title');
  assert.equal(state.entries[0].status, 'pending');
  assert.equal(state.entries[0].durationMs, 3599877);
});

test('paused intervals never become recorded timer work', () => {
  const f = fixture();
  workspace(f.store);
  command(f.store, 'timer.start', { goal: 'Focused work', targetMs: 45 * 60000 });
  f.advance(10 * 60000);
  command(f.store, 'timer.pause');
  f.advance(20 * 60000);
  command(f.store, 'timer.resume');
  f.advance(5 * 60000);
  const state = command(f.store, 'timer.stop');
  assert.equal(state.timer, null);
  assert.equal(state.sessions[0].elapsedMs, 15 * 60000);
  assert.equal(state.sessions[0].segments.length, 2);
  assert.equal(state.entries.reduce((sum, item) => sum + item.durationMs, 0), 15 * 60000);
  assert.equal(state.entries[0].end, '2026-10-17T09:10:00.000Z');
  assert.equal(state.entries[1].start, '2026-10-17T09:30:00.000Z');
});

test('cross-midnight timer segments split without shifting real intervals', () => {
  const start = new Date(2026, 9, 17, 23, 55).getTime();
  const f = fixture({ time: start });
  workspace(f.store);
  command(f.store, 'timer.start', { kind: 'meeting' });
  f.advance(10 * 60000);
  const state = command(f.store, 'timer.stop');
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0].durationMs, 5 * 60000);
  assert.equal(state.entries[1].durationMs, 5 * 60000);
  assert.equal(new Date(state.entries[0].start).getDate(), 17);
  assert.equal(new Date(state.entries[1].start).getDate(), 18);
  assert.equal(state.sessions[0].elapsedMs, 10 * 60000);
});

test('automatic tracking during any part of a session prevents duplicate timer entries', () => {
  const f = fixture();
  workspace(f.store);
  command(f.store, 'timer.start');
  f.advance(5 * 60000);
  command(f.store, 'settings.update', { trackingEnabled: true });
  f.advance(5 * 60000);
  command(f.store, 'settings.update', { trackingEnabled: false });
  const state = command(f.store, 'timer.stop');
  assert.equal(state.sessions[0].elapsedMs, 10 * 60000);
  assert.equal(state.sessions[0].autoCollected, true);
  assert.equal(state.entries.length, 0);
});

test('timer metadata and extension retain accumulated time and reject invalid transitions', () => {
  const f = fixture();
  workspace(f.store);
  command(f.store, 'timer.start', { kind: 'break' });
  assert.throws(() => command(f.store, 'timer.start'), /Stop the current/);
  command(f.store, 'timer.extend', { minutes: 5 });
  f.advance(120000);
  command(f.store, 'timer.update', { goal: 'Take a walk' });
  const paused = command(f.store, 'timer.pause');
  assert.equal(paused.timer.targetMs, 10 * 60000);
  assert.equal(paused.timer.elapsedMs, 120000);
  assert.equal(paused.timer.goal, 'Take a walk');
  assert.throws(() => command(f.store, 'timer.pause'), /already paused/);
  assert.throws(() => command(f.store, 'timer.extend', { minutes: -5 }), /Additional minutes/);
});

test('backward clock movement cannot create negative work or overlapping segments', () => {
  const f = fixture();
  workspace(f.store);
  command(f.store, 'timer.start');
  f.advance(60000);
  command(f.store, 'timer.pause');
  f.set(baseTime - 1000);
  command(f.store, 'timer.resume');
  const state = command(f.store, 'timer.stop');
  assert.equal(state.sessions[0].elapsedMs, 60000);
  assert.equal(state.sessions[0].endedAt, '2026-10-17T09:01:00.000Z');
});

test('atomic persistence checkpoints running timers paused and excludes downtime on restart', t => {
  const file = path.join(directory(t), 'workspace.json');
  const f = fixture({ file });
  workspace(f.store);
  command(f.store, 'timer.start');
  f.advance(7 * 60000);
  f.store.flush();
  assert.equal(f.store.getState().timer.status, 'running');
  const restarted = fixture({ file, time: baseTime + 2 * 3600000 });
  assert.equal(restarted.store.getState().timer.status, 'paused');
  assert.equal(restarted.store.getState().timer.elapsedMs, 7 * 60000);
  const stopped = command(restarted.store, 'timer.stop');
  assert.equal(stopped.sessions[0].elapsedMs, 7 * 60000);
  assert.equal(stopped.entries.reduce((sum, item) => sum + item.durationMs, 0), 7 * 60000);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')), false);
});

test('backup closes a live interval in its copy and round-trips without starting timers', () => {
  const f = fixture();
  workspace(f.store);
  command(f.store, 'timer.start');
  f.advance(125123);
  const backup = f.store.exportSnapshot();
  assert.equal(backup.timer.status, 'paused');
  assert.equal(backup.timer.elapsedMs, 125123);
  assert.equal(f.store.getState().timer.status, 'running');
  const destination = fixture();
  destination.store.importData(JSON.stringify(backup));
  assert.deepEqual(destination.store.getState(), backup);
});

test('invalid imports preserve current state, reject duplicate IDs and forged accounting', () => {
  const { store } = fixture();
  workspace(store);
  command(store, 'entry.upsert', entry());
  const before = store.getState();
  assert.throws(() => store.importData('{'), /valid JSON/);
  assert.throws(() => store.importData({ ...before, schemaVersion: 99 }), /schema/);
  assert.throws(() => store.importData({ ...before, entries: [before.entries[0], before.entries[0]] }), /Duplicate entry/);
  assert.throws(() => store.importData({ ...before, settings: { ...before.settings, trackingEnabled: 'true' } }), /true or false/);
  assert.deepEqual(store.getState(), before);
  command(store, 'timer.start');
  const backup = store.exportSnapshot();
  backup.timer.elapsedMs = 60000;
  assert.throws(() => store.importData(backup), /active segments/);
});

test('corrupt original workspace is preserved and startup reports a useful error', t => {
  const file = path.join(directory(t), 'workspace.json');
  fs.writeFileSync(file, '{original incomplete bytes');
  assert.throws(() => createStore({ file }), /original file was preserved/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{original incomplete bytes');
});

test('failed disk save does not commit in-memory changes', t => {
  const dir = directory(t);
  const blocked = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocked, 'sentinel');
  const { store } = fixture({ file: path.join(blocked, 'workspace.json') });
  assert.throws(() => workspace(store));
  assert.equal(store.getState().onboarded, false);
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'sentinel');
});

test('CSV quotes data, neutralizes formulas, and computes billable amounts', () => {
  const { store } = fixture();
  workspace(store);
  command(store, 'client.upsert', { id: 'client', name: '=SUM(1,2)', hourlyRate: 120 });
  command(store, 'entry.upsert', entry({ start: '2026-10-17T09:00:00.000Z', end: '2026-10-17T09:30:00.000Z', clientId: 'client', description: '@danger,"quoted"', billable: true }));
  const csv = toCsv(store.exportSnapshot());
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('"\'@danger,""quoted"""'));
  assert.ok(csv.includes('"\'=SUM(1,2)"'));
  assert.ok(csv.includes('"60.00"'));
  assert.ok(csv.includes('"1800"'));
});

test('settings and text validation rejects invalid schedule and control characters', () => {
  const { store } = fixture();
  workspace(store);
  assert.throws(() => command(store, 'settings.update', { scheduleStart: '25:00' }), /HH:mm/);
  assert.throws(() => command(store, 'settings.update', { workDays: [0.5] }), /integer/);
  assert.throws(() => command(store, 'client.upsert', { name: 'Client\u0000name' }), /control characters/);
  assert.throws(() => command(store, 'entry.upsert', entry({ clientId: 'absent' })), /does not exist/);
});

test('midnight splitting preserves milliseconds and never emits zero duration fragments', () => {
  const start = new Date(2026, 9, 17, 23, 59, 59, 500).toISOString();
  const end = new Date(2026, 9, 18, 0, 0, 0, 123).toISOString();
  const parts = splitAtMidnight({ start, end });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(part => Date.parse(part.end) - Date.parse(part.start)), [500, 123]);
});
