'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { defaultBusiness, validateBusiness, applyBusinessCommand } = require('./business.cjs');

const copy = value => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const KINDS = ['focus', 'meeting', 'break'];
const ACTIONS = ['productive', 'neutral', 'distracting', 'exclude'];

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function text(value, label, max = 300, empty = true) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be text of at most ${max} characters without control characters.`);
  }
  const result = value.trim();
  if (!empty && !result) throw new Error(`${label} is required.`);
  return result;
}

function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function choice(value, options, label) {
  if (!options.includes(value)) throw new Error(`${label} must be ${options.join(', ')}.`);
  return value;
}

function iso(value, label) {
  const parts = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T([0-2]\d):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(?:Z|[+-][0-2]\d:[0-5]\d)$/.exec(value);
  const calendar = parts && new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00.000Z`);
  if (!parts || parts[4] > 23 || !Number.isFinite(Date.parse(value)) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function id(value, label = 'ID') {
  return text(value, label, 160, false);
}

function list(value, label, limit = 50000) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} items.`);
  return value;
}

function keywords(value = []) {
  const parts = typeof value === 'string' ? value.split(',') : list(value, 'Keywords', 100);
  return [...new Set(parts.map(item => text(item, 'Keyword', 120)).filter(Boolean))];
}

function externalMetadata(value) {
  const externalUrl = text(value.externalUrl ?? '', 'External URL', 2000);
  if (externalUrl) {
    let url;
    try { url = new URL(externalUrl); } catch { throw new Error('External URL must be a valid HTTPS URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('External URL must use HTTPS without credentials.');
  }
  return { externalId: text(value.externalId ?? '', 'External ID', 300), externalProvider: text(value.externalProvider ?? '', 'External provider', 80), externalUrl };
}

function defaults() {
  return {
    schemaVersion: 1,
    workspaceId: randomUUID(),
    onboarded: false,
    demo: false,
    settings: { displayName: 'You', trackingEnabled: false, idleSeconds: 300, scheduleEnabled: false, scheduleStart: '09:00', scheduleEnd: '18:00', workDays: [1, 2, 3, 4, 5] },
    entries: [], clients: [], projects: [], tasks: [], rules: [], sessions: [], timer: null,
    business: defaultBusiness(), sharedIds: { clients: [], projects: [], tasks: [], entries: [], contracts: [], allocations: [], invoices: [] },
  };
}

function normalizeSettings(input) {
  object(input, 'Settings');
  const settings = {
    displayName: text(input.displayName, 'Display name', 80, false),
    trackingEnabled: boolean(input.trackingEnabled, 'Tracking enabled'),
    idleSeconds: number(input.idleSeconds, 'Idle threshold', 30, 3600),
    scheduleEnabled: boolean(input.scheduleEnabled, 'Schedule enabled'),
    scheduleStart: text(input.scheduleStart, 'Schedule start', 5, false),
    scheduleEnd: text(input.scheduleEnd, 'Schedule end', 5, false),
    workDays: [...new Set(list(input.workDays, 'Work days', 7).map(day => {
      number(day, 'Work day', 0, 6);
      if (!Number.isInteger(day)) throw new Error('Work day must be an integer.');
      return day;
    }))].sort(),
  };
  if (![settings.scheduleStart, settings.scheduleEnd].every(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('Schedule times must use HH:mm.');
  return settings;
}

function links(input, state) {
  let clientId = text(input.clientId ?? '', 'Client ID', 160);
  let projectId = text(input.projectId ?? '', 'Project ID', 160);
  const taskId = text(input.taskId ?? '', 'Task ID', 160);
  if (taskId) {
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('The selected task does not exist.');
    if ((projectId && projectId !== task.projectId) || (clientId && clientId !== task.clientId)) throw new Error('The task does not belong to the selected project or client.');
    projectId = task.projectId;
    clientId = task.clientId;
  }
  if (projectId) {
    const project = state.projects.find(item => item.id === projectId);
    if (!project) throw new Error('The selected project does not exist.');
    if (clientId && clientId !== project.clientId) throw new Error('The project does not belong to the selected client.');
    clientId = project.clientId;
  }
  if (clientId && !state.clients.some(item => item.id === clientId)) throw new Error('The selected client does not exist.');
  return { clientId, projectId, taskId };
}

function normalizeEntry(value, state) {
  object(value, 'Time entry');
  const start = iso(value.start, 'Entry start');
  const end = iso(value.end, 'Entry end');
  const durationMs = Date.parse(end) - Date.parse(start);
  if (durationMs <= 0) throw new Error('An entry must end after it starts.');
  return {
    id: id(value.id), start, end, durationMs,
    description: text(value.description ?? '', 'Description', 2000),
    app: text(value.app ?? 'Manual entry', 'Application', 300),
    title: text(value.title ?? '', 'Window title', 2000),
    status: choice(value.status ?? 'approved', ['pending', 'approved'], 'Entry status'),
    source: choice(value.source ?? 'manual', ['automatic', 'manual', 'timer'], 'Entry source'),
    category: text(value.category ?? 'neutral', 'Category', 80),
    ...links(value, state),
    billable: boolean(value.billable ?? false, 'Billable'),
    labelIds: [...new Set(list(value.labelIds ?? [], 'Entry labels', 100).map(labelId => id(labelId, 'Label ID')))],
    ...externalMetadata(value),
    externalSource: text(value.externalSource ?? '', 'External source', 80),
  };
}

function normalizeSegments(value, startedAt, endedAt) {
  let previousEnd = Date.parse(startedAt);
  return list(value ?? [], 'Timer segments', 10000).map(segment => {
    object(segment, 'Timer segment');
    const start = iso(segment.start, 'Segment start');
    const end = iso(segment.end, 'Segment end');
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (startMs < previousEnd || endMs <= startMs || (endedAt && endMs > Date.parse(endedAt))) throw new Error('Timer segments must be ordered, non-overlapping active intervals.');
    previousEnd = endMs;
    return { start, end };
  });
}

const segmentDuration = segments => segments.reduce((sum, segment) => sum + Date.parse(segment.end) - Date.parse(segment.start), 0);

function timerMetadata(value, state) {
  return {
    id: id(value.id),
    kind: choice(value.kind, KINDS, 'Session type'),
    goal: text(value.goal ?? '', 'Session goal', 2000),
    targetMs: number(value.targetMs, 'Session target', 60000, 86400000),
    ...links(value, state),
    autoCollected: boolean(value.autoCollected ?? false, 'Automatic collection flag'),
  };
}

function normalizeTimer(value, state) {
  if (value === null) return null;
  object(value, 'Timer');
  const startedAt = iso(value.startedAt, 'Session start');
  const status = choice(value.status, ['running', 'paused'], 'Timer status');
  const resumedAt = status === 'running' ? iso(value.resumedAt, 'Resume time') : null;
  const segments = normalizeSegments(value.segments, startedAt, resumedAt);
  const elapsedMs = segmentDuration(segments);
  if (resumedAt && Date.parse(resumedAt) < Date.parse(startedAt)) throw new Error('Resume time cannot precede session start.');
  if (value.elapsedMs !== undefined && value.elapsedMs !== elapsedMs) throw new Error('Timer elapsed time does not match its active segments.');
  return { ...timerMetadata(value, state), status, startedAt, resumedAt, elapsedMs, segments };
}

function normalizeSession(value, state) {
  object(value, 'Session');
  const startedAt = iso(value.startedAt, 'Session start');
  const endedAt = iso(value.endedAt, 'Session end');
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error('Session end cannot precede its start.');
  const segments = normalizeSegments(value.segments, startedAt, endedAt);
  const elapsedMs = segmentDuration(segments);
  if (value.elapsedMs !== undefined && value.elapsedMs !== elapsedMs) throw new Error('Session elapsed time does not match its active segments.');
  return { ...timerMetadata(value, state), startedAt, endedAt, elapsedMs, segments };
}

function unique(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${label} ID: ${item.id}`);
    seen.add(item.id);
  }
  return items;
}

