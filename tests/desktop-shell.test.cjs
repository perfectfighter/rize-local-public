'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createStore, toCsv } = require('../desktop/store.cjs');
const desktopPath = path.resolve(__dirname, '..', 'desktop');
const distEntry = path.resolve(__dirname, '..', 'dist', 'index.html');

async function fixture(t, options = {}) {
  const base = path.resolve(__dirname, '.desktop-fixtures');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'shell-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = [], handlers = new Map(), windows = [], partitions = [], intervals = [], errors = [];
  const dialogs = { save: [], open: [], confirm: [], calls: [] };
  function sessionMock() {
    return { setPermissionRequestHandler(handler) { this.permissionRequest = handler; }, setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
      webRequest: { onBeforeRequest(_filter, handler) { this.beforeRequest = handler; } },
      on(event, handler) { this[event] = handler; } };
  }
  const defaultSession = sessionMock();
  class WebContents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: pathToFileURL(distEntry).href }; this.sent = []; }
    send(channel, value) { this.sent.push({ channel, value }); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    async printToPDF(config) { this.printConfig = config; if (options.pdfError) throw new Error('Native printing failed'); return Buffer.from('%PDF-1.7\nmock native PDF bytes\n'); }
  }
  class Window extends EventEmitter {
    constructor(config) { super(); this.config = config; this.webContents = new WebContents(); this.destroyed = false; this.hidden = false; this.maximized = false; windows.push(this); }
    removeMenu() {} show() { this.hidden = false; } focus() {} hide() { this.hidden = true; } isDestroyed() { return this.destroyed; }
    isMaximized() { return this.maximized; } maximize() { this.maximized = true; this.emit('maximize'); } unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    minimize() { this.minimized = true; } isMinimized() { return !!this.minimized; } restore() { this.minimized = false; }
    async loadFile(file) { this.loadedFile = file; }
    async loadURL(url) { this.loadedURL = url; }
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event); this.lastClose = event; if (!event.prevented) this.destroy(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class MockTray extends EventEmitter { setContextMenu(menu) { this.menu = menu; } setToolTip(value) { this.tooltip = value; } }
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: false, setName(value) { this.name = value; }, getName() { return this.name; }, getVersion: () => '2.0.0-test',
    getPath: () => directory, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit() { log.push('quit'); this.emit('before-quit'); } });
  const powerMonitor = new EventEmitter();
  const cloud = { autoSync: false, configured: true, authenticated: true, user: { id: 'user' }, teamId: 'team' };
  const cloudClient = { status: () => structuredClone(cloud), pauseSync() { log.push('pauseSync'); cloud.autoSync = false; if (options.pauseSyncError) throw new Error('Cloud config write failed'); }, async execute(command) {
    log.push({ cloudCommand: structuredClone(command) });
    if (options.cloudExecute) return options.cloudExecute(command);
    return { cloud: structuredClone(cloud), result: { action: command.action }, ...(command.action === 'sync' ? { workspace: store.getState() } : {}) };
  } };
  let updateState = 'downloaded';
  const updates = { status: () => ({ state: updateState }), check: async () => ({ state: 'available' }), download: async () => ({ state: 'downloaded' }),
    install() { log.push('install'); if (options.installError) throw new Error('Installer unavailable'); app.emit('before-quit'); windows[0].close(); return { state: 'installing' }; }, close() { log.push('updates.close'); } };
  let store;
  const electron = { app, BrowserWindow: Window, dialog: {
    async showSaveDialog(_window, config) { dialogs.calls.push({ kind: 'save', config }); return dialogs.save.shift() ?? { canceled: true }; },
    async showOpenDialog(_window, config) { dialogs.calls.push({ kind: 'open', config }); return dialogs.open.shift() ?? { canceled: true, filePaths: [] }; },
    async showMessageBox(_window, config) { dialogs.calls.push({ kind: 'confirm', config }); return dialogs.confirm.shift() ?? { response: 0 }; },
    showErrorBox(title, message) { errors.push({ title, message }); },
  }, ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
  Menu: { buildFromTemplate: template => template }, nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize() { return this; } }) },
  powerMonitor, safeStorage: {}, session: { defaultSession, fromPartition(name) { const value = sessionMock(); value.name = name; partitions.push(value); return value; } },
  shell: { async openExternal(url) { log.push({ openedExternal: url }); } }, Tray: MockTray };
  const source = fs.readFileSync(path.join(desktopPath, 'main.cjs'), 'utf8');
  const wrapped = vm.runInNewContext(`(function(require,module,exports,__dirname,__filename){${source}\n})`, {
    process: { platform: 'win32', arch: 'x64', env: {}, pid: process.pid }, Buffer, URL, JSON, structuredClone, console: { error: (...args) => errors.push(args) },
    setInterval(callback, ms) { const timer = { callback, ms, unref() { this.unreferenced = true; } }; intervals.push(timer); return timer; },
    clearInterval(timer) { timer.cleared = true; },
  }, { filename: 'desktop/main.cjs' });
  const customRequire = name => {
    if (name === 'electron') return electron;
    if (name === 'node:fs') return { ...fs, existsSync(file) { return file === distEntry || file === path.resolve(desktopPath, '..', 'native', 'app.png') || fs.existsSync(file); } };
    if (name === './store.cjs') return { toCsv, createStore(config) { store = createStore(config); const flush = store.flush; store.flush = () => { log.push('store.flush'); return flush(); }; return store; } };
    if (name === './tracking-engine.cjs') return { createTrackingEngine: () => ({ flush() { log.push('engine.flush'); return []; }, reset() { log.push('engine.reset'); }, consume: () => [] }) };
    if (name === './native-window.cjs') return { createSampler: () => ({ start() { log.push('sampler.start'); }, stop() { log.push('sampler.stop'); }, getStatus: () => ({ running: true }) }) };
    if (name === './cloud-client.cjs') return { createCloudClient: () => cloudClient };
    if (name === './updates.cjs') return { createUpdates: () => updates };
    return require(name.startsWith('./') ? path.join(desktopPath, name) : name);
  };
  const module = { exports: {} }; wrapped(customRequire, module, module.exports, desktopPath, path.join(desktopPath, 'main.cjs'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [], 'desktop startup should complete without error');
  const main = windows[0];
  const event = () => ({ sender: main.webContents, senderFrame: main.webContents.mainFrame });
  return { directory, log, handlers, windows, partitions, intervals, dialogs, defaultSession, app, powerMonitor, store, main, cloud, errors,
    setUpdateState(value) { updateState = value; },
    invoke(channel, value, sender = event()) { const handler = handlers.get(channel); assert.ok(handler, `registered ${channel}`); return Promise.resolve(handler(sender, value)).then(value => structuredClone(value)); }, event };
}
function populateInvoice(store) {
  const mutate = (type, payload = {}) => store.mutate({ type, payload });
  mutate('workspace.create'); mutate('business.profile.update', { name: 'Issuer <script>alert(1)</script>', paymentInstructions: '<img src=x>' });
  mutate('client.upsert', { id: 'c', name: 'Client <svg onload=alert(1)>' });
  mutate('entry.upsert', { id: 'e', clientId: 'c', start: '2026-10-17T09:00:00Z', end: '2026-10-17T10:00:00Z', description: 'Work </td><script>alert(2)</script>', billable: true });
  mutate('invoice.create', { clientId: 'c', startDate: '2026-10-01', endDate: '2026-10-31' });
  return store.getState().business.invoices[0];
}

