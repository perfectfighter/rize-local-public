'use strict';

const { randomUUID } = require('node:crypto');
const { cleanText } = require('./native-window.cjs');

const DEFAULT_MAX_GAP_MS = 15000;
const CATEGORIES = new Set(['productive', 'neutral', 'distracting']);
const PRIVATE_WINDOW = /\b(?:incognito|inprivate|private\s+(?:browsing|window|mode))\b/i;

function timestamp(value) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
function iso(value) { return new Date(value).toISOString(); }
function list(value) { return Array.isArray(value) ? value : []; }
function enabled(state) {
  return state?.onboarded === true && state?.demo !== true
    && state?.settings?.trackingEnabled === true
    && !state?.settings?.trackingPaused && !state?.trackingPaused;
}
function parseTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
function isScheduled(ms, settings) {
  if (!settings?.scheduleEnabled) return true;
  const start = parseTime(settings.scheduleStart);
  const end = parseTime(settings.scheduleEnd);
  if (start === null || end === null) return false;
  const date = new Date(ms);
  const minute = date.getHours() * 60 + date.getMinutes();
  const days = Array.isArray(settings.workDays) ? settings.workDays : [1, 2, 3, 4, 5];
  if (start <= end) return days.includes(date.getDay()) && (start === end || (minute >= start && minute < end));
  if (minute >= start) return days.includes(date.getDay());
  date.setDate(date.getDate() - 1);
  return minute < end && days.includes(date.getDay());
}
function boundaries(start, end, settings) {
  const result = [start, end];
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() <= end) {
    const midnight = day.getTime();
    if (midnight > start && midnight < end) result.push(midnight);
    if (settings?.scheduleEnabled) {
      for (const value of [settings.scheduleStart, settings.scheduleEnd]) {
        const minutes = parseTime(value);
        if (minutes === null) continue;
        const point = new Date(day);
        point.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
        if (point.getTime() > start && point.getTime() < end) result.push(point.getTime());
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return [...new Set(result)].sort((a, b) => a - b);
}
function keywordMatch(value, text) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : [];
  return values.some(word => {
    const clean = cleanText(word, 256).toLocaleLowerCase();
    return clean && text.includes(clean);
  });
}
function links(entity, state) {
  let task = list(state.tasks).find(item => item.id === entity?.taskId);
  let project = list(state.projects).find(item => item.id === (task?.projectId || entity?.projectId));
  const clientId = task?.clientId || project?.clientId || entity?.clientId || '';
  const client = list(state.clients).find(item => item.id === clientId);
  // Existing ancestors define the hierarchy. A task with a deleted project is
  // still represented without inventing a project or client.
  return { clientId: client?.id || '', projectId: project?.id || '', taskId: task?.id || '' };
}
function classify(sample, state) {
  const text = `${sample.app} ${sample.title}`.toLocaleLowerCase();
  const rules = list(state.rules).filter(rule => keywordMatch([rule.keyword], text));
  if (rules.some(rule => rule.action === 'exclude')) return null;
  const rule = rules[0];
  let category = CATEGORIES.has(rule?.action) ? rule.action : 'neutral';
  if (!rule) {
    if (/\b(?:netflix|tiktok|reddit|twitter|youtube|instagram)\b/.test(text)) category = 'distracting';
    else if (/\b(?:code|visual studio|webstorm|github|figma|notion|excel|word|zoom|teams|meet)\b/.test(text)) category = 'productive';
  }
  const task = list(state.tasks).find(item => keywordMatch(item.keywords, text));
  const project = list(state.projects).find(item => keywordMatch(item.keywords, text));
  const linked = rule ? links(rule, state) : links({ taskId: task?.id, projectId: project?.id }, state);
  return { ...linked, category, billable: false };
}
function normalizeSample(sample) {
  const ms = timestamp(sample?.timestamp);
  if (ms === null) return null;
  let title = cleanText(sample?.title);
  if (PRIVATE_WINDOW.test(title)) title = '[Private window]';
  return {
    ms, app: cleanText(sample?.app, 256), title,
    available: sample?.available === true,
    idleSeconds: Number.isFinite(sample?.idleSeconds) && sample.idleSeconds >= 0 ? sample.idleSeconds : Infinity,
  };
}
function withinIdle(sample, state) {
  const configured = Number(state?.settings?.idleSeconds);
  const cutoff = Number.isFinite(configured) && configured > 0 ? configured : 300;
  return sample.idleSeconds < cutoff;
}

function createTrackingEngine({ now = Date.now, maxGapMs = DEFAULT_MAX_GAP_MS, idFactory = randomUUID } = {}) {
  let previous = null;
  let active = null;
  const gapLimit = Number.isFinite(maxGapMs) && maxGapMs > 0 ? maxGapMs : DEFAULT_MAX_GAP_MS;
  function reset() { previous = null; active = null; }
  function append(sample, start, end, state) {
    const metadata = classify(sample, state);
    if (!metadata) { active = null; return []; }
    const result = [];
    const points = boundaries(start, end, state.settings);
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index], b = points[index + 1];
      if (b <= a || !isScheduled(a + (b - a) / 2, state.settings)) { active = null; continue; }
      const description = sample.title || sample.app;
      const signature = JSON.stringify([sample.app, sample.title, metadata]);
      // A midnight boundary always starts a new daily entry.
      const localDay = new Date(a).toDateString();
      if (!active || active.signature !== signature || active.end !== iso(a) || active.localDay !== localDay) {
        active = {
          id: `activity-${idFactory()}`, start: iso(a), end: iso(b),
          description, app: sample.app, title: sample.title,
          status: 'pending', source: 'automatic', ...metadata,
          durationMs: b - a, signature, localDay,
        };
      } else {
        active.end = iso(b);
        active.durationMs = b - Date.parse(active.start);
      }
      const { signature: _, localDay: __, ...entry } = active;
      result.push({ ...entry });
    }
    return result;
  }
  return {
    consume(sample, state) {
      if (!enabled(state)) { reset(); return []; }
      const current = normalizeSample(sample);
      if (!current) { reset(); return []; }
      if (previous && current.ms <= previous.ms) return [];
      const prior = previous;
      previous = current;
      if (!current.available || !current.app || !withinIdle(current, state) || !classify(current, state)) {
        active = null;
        previous = null;
        return [];
      }
      if (!prior || !prior.available || !prior.app || !withinIdle(prior, state)) return [];
      const elapsed = current.ms - prior.ms;
      if (elapsed > gapLimit) { active = null; return []; }
      return append(prior, prior.ms, current.ms, state);
    },
    flush(at = now(), _state) {
      // At most the interval ending at the last actual sample is known. Never
      // infer foreground or work time between that sample and a flush/quit.
      const current = active;
      reset();
      if (!current || timestamp(at) === null) return [];
      const { signature: _, localDay: __, ...entry } = current;
      return [{ ...entry }];
    },
    reset,
  };
}

module.exports = { createTrackingEngine, isScheduled, DEFAULT_MAX_GAP_MS };