function validateSnapshot(value) {
  object(value, 'Workspace');
  if (value.schemaVersion !== 1) throw new Error('Unsupported workspace schema version.');
  const state = defaults();
  state.workspaceId = value.workspaceId === undefined ? state.workspaceId : id(value.workspaceId, 'Workspace ID');
  state.onboarded = boolean(value.onboarded, 'Onboarding flag');
  state.demo = boolean(value.demo, 'Sample workspace flag');
  state.settings = normalizeSettings(value.settings);
  if (state.demo && state.settings.trackingEnabled) throw new Error('Automatic tracking is unavailable in a sample workspace.');
  state.clients = unique(list(value.clients, 'Clients', 2000).map(item => {
    object(item, 'Client');
    return { id: id(item.id), name: text(item.name, 'Client name', 200, false), hourlyRate: number(item.hourlyRate ?? 0, 'Hourly rate', 0, 1000000) };
  }), 'client');
  state.projects = unique(list(value.projects, 'Projects', 5000).map(item => {
    object(item, 'Project');
    const linked = links({ clientId: item.clientId }, state);
    return { id: id(item.id), name: text(item.name, 'Project name', 200, false), clientId: linked.clientId, keywords: keywords(item.keywords), ...externalMetadata(item) };
  }), 'project');
  state.tasks = unique(list(value.tasks, 'Tasks', 10000).map(item => {
    object(item, 'Task');
    const linked = links({ clientId: item.clientId, projectId: item.projectId }, state);
    return { id: id(item.id), name: text(item.name, 'Task name', 200, false), clientId: linked.clientId, projectId: linked.projectId, keywords: keywords(item.keywords), done: boolean(item.done ?? false, 'Task complete'), ...externalMetadata(item) };
  }), 'task');
  state.rules = unique(list(value.rules ?? [], 'Rules', 5000).map(item => {
    object(item, 'Rule');
    return { id: id(item.id), name: text(item.name, 'Rule name', 200, false), keyword: text(item.keyword, 'Rule keyword', 200, false), action: choice(item.action, ACTIONS, 'Rule action'), ...links(item, state) };
  }), 'rule');
  state.entries = unique(list(value.entries, 'Entries').map(item => normalizeEntry(item, state)), 'entry');
  state.sessions = unique(list(value.sessions, 'Sessions', 10000).map(item => normalizeSession(item, state)), 'session');
  state.timer = normalizeTimer(value.timer, state);
  state.business = validateBusiness(value.business, state);
  const labelIds = new Set(state.business.labels.map(label => label.id));
  if (state.entries.some(entry => entry.labelIds.some(labelId => !labelIds.has(labelId)))) throw new Error('An entry label does not exist.');
  if (value.sharedIds !== undefined) {
    object(value.sharedIds, 'Shared record IDs');
    for (const kind of Object.keys(state.sharedIds)) state.sharedIds[kind] = [...new Set(list(value.sharedIds[kind] ?? [], 'Shared record IDs').map(item => id(item)))];
  }
  return state;
}