test('all native IPC rejects foreign contents, subframes, external URLs and file traversal', async t => {
  const fx = await fixture(t);
  for (const [channel, handler] of fx.handlers) {
    for (const event of [{ sender: {}, senderFrame: fx.main.webContents.mainFrame }, { sender: fx.main.webContents, senderFrame: { url: fx.main.webContents.mainFrame.url } }]) await assert.rejects(handler(event, {}), /not from the app window/, channel);
  }
  const frame = fx.main.webContents.mainFrame;
  for (const url of ['https://rize.io', pathToFileURL(path.resolve(desktopPath, 'main.cjs')).href, 'file:///dist/../secret.html', 'data:text/html,evil']) { frame.url = url; await assert.rejects(fx.invoke('rize:get-state'), /not from the app window/); }
  frame.url = pathToFileURL(distEntry).href;
  assert.equal((await fx.invoke('rize:get-state')).schemaVersion, 1);
  assert.equal(fx.log.filter(item => item.cloudCommand).length, 0);
});

test('window/session sandbox blocks navigation, outbound renderer requests and permissions', async t => {
  const fx = await fixture(t); const prefs = fx.main.config.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true);
  assert.deepEqual(structuredClone(fx.main.webContents.openHandler({ url: 'https://example.com' })), { action: 'deny' });
  for (const name of ['will-navigate', 'will-attach-webview']) { let prevented = false; fx.main.webContents.emit(name, { preventDefault() { prevented = true; } }); assert.equal(prevented, true); }
  const request = (url, resourceType) => { let result; fx.defaultSession.webRequest.beforeRequest({ url, resourceType }, value => { result = value; }); return result.cancel; };
  assert.equal(request(pathToFileURL(distEntry).href), false); assert.equal(request('data:image/png;base64,AA=='), false); assert.equal(request('blob:file:///some-local-object-id', 'media'), false); assert.equal(request('blob:file:///some-local-object-id', 'script'), true);
  for (const url of ['https://example.com', 'http://127.0.0.1:4791', 'data:text/html,evil', pathToFileURL(path.resolve(desktopPath, 'main.cjs')).href]) assert.equal(request(url), true);
  let permission; fx.defaultSession.permissionRequest({}, 'microphone', value => { permission = value; }); assert.equal(permission, false); assert.equal(fx.defaultSession.permissionCheck(), false);
});

