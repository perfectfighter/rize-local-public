'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, session, shell, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createStore, toCsv } = require('./store.cjs');
const { createTrackingEngine } = require('./tracking-engine.cjs');
const { createSampler } = require('./native-window.cjs');
const { randomUUID } = require('node:crypto');
const { createCloudClient } = require('./cloud-client.cjs');
const { financialSummary, invoiceHtml } = require('./business.cjs');
const { createUpdates } = require('./updates.cjs');

app.setName('Rize Local');
let mainWindow, tray, store, sampler, checkpointInterval, cloudClient, updates, cloudInterval;
let quitting = false;
let suspended = false;
let locked = false;
let storageFailed = false;
const engine = createTrackingEngine();
const distPath = path.resolve(__dirname, '..', 'dist');
const entryPath = path.join(distPath, 'index.html');
const iconPath = path.resolve(__dirname, '..', 'native', 'app.png');
const status = {
  platform: process.platform,
  appVersion: app.getVersion(),
  tracking: {
    enabled: false,
    available: process.platform === 'win32' && process.arch === 'x64',
    state: 'off',
    message: 'Automatic tracking is off.',
    lastSampleAt: null,
  },
  maximized: false,
};

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}
function publishState() { if (store) send('rize:state', store.getState()); }
function publishStatus() {
  status.maximized = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized());
  send('rize:status', status);
  if (tray) tray.setToolTip(`Rize Local — ${status.tracking.state}`);
}
function trackingStatus(patch) {
  Object.assign(status.tracking, patch);
  publishStatus();
}
function persistSamples(entries) {
  if (!entries.length) return;
  store.upsertActivity(entries);
  publishState();
}
function flushActivity() {
  if (!store) return;
  persistSamples(engine.flush(new Date().toISOString(), store.getState()));
}
function stopNative(message = 'Automatic tracking is off.', state = 'off') {
  if (sampler) sampler.stop();
  sampler = null;
  flushActivity();
  engine.reset();
  trackingStatus({ state, message });
}
function failTracking(error) {
  console.error('Automatic tracking:', error instanceof Error ? error.message : String(error));
  if (sampler) sampler.stop();
  sampler = null;
  engine.reset();
  storageFailed = true;
  trackingStatus({ state: 'error', message: 'Activity could not be saved. Turn tracking off and on to retry.' });
}
function reconcileTracking() {
  const current = store.getState();
  const enabled = !!(current.onboarded && !current.demo && current.settings.trackingEnabled);
  status.tracking.enabled = enabled;
  if (!enabled) {
    storageFailed = false;
    stopNative(current.demo ? 'Sample workspace does not collect activity.' : 'Automatic tracking is off.');
    return;
  }
  if (suspended || locked) {
    stopNative(suspended ? 'Tracking pauses while the computer sleeps.' : 'Tracking pauses while Windows is locked.', 'paused');
    return;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    stopNative('Automatic foreground tracking is available in the Windows x64 app.', 'unavailable');
    trackingStatus({ available: false });
    return;
  }
  if (storageFailed || sampler) { publishStatus(); return; }
  trackingStatus({ state: 'starting', message: 'Starting Windows foreground tracking.' });
  const next = createSampler({
    powerMonitor,
    onSample(sample) {
      try {
        persistSamples(engine.consume(sample, store.getState()));
        trackingStatus({
          available: !!sample.available,
          state: sample.available ? 'tracking' : 'unavailable',
          message: sample.available
            ? 'Foreground collection is enabled. Idle, schedule, and exclusion rules apply.'
            : 'Windows foreground information is temporarily unavailable; retrying.',
          lastSampleAt: sample.timestamp,
        });
      } catch (error) { failTracking(error); }
    },
    onError() {
      trackingStatus({ available: false, state: 'unavailable', message: 'Windows foreground information is temporarily unavailable; retrying.' });
    },
  });
  sampler = next;
  try {
    // A first sample can be temporarily unavailable while the sampler keeps
    // retrying. Only a sampler that did not start should be discarded.
    next.start();
    if (storageFailed) next.stop();
    else if (!next.getStatus().running) {
      next.stop();
      if (sampler === next) sampler = null;
      trackingStatus({ available: false, state: 'unavailable', message: 'Windows foreground tracking could not start.' });
    }
  } catch (error) { failTracking(error); }
}

