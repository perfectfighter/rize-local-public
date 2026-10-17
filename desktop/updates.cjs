'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Feed and publisher trust come from electron-builder's packaged app-update.yml.
// Never accept a renderer-provided feed, signing override, or installer path.
function createUpdates(options = {}) {
  const { app, send = () => {}, env = process.env, platform = process.platform,
    resourcesPath = process.resourcesPath, existsSync = fs.existsSync,
    readFileSync = fs.readFileSync, now = () => new Date().toISOString() } = options;
  let updater, closed = false, operation = null;
  const listeners = [];
  const state = { supported: false, state: 'unsupported', message: '', currentVersion: app?.getVersion?.() || '',
    availableVersion: null, releaseDate: null, progress: null, checkedAt: null };
  const snapshot = () => ({ ...state, progress: state.progress ? { ...state.progress } : null });
  const publish = patch => {
    if (closed) return snapshot();
    Object.assign(state, patch);
    try { send(snapshot()); } catch { /* A closed renderer must not interrupt updater state. */ }
    return snapshot();
  };
  const errorMessage = error => String(error?.message || error || 'The update could not be completed.').slice(0, 1200);
  const onError = error => publish({ state: 'error', message: errorMessage(error), progress: null });
  function availability() {
    if (platform !== 'win32') return 'Automatic installation is available in the Windows NSIS build.';
    if (!app?.isPackaged || env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) return 'Install the NSIS build to use updates. Portable and development builds cannot update themselves.';
    if (!resourcesPath || !existsSync(path.join(resourcesPath, 'app-update.yml'))) return 'This build has no published update configuration. Install a signed NSIS release.';
    const executable = app.getPath?.('exe');
    const uninstall = executable && path.join(path.dirname(executable), `Uninstall ${app.getName?.() || 'Rize Local'}.exe`);
    if (!uninstall || !existsSync(uninstall)) return 'Install the NSIS build to use updates. No installed NSIS application was detected.';
    let config;
    try { config = readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8'); }
    catch { return 'The installed update configuration could not be read.'; }
    // electron-updater enforces Authenticode against publisherName. An unsigned
    // developer build must not silently become an updater that trusts any EXE.
    const publisher = /^publisherName:[ \t]*(.*)$/m.exec(config);
    const inline = publisher?.[1]?.trim();
    const list = /^publisherName:[ \t]*\r?\n[ \t]+-[ \t]+[^\s]/m.test(config);
    if (!publisher || (!list && (!inline || /^(?:null|~|\[\]|''|"")$/.test(inline)))) return 'Signed updates require a configured publisher identity. Install a signed release with publisherName set.';
    return '';
  }
  state.message = availability();
  state.supported = !state.message;
  if (state.supported) { state.state = 'idle'; state.message = 'Updates are checked only when you choose Check for updates.'; }
  function ensureUpdater() {
    if (closed) throw new Error('The update service is closed.');
    if (!state.supported) throw new Error(state.message);
    if (updater) return updater;
    updater = options.autoUpdater || require('electron-updater').autoUpdater;
    updater.autoDownload = false;
    if ('autoInstallEvent' in updater) updater.autoInstallEvent = 'manual';
    else updater.autoInstallOnAppQuit = false;
    const listen = (event, listener) => { updater.on(event, listener); listeners.push([event, listener]); };
    listen('checking-for-update', () => publish({ state: 'checking', message: 'Checking the published release feed…', progress: null, availableVersion: null, releaseDate: null }));
    listen('update-available', info => publish({ state: 'available', message: `Version ${info.version} is available. Choose Download to continue.`, availableVersion: String(info.version), releaseDate: info.releaseDate || null, progress: null, checkedAt: now() }));
    listen('update-not-available', () => publish({ state: 'current', message: 'No newer published release is available.', availableVersion: null, releaseDate: null, progress: null, checkedAt: now() }));
    listen('download-progress', info => publish({ state: 'downloading', message: 'Downloading and verifying the update…', progress: { percent: Math.max(0, Math.min(100, Number(info.percent) || 0)), transferred: Math.max(0, Number(info.transferred) || 0), total: Math.max(0, Number(info.total) || 0), bytesPerSecond: Math.max(0, Number(info.bytesPerSecond) || 0) } }));
    listen('update-downloaded', info => publish({ state: 'downloaded', message: 'The verified update is ready. Choose Restart and install when your work is saved.', availableVersion: String(info.version), progress: { percent: 100 } }));
    listen('error', onError);
    return updater;
  }
  async function run(kind, task) {
    if (operation) throw new Error('An update operation is already running.');
    ensureUpdater();
    operation = kind;
    try { await task(); return snapshot(); }
    catch (error) { onError(error); throw new Error(errorMessage(error)); }
    finally { operation = null; }
  }
  return {
    status: snapshot,
    check() {
      if (state.state === 'downloaded' || state.state === 'installing') return Promise.resolve(snapshot());
      return run('check', async () => {
        publish({ state: 'checking', message: 'Checking the published release feed…', availableVersion: null, releaseDate: null, progress: null });
        const result = await updater.checkForUpdates();
        if (!result && state.state === 'checking') throw new Error('The update feed did not return a release. Check that a signed release and latest.yml have been published.');
      });
    },
    download() {
      if (state.state !== 'available' || !state.availableVersion) return Promise.reject(new Error('Check for an available update before downloading.'));
      return run('download', async () => { publish({ state: 'downloading', message: 'Downloading and verifying the update…', progress: { percent: 0 } }); await updater.downloadUpdate(); });
    },
    install() {
      if (closed) throw new Error('The update service is closed.');
      if (state.state !== 'downloaded' || !state.availableVersion) throw new Error('Download and verify an update before installing.');
      if (operation) throw new Error('An update operation is already running.');
      try { publish({ state: 'installing', message: 'Restarting to install the verified update…' }); ensureUpdater().quitAndInstall(); return snapshot(); }
      catch (error) { onError(error); throw new Error(errorMessage(error)); }
    },
    close() {
      closed = true;
      for (const [event, listener] of listeners) updater?.removeListener(event, listener);
      listeners.length = 0;
    },
  };
}
module.exports = { createUpdates };
