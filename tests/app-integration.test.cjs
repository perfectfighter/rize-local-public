'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { buildSync } = require('esbuild');
const { window } = parseHTML('<!doctype html><html><body></body></html>');
window.document.oninput = null;
// Browsers default a missing input type to text; Linkedom returns null. React's
// input-event feature detection needs the actual HTML behavior for plain inputs.
Object.defineProperty(window.HTMLInputElement.prototype, 'type', { configurable: true, get() { return this.getAttribute('type') || 'text'; }, set(value) { this.setAttribute('type', value); } });
for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'Node']) {
  if (window[name]) Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Linkedom App integration' }, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.confirm = () => true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { createStore } = require('../desktop/store.cjs');
const { financialSummary } = require('../desktop/business.cjs');
const source = buildSync({ entryPoints: [path.join(__dirname, '../src/App.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom', 'react-feather'], loader: { '.css': 'empty' } }).outputFiles[0].text;
const appModule = { exports: {} };
new Function('require', 'module', 'exports', source)(require, appModule, appModule.exports);
const App = appModule.exports.default;

const copy = value => structuredClone(value);
function button(container, text) {
  const found = [...container.querySelectorAll('button')].find(element => element.textContent.trim() === text);
  assert.ok(found, `Expected button: ${text}`); return found;
}
function navigation(container, text) { return button(container.querySelector('nav[aria-label="Main navigation"]'), text); }
function control(container, label, selector = 'input') {
  const found = [...container.querySelectorAll('label')].find(element => (element.querySelector('span')?.textContent || element.textContent).trim().startsWith(label));
  assert.ok(found, `Expected labeled control: ${label}`); const input = found.querySelector(selector); assert.ok(input); return input;
}
async function click(element) { assert.ok(!element.disabled, 'Action must be enabled'); await act(async () => element.dispatchEvent(new window.Event('click', { bubbles: true }))); }
async function submit(form) { assert.ok(form); await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); }
async function input(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  assert.equal(typeof descriptor?.set, 'function'); descriptor.set.call(element, value);
  await act(async () => element.dispatchEvent(new window.Event('input', { bubbles: true })));
}
async function checkbox(element, checked) { element.checked = checked; await click(element); }
async function mount(options = {}) {
  const store = createStore(); store.mutate({ type: 'workspace.create', payload: { displayName: 'Integration tester' } });
  const stateSubscribers = new Set(), statusSubscribers = new Set();
  const calls = { cloud: [], updates: [], mutations: [], reports: [] };
  let cloud = { configured: false, authenticated: false, serverUrl: 'http://127.0.0.1:4791', teams: [], conflicts: [], ...options.cloud };
  let status = { platform: 'win32', appVersion: '1.1.0', maximized: false, tracking: { enabled: false, available: true, state: 'off', message: 'Automatic tracking is off.' }, cloud,
    updates: { supported: true, state: 'idle', currentVersion: '1.1.0', availableVersion: null, message: 'Choose Check for updates.' }, ...options.status };
  const publishStatus = patch => { status = { ...status, ...patch }; for (const callback of statusSubscribers) callback(copy(status)); };
  const bridge = {
    getState: async () => store.getState(), getStatus: async () => copy(status),
    onState(callback) { stateSubscribers.add(callback); return () => stateSubscribers.delete(callback); },
    onStatus(callback) { statusSubscribers.add(callback); return () => statusSubscribers.delete(callback); },
    async mutate(command) { calls.mutations.push(copy(command)); const next = store.mutate(command); for (const callback of stateSubscribers) callback(next); return next; },
    windowAction: async () => {}, exportData: async () => ({ canceled: true }), importData: async () => ({ canceled: true }), invoicePdf: async () => ({ canceled: true }),
    async businessReport(query) { calls.reports.push(query); return financialSummary(store.getState(), query); },
    async cloud(action, payload) {
      calls.cloud.push({ action, payload: copy(payload) });
      if (options.onCloud) {
        const response = await options.onCloud(action, payload, { store, cloud: copy(cloud), setCloud(next) { cloud = next; } });
        if (response) return response;
      }
      let result;
      if (action === 'configure') { cloud = { ...cloud, configured: true, serverUrl: payload.serverUrl }; result = cloud; }
      else if (action === 'login') { cloud = { ...cloud, authenticated: true, user: { id: 'u1', name: 'Cloud tester', email: payload.email }, teamId: 'team1', teams: [{ id: 'team1', name: 'Actual selected team', role: 'owner' }] }; result = { user: cloud.user }; }
      else if (action === 'team.members') result = { members: [{ userId: 'u1', user: cloud.user, role: 'owner', finance: true, resourcing: true }] };
      else if (action === 'services.status') result = { ai: { configured: false }, secretStorageConfigured: false };
      else if (/^ai\.(skills|routines|reports)\.list$/.test(action)) result = [];
      else if (action === 'integrations.list') result = [];
      else if (action === 'status') result = cloud;
      else throw new Error('Sign in, select a team, and configure the service before this action.');
      status = { ...status, cloud };
      return { cloud: copy(cloud), result };
    },
    async updates(action) {
      calls.updates.push(action);
      if (options.onUpdates) return options.onUpdates(action, { publishStatus, status: copy(status) });
      const updates = action === 'check' ? { ...status.updates, state: 'available', availableVersion: '1.2.0', message: 'Version 1.2.0 is available.' }
        : action === 'download' ? { ...status.updates, state: 'downloaded', message: 'Verified update ready.' }
        : { ...status.updates, state: 'installing', message: 'Restarting to install.' };
      publishStatus({ updates }); return copy(updates);
    },
  };
  globalThis.rize = bridge; window.rize = bridge;
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  await act(async () => { root.render(React.createElement(App)); });
  const media=container.querySelector('audio');if(media){media.pause=()=>{media.paused=true;};media.play=async()=>{media.paused=false;};}
  return { container, bridge, store, calls, publishStatus, stateSubscribers, statusSubscribers, cleanup: async () => { await act(async () => root.unmount()); container.remove(); delete globalThis.rize; delete window.rize; assert.equal(stateSubscribers.size, 0); assert.equal(statusSubscribers.size, 0); } };
}

test('every App page opens against the real workspace and cloud gates make no background requests', async () => {
  const app = await mount();
  const pages = [['Home', /^Good /], ['Calendar', 'Calendar'], ['Timer', 'Timer'], ['Activity', 'Activity'], ['Reports', 'Reports'], ['Tasks', 'Tasks'], ['Projects', 'Projects'], ['Clients', 'Clients'], ['Agent', 'AI workspace'], ['Timesheets', 'Timesheets'], ['Invoices', 'Invoices'], ['Profitability', 'Profitability'], ['Resourcing', 'Resourcing'], ['Team', 'Cloud & team'], ['Integrations', 'Integrations'], ['Music', 'Focus audio'], ['Updates', 'Updates'], ['Settings', 'Settings']];
  try {
    for (const [page, expected] of pages) {
      await click(navigation(app.container, page));
      const visible = [...app.container.querySelectorAll('.page-content h1')].filter(element => !element.closest('[hidden]'));
      assert.equal(visible.length, 1, `One active page heading on ${page}`);
      if (expected instanceof RegExp) assert.match(visible[0].textContent, expected); else assert.equal(visible[0].textContent, expected);
      assert.equal(app.container.querySelector('.load-screen[role="alert"]'), null);
      if (page === 'Agent' || page === 'Integrations') assert.match(app.container.querySelector('.cp-empty').textContent, /Connect your workspace first/);
    }
    assert.deepEqual(app.calls.cloud, [], 'Opening gated pages must not send account/provider requests');
    await click(navigation(app.container, 'Timesheets')); await click(button(app.container, 'Team timesheets')); await click(button(app.container, 'Load team timesheets'));
    assert.match(app.container.querySelector('[role="alert"]').textContent, /Sign in and select a team/); assert.deepEqual(app.calls.cloud, []);
    await click(navigation(app.container, 'Clients')); await click(button(app.container, 'New client'));
    await input(control(app.container, 'Name'), 'Saved through App bridge'); await input(control(app.container, 'Hourly rate'), '125'); await submit(app.container.querySelector('.wp-editor'));
    assert.equal(app.store.getState().clients.length,1,JSON.stringify({mutations:app.calls.mutations,alert:app.container.querySelector('[role="alert"]')?.textContent}));
    assert.equal(app.store.getState().clients[0].name, 'Saved through App bridge'); assert.equal(app.store.getState().clients[0].hourlyRate, 125);
    await click(navigation(app.container, 'Home')); await click(navigation(app.container, 'Clients'));
    assert.match(app.container.querySelector('.wp-list').textContent, /Saved through App bridge/);
  } finally { await app.cleanup(); }
});

test('Cloud form envelopes update authentication and merged workspace without exposing a session token', async () => {
  const app = await mount({ onCloud: async (action, payload, ctx) => {
    if (action !== 'sync') return;
    assert.equal(payload.consent, true);
    const workspace = ctx.store.mutate({ type: 'client.upsert', payload: { id: 'remote-client', name: 'Shared studio', hourlyRate: 90 } });
    const cloud = { ...ctx.cloud, lastSyncAt: '2026-10-17T16:30:00Z', conflicts: [] }; ctx.setCloud(cloud);
    return { cloud, result: { conflicts: [], cursor: 7 }, workspace };
  } });
  try {
    await click(navigation(app.container, 'Team'));
    await input(control(app.container, 'Server URL'), 'http://127.0.0.1:4791'); await submit(app.container.querySelector('.cp-inline-form'));
    assert.match(app.container.querySelector('.cp-badge').textContent, /Address configured/);
    await input(control(app.container, 'Email'), 'tester@example.test'); await input(control(app.container, 'Password'), 'Example password 42!');
    await submit(app.container.querySelector('.cp-auth form'));
    assert.ok(button(app.container, 'Sign out')); assert.match(app.container.querySelector('.cp-account').textContent, /tester@example.test/);
    assert.equal(app.container.querySelector('input[type="password"]'), null);
    const login = app.calls.cloud.find(item => item.action === 'login'); assert.equal(login.payload.email, 'tester@example.test'); assert.equal(login.payload.password, 'Example password 42!');
    const sync = button(app.container, 'Sync approved workspace'); assert.equal(sync.disabled, true);
    const consent = [...app.container.querySelectorAll('.cp-consent input')][0]; await checkbox(consent, true);
    await click(button(app.container, 'Sync approved workspace'));
    assert.match(app.container.querySelector('[role="status"]').textContent, /synchronized/);
    await click(navigation(app.container, 'Clients')); assert.match(app.container.querySelector('.wp-list').textContent, /Shared studio/);
    await click(navigation(app.container, 'Agent')); assert.match(app.container.querySelector('.cp-service-status').textContent, /Not configured on this server/);
    assert.equal(button(app.container, 'Send message').disabled, true);
    assert.ok(!Object.keys(app.bridge).some(key => /token/i.test(key)), 'Narrow bridge provides actions, never session tokens');
  } finally { await app.cleanup(); }
});

test('Music keeps its active audio engine across navigation and stops it on explicit pause and app cleanup', async () => {
  const instances = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.sampleRate = 100; this.currentTime = 0; this.destination = {}; this.sources = []; instances.push(this); }
    async resume() {} async close() { this.state = 'closed'; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }
    createBuffer(_channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; this.sources.push(source); return source; }
  }
  const oldContext = globalThis.AudioContext; globalThis.AudioContext = AudioContext;
  const app = await mount();
  try {
    await click(navigation(app.container, 'Music')); const music = app.container.querySelector('.music-page');
    await click(music.querySelector('[aria-label="Play audio"]')); assert.equal(instances.length, 1); assert.equal(instances[0].sources[0].started, true);
    await click(navigation(app.container, 'Timer')); assert.ok(music.closest('[hidden]')); assert.equal(instances[0].state, 'running'); assert.equal(instances[0].sources[0].stopped, undefined);
    await click(navigation(app.container, 'Music')); assert.equal(app.container.querySelector('.music-page'), music); assert.equal(music.closest('[hidden]'), null);
    await click(music.querySelector('[aria-label="Pause audio"]')); assert.equal(instances[0].state, 'closed');
    await click(music.querySelector('[aria-label="Play audio"]')); assert.equal(instances.length, 2);
  } finally { await app.cleanup(); if (oldContext === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = oldContext; }
  assert.equal(instances[1].state, 'closed'); assert.equal(instances[1].sources[0].stopped, true);
});

test('Updates uses native status events and passes only explicit user actions to the narrow bridge', async () => {
  const app = await mount();
  try {
    await click(navigation(app.container, 'Updates')); assert.equal(app.calls.updates.length, 0);
    assert.equal([...app.container.querySelectorAll('button')].some(element => element.textContent === 'Restart and install'), false);
    await click(button(app.container, 'Check for updates')); assert.deepEqual(app.calls.updates, ['check']);
    await click(button(app.container, 'Download 1.2.0')); assert.deepEqual(app.calls.updates, ['check', 'download']);
    await click(button(app.container, 'Restart and install')); assert.deepEqual(app.calls.updates, ['check', 'download', 'install']);
    assert.match(app.container.querySelector('.page-content').textContent, /Restarting to install/);
    await act(async () => app.publishStatus({ updates: { supported: false, state: 'unsupported', message: 'Install a signed NSIS release.' } }));
    assert.equal(button(app.container, 'Check for updates').disabled, true);
    assert.equal([...app.container.querySelectorAll('button')].some(element => element.textContent === 'Restart and install'), false);
  } finally { await app.cleanup(); }
});