test('preload exposes only named calls and event values, with removable subscriptions', async () => {
  let api; const invocations = [], listeners = new Map();
  const electron = { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'rize'); api = value; } }, ipcRenderer: {
    async invoke(channel, value) { invocations.push({ channel, value }); return { ok: true }; },
    on(channel, listener) { listeners.set(channel, listener); }, removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(desktopPath, 'preload.cjs'), 'utf8'), { require(name) { assert.equal(name, 'electron'); return electron; } });
  assert.ok(Object.isFrozen(api)); assert.equal(api.invoke, undefined); assert.equal(api.require, undefined); assert.equal(api.token, undefined);
  await api.cloud('ai.chat', { message: 'Hello', consent: true }); await api.invoicePdf({ id: 'inv' }); await api.updates('check');
  assert.deepEqual(structuredClone(invocations), [{ channel: 'rize:cloud', value: { action: 'ai.chat', payload: { message: 'Hello', consent: true } } }, { channel: 'rize:invoice-pdf', value: { id: 'inv' } }, { channel: 'rize:updates', value: 'check' }]);
  const seen = []; const unsubscribe = api.onState(value => seen.push(value)); listeners.get('rize:state')({ secretEvent: true }, { schemaVersion: 1 }); assert.deepEqual(seen, [{ schemaVersion: 1 }]); unsubscribe(); assert.equal(listeners.has('rize:state'), false); assert.throws(() => api.onStatus('invalid'), /callback/);
});

test('workspace reset pauses background sync and creates a fresh identity', async t => {
  const fx = await fixture(t); await fx.invoke('rize:mutate', { type: 'workspace.create' }); const first = fx.store.getState().workspaceId;
  fx.cloud.autoSync = true; await fx.invoke('rize:mutate', { type: 'workspace.create', payload: { displayName: 'New branch' } }); assert.notEqual(fx.store.getState().workspaceId, first); assert.equal(fx.cloud.autoSync, false); assert.ok(fx.log.includes('pauseSync'));
  const before = fx.store.getState(); await assert.rejects(fx.invoke('rize:mutate', { type: 'entry.upsert', payload: { description: 'x'.repeat(210000) } }), /Invalid workspace command/); assert.deepEqual(fx.store.getState(), before);
});

