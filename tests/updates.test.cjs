'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdates } = require('../desktop/updates.cjs');
function fixture(overrides = {}) {
  const updater = new EventEmitter();
  Object.assign(updater, { autoInstallEvent: 'onQuit', async checkForUpdates() { this.emit('update-available', { version: '1.2.0', releaseDate: '2026-10-18' }); return { updateInfo: { version: '1.2.0' } }; }, async downloadUpdate() { this.emit('download-progress', { percent: 40, transferred: 4, total: 10 }); this.emit('update-downloaded', { version: '1.2.0' }); }, quitAndInstall() { this.installCount = (this.installCount || 0) + 1; } });
  const sent = [];
  const options = { app: { isPackaged: true, getVersion: () => '1.1.0', getName: () => 'Rize Local', getPath: () => '/installed/Rize Local.exe' }, platform: 'win32', resourcesPath: '/installed/resources', env: {}, existsSync: () => true, readFileSync: () => 'provider: github\npublisherName:\n  - Example Publisher\n', autoUpdater: updater, send: s => sent.push(s), now: () => '2026-10-17T10:00:00Z', ...overrides };
  return { service: createUpdates(options), updater, sent };
}
test('updates are lazy and portable builds do not contact a release feed', async () => {
  const { service, updater } = fixture({ env: { PORTABLE_EXECUTABLE_FILE: '/portable.exe' } });
  assert.equal(service.status().supported, false);
  await assert.rejects(service.check(), /NSIS/);
  assert.equal(updater.listenerCount('error'), 0);
  assert.equal(service.status().availableVersion, null);
});
test('development, non-Windows, missing publisher and uninstalled builds are unsupported', () => {
  assert.equal(fixture({ platform: 'linux' }).service.status().supported, false);
  assert.equal(fixture({ app: { isPackaged: false } }).service.status().supported, false);
  assert.equal(fixture({ existsSync: () => false }).service.status().supported, false);
  assert.match(fixture({ readFileSync: () => 'provider: github\n' }).service.status().message, /publisher/);
  assert.match(fixture({ readFileSync: () => 'publisherName: []\n' }).service.status().message, /publisher/);
});
test('explicit check, download, and install follow verified updater events and keep manual mode', async () => {
  const { service, updater, sent } = fixture();
  assert.equal(updater.autoDownload, undefined);
  assert.throws(() => service.install(), /Download and verify/);
  await assert.rejects(service.download(), /Check for/);
  await service.check();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallEvent, 'manual');
  assert.equal(service.status().state, 'available');
  assert.equal(service.status().availableVersion, '1.2.0');
  assert.throws(() => service.install(), /Download and verify/);
  await service.download();
  assert.equal(service.status().state, 'downloaded');
  assert.equal(updater.installCount, undefined);
  assert.equal(sent.some(s => s.progress?.percent === 40), true);
  service.install();
  assert.equal(updater.installCount, 1);
  assert.equal(service.status().state, 'installing');
  service.close();
  assert.equal(updater.listenerCount('error'), 0);
});
test('no release and verification failures never permit installation or invent an available version', async () => {
  const { service, updater } = fixture();
  updater.checkForUpdates = async function() { this.emit('update-not-available', { version: '1.1.0' }); return { updateInfo: { version: '1.1.0' } }; };
  await service.check();
  assert.equal(service.status().state, 'current');
  assert.equal(service.status().availableVersion, null);
  updater.checkForUpdates = async function() { this.emit('update-available', { version: '1.2.0' }); return {}; };
  await service.check();
  updater.downloadUpdate = async () => { throw new Error('Publisher signature verification failed'); };
  await assert.rejects(service.download(), /signature verification/);
  assert.equal(service.status().state, 'error');
  assert.throws(() => service.install(), /Download and verify/);
});
test('concurrent checks are rejected and released after failure', async () => {
  const { service, updater } = fixture();
  let reject;
  updater.checkForUpdates = () => new Promise((_, r) => { reject = r; });
  const first = service.check();
  await assert.rejects(service.check(), /already running/);
  reject(new Error('Release feed is unavailable'));
  await assert.rejects(first, /feed is unavailable/);
  assert.equal(service.status().state, 'error');
  assert.equal(service.status().availableVersion, null);
});
test('electron-updater 6 uses its real manual-install property and never installs merely on app quit', async () => {
  const { service, updater } = fixture();
  delete updater.autoInstallEvent;
  updater.autoInstallOnAppQuit = true;
  await service.check();
  assert.equal(updater.autoInstallOnAppQuit, false);
  await service.download();
  assert.equal(updater.installCount, undefined);
  service.close();
  assert.throws(() => service.install(), /closed/);
});
