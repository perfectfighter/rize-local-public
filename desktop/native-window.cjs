'use strict';

// This adapter intentionally forwards a small allowlist. The native library's
// executable paths, icons, package details, and any additional fields stay here.
const SAMPLE_INTERVAL_MS = 5000;
const PRIVATE_WINDOW = /\b(?:incognito|inprivate|private\s+(?:browsing|window|mode))\b/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const URL = /\b(?:https?|ftp|file):\/\/\S+|\bwww\.[^\s]+/gi;

function cleanText(value, limit = 1024) {
  return typeof value === 'string'
    ? value.replace(CONTROL_CHARACTERS, '').replace(URL, '[address]').trim().slice(0, limit)
    : '';
}

function createSampler(options = {}) {
  const {
    onSample = () => {},
    onError = () => {},
    powerMonitor,
    platform = process.platform,
    now = Date.now,
    loadNative = () => require('@paymoapp/active-window'),
    setInterval: schedule = global.setInterval,
    clearInterval: cancel = global.clearInterval,
  } = options;
  let native = null;
  let interval = null;
  let running = false;
  let available = false;
  let message = 'Activity tracking is off.';

  function unavailable(reason, error = false) {
    available = false;
    message = reason;
    const timestamp = new Date(now()).toISOString();
    onSample({ timestamp, app: '', title: '', pid: 0, idleSeconds: 0, available: false });
    if (error) onError(new Error(reason));
  }

  function sampleNow() {
    if (!running) return;
    if (platform !== 'win32') {
      unavailable('Automatic activity tracking is available on Windows.');
      return;
    }
    try {
      if (!native) {
        const loaded = loadNative();
        const candidate = loaded?.default || loaded;
        if (!candidate || typeof candidate.initialize !== 'function' || typeof candidate.getActiveWindow !== 'function') {
          throw new Error('Invalid native adapter');
        }
        candidate.initialize();
        native = candidate;
      }
      if (typeof powerMonitor?.getSystemIdleTime !== 'function') throw new Error('Idle monitoring unavailable');
      const idleSeconds = Number(powerMonitor.getSystemIdleTime());
      if (!Number.isFinite(idleSeconds) || idleSeconds < 0) throw new Error('Invalid idle result');
      const window = native.getActiveWindow();
      const app = cleanText(window?.application, 256);
      if (!window || !app) {
        unavailable('No foreground application is available.');
        return;
      }
      const rawTitle = cleanText(window.title);
      const title = PRIVATE_WINDOW.test(rawTitle) ? '[Private window]' : rawTitle;
      const pid = Number.isSafeInteger(window.pid) && window.pid > 0 ? window.pid : 0;
      available = true;
      message = 'Collecting local foreground activity.';
      onSample({ timestamp: new Date(now()).toISOString(), app, title, pid, idleSeconds, available: true });
    } catch {
      // Native error details may contain local paths. Give the UI a useful,
      // non-sensitive error and retry on the next poll instead.
      unavailable('Activity collection is unavailable. Toggle tracking to retry.', true);
    }
  }

  return {
    start() {
      if (running) return available;
      if (platform !== 'win32') {
        unavailable('Automatic activity tracking is available on Windows.');
        return false;
      }
      running = true;
      sampleNow();
      interval = schedule(sampleNow, SAMPLE_INTERVAL_MS);
      if (typeof interval?.unref === 'function') interval.unref();
      return available;
    },
    stop() {
      running = false;
      if (interval !== null) cancel(interval);
      interval = null;
      available = false;
      message = 'Activity tracking is off.';
    },
    sampleNow,
    getStatus() { return { running, available, message }; },
  };
}

module.exports = { createSampler, cleanText, SAMPLE_INTERVAL_MS };