function closeActiveSegment(timer, timestamp) {
  if (timer.status !== 'running') return;
  const startMs = Date.parse(timer.resumedAt);
  const endMs = Math.max(startMs, timestamp);
  if (endMs > startMs) timer.segments.push({ start: timer.resumedAt, end: new Date(endMs).toISOString() });
  timer.elapsedMs = segmentDuration(timer.segments);
  timer.status = 'paused';
  timer.resumedAt = null;
}

function checkpoint(state, timestamp) {
  const snapshot = copy(state);
  if (snapshot.timer) closeActiveSegment(snapshot.timer, timestamp);
  return snapshot;
}

function splitAtMidnight(segment) {
  const result = [];
  let cursor = Date.parse(segment.start);
  const end = Date.parse(segment.end);
  while (cursor < end) {
    const local = new Date(cursor);
    const midnight = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1).getTime();
    const boundary = Math.min(end, midnight);
    result.push({ start: new Date(cursor).toISOString(), end: new Date(boundary).toISOString() });
    cursor = boundary;
  }
  return result;
}

function sampleWorkspace(timestamp) {
  const state = defaults();
  state.onboarded = true;
  state.demo = true;
  state.settings.displayName = 'Sample workspace';
  state.clients = [{ id: 'sample-client', name: 'Acme Studio', hourlyRate: 95 }];
  state.projects = [{ id: 'sample-project', name: 'Website redesign', clientId: 'sample-client', keywords: ['Acme', 'Design'] }];
  state.tasks = [{ id: 'sample-task', name: 'Design and development', clientId: 'sample-client', projectId: 'sample-project', keywords: ['Figma', 'Visual Studio Code'] }];
  const apps = ['Visual Studio Code', 'Figma', 'Google Chrome'];
  for (let day = 0; day < 5; day++) {
    for (let block = 0; block < 3; block++) {
      const start = new Date(timestamp);
      start.setDate(start.getDate() - day);
      start.setHours(9 + block * 2, block === 1 ? 20 : 0, 0, 0);
      state.entries.push(normalizeEntry({ id: `sample-${day}-${block}`, start: start.toISOString(), end: new Date(start.getTime() + (70 + block * 15) * 60000).toISOString(), description: ['Frontend implementation', 'Explore new concepts', 'Research and planning'][block], app: apps[block], title: 'Acme · Website redesign', status: block === 2 ? 'pending' : 'approved', source: 'automatic', category: 'productive', clientId: 'sample-client', projectId: 'sample-project', taskId: 'sample-task', billable: true }, state));
    }
  }
  return state;
}

