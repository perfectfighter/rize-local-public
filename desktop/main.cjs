'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, session, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createStore, toCsv } = require('./store.cjs');
const { createTrackingEngine } = require('./tracking-engine.cjs');
const { createSampler } = require('./native-window.cjs');

app.setName('Rize Local');
let mainWindow, tray, store, sampler, checkpointInterval;
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
    // This local app has no network features. Only built frontend files and inline images are needed.
    const allowed = allowedFile(details.url) || details.url.startsWith('data:image/');
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
    const result = store.mutate(command);
    publishState();
    reconcileTracking();
    return result;
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
    stopNative();
    // Backups never opt someone into tracking merely by being imported.
    if (value && value.settings) value.settings.trackingEnabled = false;
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
    try { stopNative(); if (store) store.flush(); }
    catch (error) { console.error('Workspace could not be saved:', error.message); }
  });
}