test('confirmed backup import disables tracking, pauses sync and branches workspace identity', async t => {
  const fx = await fixture(t); await fx.invoke('rize:mutate', { type: 'workspace.create' }); const backup = fx.store.exportSnapshot(); backup.settings.trackingEnabled = true; const file = path.join(fx.directory, 'backup.json'); fs.writeFileSync(file, JSON.stringify(backup)); fx.dialogs.open.push({ canceled: false, filePaths: [file] }); fx.dialogs.confirm.push({ response: 1 }); fx.cloud.autoSync = true;
  const result = await fx.invoke('rize:import'); assert.equal(result.canceled, false); assert.equal(result.state.settings.trackingEnabled, false); assert.notEqual(result.state.workspaceId, backup.workspaceId); assert.equal(fx.cloud.autoSync, false);
  const before = fx.store.getState(); fx.dialogs.open.push({ canceled: false, filePaths: [file] }); fx.dialogs.confirm.push({ response: 0 }); fx.cloud.autoSync = true; assert.deepEqual(await fx.invoke('rize:import'), { canceled: true }); assert.deepEqual(fx.store.getState(), before); assert.equal(fx.cloud.autoSync, true);
});

test('cloud bridge forwards narrow command envelopes and publishes merged workspace', async t => {
  const fx = await fixture(t); const result = await fx.invoke('rize:cloud', { action: 'sync', payload: { consent: true } }); assert.equal(result.result.action, 'sync'); assert.equal(result.cloud.authenticated, true); assert.equal(result.workspace.schemaVersion, 1); assert.equal(result.token, undefined);
  assert.deepEqual(fx.log.find(item => item.cloudCommand)?.cloudCommand, { action: 'sync', payload: { consent: true } }); assert.ok(fx.main.webContents.sent.some(item => item.channel === 'rize:state'));
  await assert.rejects(fx.invoke('rize:cloud', { action: 'ai.chat', payload: { message: 'x'.repeat(4 * 1024 * 1024) } }), /Invalid cloud command/);
});