function modifyEntity(state, kind, payload) {
  const plural = { client: 'clients', project: 'projects', task: 'tasks', rule: 'rules' }[kind];
  const itemId = payload.id ? id(payload.id) : randomUUID();
  const index = state[plural].findIndex(item => item.id === itemId);
  const previous = index >= 0 ? state[plural][index] : {};
  const value = { ...previous, ...payload, id: itemId };
  let entity;
  if (kind === 'client') entity = { id: itemId, name: text(value.name, 'Client name', 200, false), hourlyRate: number(value.hourlyRate ?? 0, 'Hourly rate', 0, 1000000) };
  if (kind === 'project') entity = { id: itemId, name: text(value.name, 'Project name', 200, false), clientId: links({ clientId: value.clientId }, state).clientId, keywords: keywords(value.keywords), ...externalMetadata(value) };
  if (kind === 'task') {
    const linked = links({ clientId: value.clientId, projectId: value.projectId }, state);
    entity = { id: itemId, name: text(value.name, 'Task name', 200, false), clientId: linked.clientId, projectId: linked.projectId, keywords: keywords(value.keywords), done: boolean(value.done ?? false, 'Task complete'), ...externalMetadata(value) };
  }
  if (kind === 'rule') entity = { id: itemId, name: text(value.name, 'Rule name', 200, false), keyword: text(value.keyword, 'Rule keyword', 200, false), action: choice(value.action ?? 'productive', ACTIONS, 'Rule action'), ...links(value, state) };
  if (index >= 0) state[plural][index] = entity;
  else state[plural].push(entity);
  if (kind === 'project') {
    for (const item of [...state.tasks, ...state.rules, ...state.entries, ...state.sessions, ...(state.timer ? [state.timer] : [])]) if (item.projectId === itemId) item.clientId = entity.clientId;
    for (const item of state.business.contracts) if (item.projectId === itemId) item.clientId = entity.clientId;
  }
  if (kind === 'task') {
    for (const item of [...state.rules, ...state.entries, ...state.sessions, ...(state.timer ? [state.timer] : [])]) if (item.taskId === itemId) Object.assign(item, { projectId: entity.projectId, clientId: entity.clientId });
  }
}

function deleteEntity(state, kind, payload) {
  const plural = { client: 'clients', project: 'projects', task: 'tasks', rule: 'rules' }[kind];
  const itemId = id(payload.id);
  if (!state[plural].some(item => item.id === itemId)) throw new Error(`The ${kind} does not exist.`);
  state[plural] = state[plural].filter(item => item.id !== itemId);
  if (kind === 'rule') return;
  const field = `${kind}Id`;
  for (const item of [...state.projects, ...state.tasks, ...state.rules, ...state.entries, ...state.sessions, ...(state.timer ? [state.timer] : [])]) if (item[field] === itemId) item[field] = '';
  if (kind === 'client') {
    state.business.clientTerms = state.business.clientTerms.filter(item => item.clientId !== itemId);
    state.business.contracts = state.business.contracts.filter(item => item.clientId !== itemId);
  }
  if (kind === 'project') {
    state.business.contracts = state.business.contracts.filter(item => item.projectId !== itemId);
    state.business.allocations = state.business.allocations.filter(item => item.projectId !== itemId);
  }
}

function assertUninvoiced(state, ids) {
  const selected = new Set(ids);
  if (state.business.invoices.some(invoice => invoice.status !== 'void' && invoice.lines.some(line => selected.has(line.entryId)))) throw new Error('An entry belongs to an active invoice. Void that invoice before editing the entry.');
}