function allowedFile(url) {
  try {
    const filename = fileURLToPath(url);
    const relative = path.relative(distPath, filename);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}
function secureSession() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    // Renderer network access stays blocked. Authorized service requests run in
    // the main process through the narrow cloud IPC command allowlist.
    const allowed = allowedFile(details.url) || details.url.startsWith('data:image/') || (details.resourceType === 'media' && details.url.startsWith('blob:'));
    callback({ cancel: !allowed });
  });
  session.defaultSession.on('will-download', event => event.preventDefault());
}
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return; }
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 940, minHeight: 650,
    backgroundColor: '#121117', frame: false, show: false, icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
      spellcheck: false, devTools: !app.isPackaged,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { mainWindow.show(); publishStatus(); });
  mainWindow.on('maximize', publishStatus);
  mainWindow.on('unmaximize', publishStatus);
  mainWindow.on('close', event => {
    if (tray && !quitting) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(entryPath).catch(error => {
    dialog.showErrorBox('Rize Local could not open', error.message);
    quitting = true;
    app.quit();
  });
}
function createTray() {
  if (!fs.existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return;
  tray = new Tray(icon.resize({ width: 32, height: 32 }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Rize Local', click: createWindow },
    { type: 'separator' },
    { label: 'Quit Rize Local', click() { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', createWindow);
  publishStatus();
}
function assertSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame || !allowedFile(event.senderFrame.url)) {
    throw new Error('This request is not from the app window.');
  }
}
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, value) => { assertSender(event); return handler(value); });
}
function registerIpc() {
  handle('rize:get-state', () => store.getState());
  handle('rize:get-status', () => { publishStatus(); return structuredClone(status); });
  handle('rize:mutate', command => {
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        typeof command.type !== 'string' || JSON.stringify(command).length > 200_000) {
      throw new Error('Invalid workspace command.');
    }
    flushActivity();
    engine.reset();
    if (['workspace.create', 'workspace.demo'].includes(command.type)) cloudClient.pauseSync();
    const result = store.mutate(command);
    publishState();
    reconcileTracking();
    return result;
  });
  handle('rize:cloud', async command => {
    if (!command || typeof command !== 'object' || JSON.stringify(command).length > 4 * 1024 * 1024) throw new Error('Invalid cloud command.');
    if (command.action === 'sync') { flushActivity(); engine.reset(); }
    const result = await cloudClient.execute(command);
    if (command.action === 'integrations.oauth.start') {
      const target = new URL(result.result?.authorizationUrl || '');
      const google = target.hostname === 'accounts.google.com' && target.pathname === '/o/oauth2/v2/auth';
      const microsoft = target.hostname === 'login.microsoftonline.com' && /^\/[a-zA-Z0-9.-]+\/oauth2\/v2\.0\/authorize$/.test(target.pathname);
      if (target.protocol !== 'https:' || target.port || target.username || target.password || (!google && !microsoft)) throw new Error('The server returned an unsupported authorization address.');
      await shell.openExternal(target.href);
    }
    if (result.workspace) publishState();
    return result;
  });
  handle('rize:business-report', query => financialSummary(store.getState(), query || {}));
  handle('rize:invoice-pdf', async payload => {
    const invoice = store.getState().business.invoices.find(item => item.id === payload?.id);
    if (!invoice) throw new Error('This invoice no longer exists.');
    const selected = await dialog.showSaveDialog(mainWindow, { title: 'Export invoice PDF', defaultPath: `${String(invoice.number || 'invoice').replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    const isolated = session.fromPartition(`invoice-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: !details.url.startsWith('data:text/html') }));
    const printWindow = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
    try {
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(invoiceHtml(invoice))}`);
      const bytes = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      fs.writeFileSync(selected.filePath, bytes, { mode: 0o600 });
      return { canceled: false, path: selected.filePath };
    } finally { printWindow.destroy(); }
  });
  handle('rize:updates', async action => {
    if (!['status', 'check', 'download', 'install'].includes(action)) throw new Error('Invalid update action.');
    if (action === 'install') {
      if (updates.status().state !== 'downloaded') throw new Error('Download and verify an update before installing.');
      flushActivity(); store.flush(); quitting = true;
      try { return updates.install(); } catch (error) { quitting = false; throw error; }
    }
    return updates[action]();
  });
  handle('rize:window', action => {
    if (!['minimize', 'maximize', 'close'].includes(action)) throw new Error('Invalid window action.');
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    if (action === 'close') mainWindow.close();
    publishStatus();
    return true;
  });
  handle('rize:export', async format => {
    if (!['json', 'csv'].includes(format)) throw new Error('Choose JSON or CSV export.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: format === 'json' ? 'Save workspace backup' : 'Export all workspace entries',
      defaultPath: `rize-local-${new Date().toISOString().slice(0, 10)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    flushActivity();
    const snapshot = store.exportSnapshot();
    fs.writeFileSync(result.filePath, format === 'json' ? `${JSON.stringify(snapshot, null, 2)}\n` : toCsv(snapshot), { encoding: 'utf8', mode: 0o600 });
    return { canceled: false, path: result.filePath };
  });
  handle('rize:import', async () => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Rize Local workspace backup', properties: ['openFile'],
      filters: [{ name: 'Workspace JSON', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const file = selected.filePaths[0];
    if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('This workspace backup exceeds the 20 MB import limit.');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'Replace this workspace?',
      message: 'Importing replaces the current local workspace.',
      detail: 'Export a JSON backup first if you want to keep the current data. Automatic tracking in the imported workspace starts disabled.',
      buttons: ['Cancel', 'Replace workspace'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (answer.response !== 1) return { canceled: true };
    cloudClient.pauseSync();
    stopNative();
    // Backups never opt someone into tracking merely by being imported.
    if (value && value.settings) value.settings.trackingEnabled = false;
    // Import is a separate local branch; it cannot infer remote deletions from
    // records absent in an older backup.
    if (value && typeof value === 'object') value.workspaceId = randomUUID();
    const imported = store.importData(value);
    storageFailed = false;
    publishState();
    reconcileTracking();
    return { canceled: false, state: imported };
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { createWindow(); if (mainWindow.isMinimized()) mainWindow.restore(); });
  app.whenReady().then(() => {
    try {
      if (!fs.existsSync(entryPath)) throw new Error('Build the frontend first with npm run build.');
      store = createStore({ file: path.join(app.getPath('userData'), 'workspace.json') });
      cloudClient = createCloudClient({ file: path.join(app.getPath('userData'), 'cloud-session.json'), store, secureStorage: safeStorage, onChange(cloud) { status.cloud = cloud; publishStatus(); } });
      status.cloud = cloudClient.status();
      updates = createUpdates({ app, send(value) { status.updates = value; publishStatus(); } });
      status.updates = updates.status();
      secureSession();
      registerIpc();
      createWindow();
      createTray();
      powerMonitor.on('suspend', () => { suspended = true; try { reconcileTracking(); } catch (error) { failTracking(error); } });
      powerMonitor.on('resume', () => { suspended = false; try { reconcileTracking(); } catch (error) { failTracking(error); } });
      powerMonitor.on('lock-screen', () => { locked = true; try { reconcileTracking(); } catch (error) { failTracking(error); } });
      powerMonitor.on('unlock-screen', () => { locked = false; try { reconcileTracking(); } catch (error) { failTracking(error); } });
      checkpointInterval = setInterval(() => {
        if (store.getState().timer?.status !== 'running') return;
        try { store.flush(); }
        catch (error) { failTracking(error); }
      }, 15_000);
      checkpointInterval.unref();
      cloudInterval = setInterval(async () => {
        if (!cloudClient.status().autoSync) return;
        try { flushActivity(); engine.reset(); await cloudClient.execute({ action: 'sync', payload: { consent: true } }); publishState(); }
        catch (error) { status.cloud = { ...cloudClient.status(), message: error.message }; publishStatus(); }
      }, 60_000);
      cloudInterval.unref();
      reconcileTracking();
    } catch (error) {
      dialog.showErrorBox('Rize Local could not start', `${error.message}\n\nExisting workspace files have been preserved.`);
      quitting = true;
      app.quit();
    }
  });
  app.on('activate', () => { if (store) createWindow(); });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('before-quit', () => {
    quitting = true;
    if (checkpointInterval) clearInterval(checkpointInterval);
    if (cloudInterval) clearInterval(cloudInterval);
    updates?.close();
    try { cloudClient?.pauseSync(); }
    catch (error) { console.error('Cloud synchronization could not be paused:', error.message); }
    try { stopNative(); if (store) store.flush(); }
    catch (error) { console.error('Workspace could not be saved:', error.message); }
  });
}