test('OAuth bridge opens only exact HTTPS Google/Microsoft authorization endpoints', async t => {
  let authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque';
  const fx = await fixture(t, { cloudExecute: async () => ({ cloud: {}, result: { authorizationUrl } }) });
  await fx.invoke('rize:cloud', { action: 'integrations.oauth.start', payload: { provider: 'google' } }); assert.equal(fx.log.filter(item => item.openedExternal).length, 1);
  authorizationUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=opaque'; await fx.invoke('rize:cloud', { action: 'integrations.oauth.start', payload: { provider: 'microsoft' } }); assert.equal(fx.log.filter(item => item.openedExternal).length, 2);
  for (const url of ['file:///secret', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth', 'https://accounts.google.com:444/o/oauth2/v2/auth', 'https://evil@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com/redirect']) { authorizationUrl = url; await assert.rejects(fx.invoke('rize:cloud', { action: 'integrations.oauth.start', payload: { provider: 'google' } }), /unsupported authorization/); }
  assert.equal(fx.log.filter(item => item.openedExternal).length, 2);
});

test('invoice PDF cancellation never creates a print window or writes a file', async t => {
  const fx = await fixture(t); const inv = populateInvoice(fx.store); const result = await fx.invoke('rize:invoice-pdf', { id: inv.id }); assert.deepEqual(result, { canceled: true }); assert.equal(fx.windows.length, 1); assert.equal(fx.partitions.length, 0);
  await assert.rejects(fx.invoke('rize:invoice-pdf', { id: 'missing' }), /no longer exists/);
});

test('invoice export passes escaped trusted HTML to isolated printing and writes returned PDF bytes', async t => {
  const fx = await fixture(t); const inv = populateInvoice(fx.store); const file = path.join(fx.directory, 'invoice.pdf'); fx.dialogs.save.push({ canceled: false, filePath: file }); const result = await fx.invoke('rize:invoice-pdf', { id: inv.id }); assert.equal(result.canceled, false); assert.equal(result.path, file); assert.ok(fs.readFileSync(file).subarray(0, 5).equals(Buffer.from('%PDF-')));
  const printer = fx.windows[1]; assert.equal(printer.config.show, false); assert.equal(printer.config.webPreferences.javascript, false); assert.equal(printer.config.webPreferences.nodeIntegration, false); assert.equal(printer.config.webPreferences.sandbox, true); assert.equal(printer.destroyed, true); assert.equal(printer.webContents.printConfig.pageSize, 'A4');
  const html = decodeURIComponent(printer.loadedURL.split(',').slice(1).join(',')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<svg')); assert.ok(!html.includes('<img'));
  const isolated = fx.partitions[0]; for (const url of ['https://example.com/tracker', 'file:///secret', 'data:image/png;base64,AA==']) { let decision; isolated.webRequest.beforeRequest({ url }, value => { decision = value; }); assert.equal(decision.cancel, true); }
  let allowed; isolated.webRequest.beforeRequest({ url: printer.loadedURL }, value => { allowed = value; }); assert.equal(allowed.cancel, false);
});

test('failed native PDF printing destroys the isolated window and preserves disk', async t => {
  const fx = await fixture(t, { pdfError: true }); const inv = populateInvoice(fx.store); const file = path.join(fx.directory, 'failed.pdf'); fx.dialogs.save.push({ canceled: false, filePath: file }); await assert.rejects(fx.invoke('rize:invoice-pdf', { id: inv.id }), /Native printing failed/); assert.equal(fx.windows[1].destroyed, true); assert.equal(fs.existsSync(file), false);
});

test('update install requires downloaded state, flushes first, cancels sync and permits real quit', async t => {
  const fx = await fixture(t); fx.setUpdateState('available'); await assert.rejects(fx.invoke('rize:updates', 'install'), /Download and verify/); fx.main.close(); assert.equal(fx.main.lastClose.prevented, true);
  fx.setUpdateState('downloaded'); fx.log.length = 0; const result = await fx.invoke('rize:updates', 'install'); assert.equal(result.state, 'installing'); assert.ok(fx.log.indexOf('store.flush') < fx.log.indexOf('install')); assert.ok(fx.log.includes('updates.close')); assert.ok(fx.log.includes('pauseSync')); assert.equal(fx.main.lastClose.prevented, false); assert.equal(fx.main.destroyed, true); assert.ok(fx.intervals.every(timer => timer.cleared));
});

test('failed update installation restores normal close-to-tray behavior', async t => {
  const fx = await fixture(t, { installError: true }); await assert.rejects(fx.invoke('rize:updates', 'install'), /Installer unavailable/); fx.main.close(); assert.equal(fx.main.lastClose.prevented, true); assert.equal(fx.main.destroyed, false);
});

test('Windows lock/sleep lifecycle stops foreground sampling and only resumes opted-in tracking', async t => {
  const fx = await fixture(t); await fx.invoke('rize:mutate', { type: 'workspace.create' }); assert.equal(fx.log.includes('sampler.start'), false); await fx.invoke('rize:mutate', { type: 'settings.update', payload: { trackingEnabled: true } }); assert.ok(fx.log.includes('sampler.start'));
  fx.powerMonitor.emit('lock-screen'); assert.ok(fx.log.includes('sampler.stop')); const before = fx.log.filter(item => item === 'sampler.start').length; fx.powerMonitor.emit('unlock-screen'); assert.equal(fx.log.filter(item => item === 'sampler.start').length, before + 1); fx.powerMonitor.emit('suspend'); await fx.invoke('rize:mutate', { type: 'settings.update', payload: { trackingEnabled: false } }); const starts = fx.log.filter(item => item === 'sampler.start').length; fx.powerMonitor.emit('resume'); assert.equal(fx.log.filter(item => item === 'sampler.start').length, starts);
});

test('cloud credential-file failure during quit cannot prevent local workspace flush', async t => {
  const fx = await fixture(t, { pauseSyncError: true }); fx.log.length = 0; fx.app.emit('before-quit'); assert.ok(fx.log.includes('pauseSync')); assert.ok(fx.log.includes('engine.flush')); assert.ok(fx.log.includes('store.flush')); assert.ok(fs.existsSync(path.join(fx.directory, 'workspace.json'))); assert.ok(fx.errors.some(error => Array.isArray(error) && error[0].includes('synchronization could not be paused'))); assert.ok(fx.intervals.every(timer => timer.cleared));
});