function advancedEntry(state, type, payload) {
  if (type === 'entry.split') {
    const target = state.entries.find(entry => entry.id === id(payload.id));
    if (!target) throw new Error('The time entry does not exist.');
    assertUninvoiced(state, [target.id]);
    const at = iso(payload.at, 'Split time');
    if (Date.parse(at) <= Date.parse(target.start) || Date.parse(at) >= Date.parse(target.end)) throw new Error('Split time must be inside the entry.');
    const index = state.entries.indexOf(target);
    state.entries.splice(index, 1, normalizeEntry({ ...target, id: randomUUID(), end: at }, state), normalizeEntry({ ...target, id: randomUUID(), start: at }, state));
    return true;
  }
  if (type === 'entry.merge' || type === 'entry.bulk') {
    const ids = [...new Set(list(payload.ids, 'Selected entries', 1000).map(value => id(value)))];
    if (!ids.length || (type === 'entry.merge' && ids.length < 2)) throw new Error('Select the required time entries.');
    const selected = ids.map(value => { const result = state.entries.find(entry => entry.id === value); if (!result) throw new Error('A selected time entry does not exist.'); return result; });
    assertUninvoiced(state, ids);
    if (type === 'entry.bulk') {
      object(payload.patch, 'Bulk entry changes');
      const allowed = ['description', 'clientId', 'projectId', 'taskId', 'status', 'category', 'billable', 'labelIds'];
      if (Object.keys(payload.patch).some(key => !allowed.includes(key))) throw new Error('Bulk changes contain an unsupported field.');
      for (const entry of selected) state.entries[state.entries.indexOf(entry)] = normalizeEntry({ ...entry, ...payload.patch }, state);
    } else {
      selected.sort((a, b) => a.start.localeCompare(b.start));
      const fields = ['clientId', 'projectId', 'taskId', 'status', 'source', 'category', 'billable', 'app', 'title', 'externalId', 'externalSource'];
      const first = selected[0];
      for (let index = 1; index < selected.length; index++) {
        if (Date.parse(selected[index - 1].end) !== Date.parse(selected[index].start)) throw new Error('Merged entries must be exactly contiguous, without gaps or overlaps.');
        if (fields.some(field => selected[index][field] !== first[field]) || JSON.stringify([...selected[index].labelIds].sort()) !== JSON.stringify([...first.labelIds].sort())) throw new Error('Merged entries must have the same tags, status, source, application, and labels.');
      }
      const merged = normalizeEntry({ ...first, id: randomUUID(), end: selected.at(-1).end, description: [...new Set(selected.map(entry => entry.description).filter(Boolean))].join('\n') }, state);
      state.entries = state.entries.filter(entry => !ids.includes(entry.id));
      state.entries.push(merged);
    }
    return true;
  }
  if (type === 'entry.regenerate') {
    const entry = state.entries.find(item => item.id === id(payload.id));
    if (!entry) throw new Error('The time entry does not exist.');
    assertUninvoiced(state, [entry.id]);
    const haystack = `${entry.app}\n${entry.title}\n${entry.description}`.toLocaleLowerCase();
    const rule = state.rules.find(item => haystack.includes(item.keyword.toLocaleLowerCase()));
    const patch = rule ? { category: rule.action, clientId: rule.clientId, projectId: rule.projectId, taskId: rule.taskId, ...(rule.action === 'exclude' ? { status: 'pending' } : {}) } : {};
    const matchingLabels = state.business.labels.filter(label => label.keywords.some(keyword => haystack.includes(keyword.toLocaleLowerCase()))).map(label => label.id);
    state.entries[state.entries.indexOf(entry)] = normalizeEntry({ ...entry, ...patch, labelIds: [...new Set([...entry.labelIds, ...matchingLabels])] }, state);
    return true;
  }
  return false;
}

function applyCommand(state, command, timestamp) {
  object(command, 'Command');
  const payload = object(command.payload ?? {}, 'Command payload');
  const type = text(command.type, 'Command type', 80, false);
  if (type === 'workspace.create') {
    const next = defaults();
    next.onboarded = true;
    next.settings.displayName = text(payload.displayName ?? 'You', 'Display name', 80, false);
    return next;
  }
  if (type === 'workspace.demo') return sampleWorkspace(timestamp);
  if (type === 'settings.update') {
    state.settings = normalizeSettings({ ...state.settings, ...payload });
    if (state.demo && state.settings.trackingEnabled) throw new Error('Create your own workspace before enabling automatic tracking.');
    if (state.timer && state.settings.trackingEnabled) state.timer.autoCollected = true;
    return state;
  }
  const businessResult = applyBusinessCommand(state, { type, payload }, timestamp);
  if (businessResult) return businessResult;
  if (advancedEntry(state, type, payload)) return state;
  const entityCommand = /^(client|project|task|rule)\.(upsert|delete)$/.exec(type);
  if (entityCommand) {
    (entityCommand[2] === 'upsert' ? modifyEntity : deleteEntity)(state, entityCommand[1], payload);
    return state;
  }
  if (type === 'entry.upsert') {
    const entryId = payload.id ? id(payload.id) : randomUUID();
    const index = state.entries.findIndex(entry => entry.id === entryId);
    if (index >= 0) assertUninvoiced(state, [entryId]);
    const value = normalizeEntry({ ...(index >= 0 ? state.entries[index] : {}), ...payload, id: entryId }, state);
    if (index >= 0) state.entries[index] = value;
    else state.entries.push(value);
    return state;
  }
  if (type === 'entry.delete' || type === 'entry.review') {
    const index = state.entries.findIndex(entry => entry.id === id(payload.id));
    if (index < 0) throw new Error('The time entry does not exist.');
    assertUninvoiced(state, [state.entries[index].id]);
    if (type === 'entry.delete') state.entries.splice(index, 1);
    else state.entries[index].status = choice(payload.status, ['pending', 'approved'], 'Entry status');
    return state;
  }
  if (type === 'timer.start') {
    if (state.timer) throw new Error('Stop the current session before starting another.');
    const kind = choice(payload.kind ?? 'focus', KINDS, 'Session type');
    state.timer = normalizeTimer({ id: randomUUID(), kind, goal: payload.goal ?? '', targetMs: payload.targetMs ?? (kind === 'focus' ? 45 : kind === 'meeting' ? 30 : 5) * 60000, ...links(payload, state), status: 'running', startedAt: new Date(timestamp).toISOString(), resumedAt: new Date(timestamp).toISOString(), elapsedMs: 0, segments: [], autoCollected: state.settings.trackingEnabled }, state);
    return state;
  }
  if (type.startsWith('timer.')) {
    const timer = state.timer;
    if (!timer) throw new Error('There is no active session.');
    if (type === 'timer.pause') {
      if (timer.status !== 'running') throw new Error('The session is already paused.');
      closeActiveSegment(timer, timestamp);
    } else if (type === 'timer.resume') {
      if (timer.status !== 'paused') throw new Error('The session is already running.');
      const lastEnd = timer.segments.length ? Date.parse(timer.segments.at(-1).end) : Date.parse(timer.startedAt);
      timer.resumedAt = new Date(Math.max(timestamp, lastEnd)).toISOString();
      timer.status = 'running';
      if (state.settings.trackingEnabled) timer.autoCollected = true;
    } else if (type === 'timer.extend') {
      const minutes = number(payload.minutes, 'Additional minutes', 0.1, 1440);
      timer.targetMs = number(timer.targetMs + minutes * 60000, 'Session target', 60000, 86400000);
    } else if (type === 'timer.update') {
      for (const field of ['goal', 'kind', 'targetMs', 'clientId', 'projectId', 'taskId']) if (own(payload, field)) timer[field] = payload[field];
      state.timer = normalizeTimer(timer, state);
    } else if (type === 'timer.stop') {
      closeActiveSegment(timer, timestamp);
      const lastEnd = timer.segments.length ? Date.parse(timer.segments.at(-1).end) : Date.parse(timer.startedAt);
      const session = { ...timer, endedAt: new Date(Math.max(timestamp, lastEnd, Date.parse(timer.startedAt))).toISOString() };
      delete session.status;
      delete session.resumedAt;
      state.sessions.push(normalizeSession(session, state));
      if (!timer.autoCollected && timer.kind !== 'break') {
        const segments = timer.segments.flatMap(splitAtMidnight);
        segments.forEach((segment, index) => state.entries.push(normalizeEntry({ ...segment, id: `${timer.id}:segment:${index}`, description: timer.goal || `${timer.kind[0].toUpperCase()}${timer.kind.slice(1)} session`, app: 'Rize Local', title: timer.goal, status: 'approved', source: 'timer', category: timer.kind, clientId: timer.clientId, projectId: timer.projectId, taskId: timer.taskId, billable: false }, state)));
      }
      state.timer = null;
    } else throw new Error(`Unknown command: ${type}`);
    return state;
  }
  throw new Error(`Unknown command: ${type}`);
}

function toCsv(state) {
  const clean = validateSnapshot(state);
  const quote = value => {
    let cell = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(cell) || /^[\t\r]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"', '""')}"`;
  };
  const names = kind => new Map(clean[kind].map(item => [item.id, item.name]));
  const clients = names('clients');
  const projects = names('projects');
  const tasks = names('tasks');
  const header = ['ID', 'Start', 'End', 'Duration seconds', 'Description', 'Application', 'Window title', 'Status', 'Source', 'Category', 'Client', 'Project', 'Task', 'Billable', 'Hourly rate USD', 'Amount USD'];
  const rows = clean.entries.map(entry => {
    const rate = clean.clients.find(client => client.id === entry.clientId)?.hourlyRate ?? 0;
    return [entry.id, entry.start, entry.end, entry.durationMs / 1000, entry.description, entry.app, entry.title, entry.status, entry.source, entry.category, clients.get(entry.clientId) ?? '', projects.get(entry.projectId) ?? '', tasks.get(entry.taskId) ?? '', entry.billable ? 'Yes' : 'No', rate, entry.billable ? (entry.durationMs / 3600000 * rate).toFixed(2) : '0.00'];
  });
  return '\uFEFF' + [header, ...rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

function createStore({ file, now = Date.now } = {}) {
  if (file !== undefined && (typeof file !== 'string' || !file)) throw new Error('Workspace file path must be a non-empty string.');
  const timestamp = () => {
    const result = Number(now());
    if (!Number.isFinite(result) || !Number.isFinite(new Date(result).getTime())) throw new Error('The current time is invalid.');
    return result;
  };
  let state = defaults();
  if (file && fs.existsSync(file)) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > 25 * 1024 * 1024) throw new Error('Workspace file exceeds 25 MiB.');
      state = validateSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
      // Never interpret application downtime as recorded work.
      if (state.timer?.status === 'running') throw new Error('A running timer snapshot must be paused before restoring it.');
    } catch (error) {
      throw new Error(`Cannot open workspace; the original file was preserved: ${error.message}`, { cause: error });
    }
  }
  function persist(next, at) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(checkpoint(next, at), null, 2), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, file);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {}
      throw new Error(`Could not save workspace: ${error.message}`, { cause: error });
    }
  }
  function commit(next, at) {
    const validated = validateSnapshot(next);
    persist(validated, at);
    state = validated;
    return copy(state);
  }
  return {
    getState() { return copy(state); },
    mutate(command) {
      const at = timestamp();
      return commit(applyCommand(copy(state), command, at), at);
    },
    upsertActivity(entries) {
      const draft = copy(state);
      for (const incoming of list(entries, 'Activity entries', 1000)) {
        object(incoming, 'Activity entry');
        const existingIndex = draft.entries.findIndex(entry => entry.id === incoming.id);
        if (existingIndex >= 0 && (draft.entries[existingIndex].status === 'approved' || draft.entries[existingIndex].source !== 'automatic')) continue;
        const safe = { ...incoming, source: 'automatic', status: 'pending' };
        for (const key of ['app', 'title', 'description']) if (typeof safe[key] === 'string') safe[key] = safe[key].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        const entry = normalizeEntry(safe, draft);
        if (existingIndex >= 0) draft.entries[existingIndex] = entry;
        else draft.entries.push(entry);
      }
      if (draft.timer && draft.settings.trackingEnabled) draft.timer.autoCollected = true;
      return commit(draft, timestamp());
    },
    mergeShared(records) {
      const draft = copy(state);
      const ordered = list(records, 'Shared records', 50000).map(record => {
        object(record, 'Shared record');
        const kind = choice(record.kind, ['clients', 'projects', 'tasks', 'entries', 'contracts', 'allocations', 'invoices', 'skills', 'routines', 'reports', 'context'], 'Shared kind');
        return { ...record, kind, id: id(record.id), deleted: boolean(record.deleted ?? false, 'Deleted flag') };
      });
      const localKinds = ['clients', 'projects', 'tasks', 'entries', 'contracts', 'allocations', 'invoices'];
      const incoming = ordered.filter(record => localKinds.includes(record.kind));
      const rank = record => localKinds.indexOf(record.kind);
      for (const record of incoming.filter(record => !record.deleted).sort((a, b) => rank(a) - rank(b))) {
        object(record.data, 'Shared record data');
        let data = { ...record.data, id: record.id };
        const items = ['contracts', 'allocations', 'invoices'].includes(record.kind) ? draft.business[record.kind] : draft[record.kind];
        const existing = items.find(item => item.id === record.id);
        if (record.kind === 'entries') {
          // Native window metadata and unreviewed activity never come from or get overwritten by team sync.
          if (existing?.status === 'pending') continue;
          const safe = { ...(existing ?? {}), ...data, status: 'approved', app: existing?.app ?? 'Cloud sync', title: existing?.title ?? '', source: ['manual', 'automatic', 'timer'].includes(data.source) ? data.source : existing?.source ?? 'manual' };
          const value = normalizeEntry(safe, draft);
          if (existing) items[items.indexOf(existing)] = value; else items.push(value);
        } else if (['clients', 'projects', 'tasks'].includes(record.kind)) {
          modifyEntity(draft, record.kind.slice(0, -1), data);
        } else {
          if (record.kind === 'invoices') data = validateBusiness({ ...draft.business, invoices: [data], nextInvoiceNumber: Math.max(draft.business.nextInvoiceNumber, (data.sequence ?? 0) + 1) }, draft).invoices[0];
          if (record.kind === 'invoices' && existing && existing.status !== 'draft') {
            const immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['status', 'payments', 'paidMinor', 'outstandingMinor', 'voidReason'].includes(key)));
            if (!isDeepStrictEqual(immutable(existing), immutable(data))) throw new Error('A synchronized sent invoice cannot change its frozen accounting fields.');
            if (data.status === 'draft') throw new Error('A synchronized sent invoice cannot become a draft.');
            if (existing.status === 'void' && data.status !== 'void') throw new Error('A synchronized void invoice cannot be reopened.');
            if (existing.payments.some(payment => !isDeepStrictEqual(payment, data.payments.find(item => item.id === payment.id)))) throw new Error('A synchronized invoice cannot remove or rewrite recorded payments.');
          }
          if (existing) items[items.indexOf(existing)] = data; else items.push(data);
        }
        if (!draft.sharedIds[record.kind].includes(record.id)) draft.sharedIds[record.kind].push(record.id);
      }
      for (const record of incoming.filter(record => record.deleted).sort((a, b) => rank(b) - rank(a))) {
        if (!draft.sharedIds[record.kind].includes(record.id)) continue;
        const items = ['contracts', 'allocations', 'invoices'].includes(record.kind) ? draft.business[record.kind] : draft[record.kind];
        const existing = items.find(item => item.id === record.id);
        if (!existing) { draft.sharedIds[record.kind] = draft.sharedIds[record.kind].filter(value => value !== record.id); continue; }
        if (record.kind === 'entries') {
          if (existing.status === 'pending') continue;
          if (draft.business.invoices.some(inv => inv.status !== 'void' && inv.lines.some(line => line.entryId === record.id))) continue;
        }
        if (['clients', 'projects', 'tasks'].includes(record.kind)) {
          const field = `${record.kind.slice(0, -1)}Id`;
          const dependents = [...draft.entries, ...draft.sessions, ...draft.projects, ...draft.tasks, ...draft.rules, ...draft.business.contracts, ...draft.business.allocations, ...(draft.timer ? [draft.timer] : [])];
          if (dependents.some(item => item[field] === record.id)) continue;
          deleteEntity(draft, record.kind.slice(0, -1), { id: record.id });
        } else if (record.kind === 'invoices') {
          // Accounting snapshots and invoice numbers remain an audit record even after remote deletion.
          continue;
        } else items.splice(items.indexOf(existing), 1);
        draft.sharedIds[record.kind] = draft.sharedIds[record.kind].filter(value => value !== record.id);
      }
      // Imported invoice sequences cannot make local numbers reusable.
      draft.business.nextInvoiceNumber = Math.max(draft.business.nextInvoiceNumber, ...draft.business.invoices.map(invoice => invoice.sequence + 1));
      return commit(draft, timestamp());
    },
    exportSnapshot() { return checkpoint(state, timestamp()); },
    importData(value) {
      let parsed = value;
      if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > 25 * 1024 * 1024) throw new Error('Workspace import exceeds 25 MiB.');
        try { parsed = JSON.parse(value); } catch { throw new Error('The selected file is not valid JSON.'); }
      }
      const validated = validateSnapshot(parsed);
      if (validated.timer?.status === 'running') throw new Error('Imported timers must be paused to avoid counting time since export.');
      return commit(validated, timestamp());
    },
    flush() { persist(state, timestamp()); return copy(state); },
  };
}

module.exports = { createStore, toCsv, validateSnapshot, splitAtMidnight };
