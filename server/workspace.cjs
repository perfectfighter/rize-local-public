'use strict';

const { HttpError, cleanText } = require('./auth.cjs');
const { transaction } = require('./database.cjs');
const Business = require('../desktop/business.cjs');
const { isDeepStrictEqual } = require('node:util');
const KINDS = new Set(['clients', 'projects', 'tasks', 'entries', 'contracts', 'allocations', 'invoices', 'skills', 'routines', 'reports', 'context']);
const FINANCE = new Set(['contracts', 'invoices']);
const PERSONAL = new Set(['entries', 'skills', 'routines', 'reports', 'context']);
const identifier = value => cleanText(value, 'Record ID', 160);
const admin = member => ['owner', 'admin'].includes(member.role);
const dayFormatters = new Map();

function authorize(member, action) {
  if (!member) return false;
  if (action === 'read') return true;
  if (action === 'admin') return admin(member);
  if (action === 'write') return member.role !== 'viewer';
  if (action === 'finance') return member.role !== 'viewer' && (member.role === 'owner' || Boolean(member.finance));
  if (action === 'resourcing') return member.role !== 'viewer' && (member.role === 'owner' || Boolean(member.resourcing));
  return false;
}

function canRead(member, userId, record) {
  if (FINANCE.has(record.kind) && !authorize(member, 'finance')) return false;
  if (record.kind === 'allocations' && !authorize(member, 'resourcing')) return false;
  if (PERSONAL.has(record.kind) && !admin(member) && record.owner_id !== userId && record.ownerId !== userId) return false;
  return true;
}

function canWrite(member, userId, kind, existing) {
  if (!authorize(member, 'write')) return false;
  if (FINANCE.has(kind)) return authorize(member, 'finance');
  if (kind === 'allocations') return authorize(member, 'resourcing');
  if (admin(member)) return true;
  return PERSONAL.has(kind) && (!existing || existing.owner_id === userId || existing.ownerId === userId);
}

function canonical(row) {
  return { kind: row.kind, id: row.id, data: row.deleted ? null : JSON.parse(row.data), version: row.version, ownerId: row.owner_id, deleted: Boolean(row.deleted), updatedAt: new Date(row.updated_at).toISOString() };
}

function validJson(value, depth = 0) {
  if (depth > 12) throw new HttpError(400, 'Record nesting exceeds the limit.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') { cleanText(value, 'Record text', 32768, true); return; }
  if (Array.isArray(value)) { if (value.length > 2000) throw new HttpError(400, 'Record arrays are too large.'); value.forEach(item => validJson(item, depth + 1)); return; }
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Object.keys(value).length > 100) throw new HttpError(400, 'Record contains too many fields.');
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new HttpError(400, 'Invalid record field.');
      cleanText(key, 'Record field', 80);
      validJson(item, depth + 1);
    }
    return;
  }
  throw new HttpError(400, 'Records must contain valid JSON.');
}

const ENTRY_FIELDS = new Set(['id', 'start', 'end', 'durationMs', 'duration', 'description', 'status', 'source', 'category', 'clientId', 'projectId', 'taskId', 'billable', 'labelIds', 'externalId', 'externalSource']);
function validIso(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\d)T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const calendar = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === match[1];
}

function normalizeData(kind, id, value) {
  if (!KINDS.has(kind)) throw new HttpError(400, 'Unknown record kind.');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new HttpError(400, 'Record data must be an object.');
  validJson(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new HttpError(413, 'A record cannot exceed 128 KiB.', 'TOO_LARGE');
  if (value.id !== undefined && value.id !== id) throw new HttpError(400, 'Record IDs must match.');
  if (Object.hasOwn(value, 'ownerId') || Object.hasOwn(value, 'teamId')) throw new HttpError(400, 'Ownership is assigned by the server.');
  if (kind === 'entries') {
    if (Object.keys(value).some(key => !ENTRY_FIELDS.has(key))) throw new HttpError(400, 'Share only approved time descriptions and tags. Raw application, window, URL, and device metadata are forbidden.', 'PRIVATE_ACTIVITY');
    if (value.status !== 'approved') throw new HttpError(400, 'Only approved entries may be shared.', 'APPROVAL_REQUIRED');
    if (!validIso(value.start) || !validIso(value.end)) throw new HttpError(400, 'Entry timestamps must contain a timezone offset.');
    const durationMs = Date.parse(value.end) - Date.parse(value.start);
    if (durationMs <= 0 || durationMs > 7 * 86400000) throw new HttpError(400, 'Entry duration must be positive and no longer than seven days.');
    if (value.durationMs !== undefined && value.durationMs !== durationMs) throw new HttpError(400, 'Entry duration must match its interval.');
    if (value.duration !== undefined && value.duration !== durationMs / 1000) throw new HttpError(400, 'Entry seconds must match its interval.');
    if (typeof value.billable !== 'undefined' && typeof value.billable !== 'boolean') throw new HttpError(400, 'Billable must be a boolean.');
    for (const field of ['description', 'category', 'clientId', 'projectId', 'taskId', 'source', 'externalId', 'externalSource']) if (value[field] !== undefined) cleanText(value[field], field, field === 'description' ? 2000 : 160, true);
    if (value.labelIds !== undefined && (!Array.isArray(value.labelIds) || value.labelIds.length > 100 || value.labelIds.some(item => typeof item !== 'string' || item.length > 160))) throw new HttpError(400, 'Invalid entry label IDs.');
    return { ...value, id, start: new Date(value.start).toISOString(), end: new Date(value.end).toISOString(), durationMs };
  }
  if (kind === 'invoices') {
    try { return Business.validateInvoice({ ...value, id }); }
    catch { throw new HttpError(400, 'The invoice snapshot violates accounting constraints.', 'FINANCIAL_INVARIANT'); }
  }
  return { ...value, id };
}

function createWorkspace(db, teamId, user, member, now) {
  const find = (kind, id) => db.prepare('SELECT * FROM records WHERE team_id=? AND kind=? AND id=?').get(teamId, kind, id);
  const cursor = () => Number(db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM events WHERE team_id=?').get(teamId).cursor);
  function financialSnapshot() {
    const state = { clients: [], projects: [], tasks: [], entries: [], business: Business.defaultBusiness() };
    for (const row of db.prepare("SELECT kind,data FROM records WHERE team_id=? AND deleted=0 AND kind IN ('clients','projects','tasks','entries','contracts','allocations','invoices')").all(teamId)) {
      const target = ['contracts', 'allocations', 'invoices'].includes(row.kind) ? state.business[row.kind] : state[row.kind];
      target.push(JSON.parse(row.data));
    }
    state.business.nextInvoiceNumber = Math.max(1, ...state.business.invoices.map(invoice => Number(invoice.sequence) + 1));
    return state;
  }
  function captureAccounting(changes) {
    const invoices = db.prepare("SELECT id,data FROM records WHERE team_id=? AND kind='invoices' AND deleted=0").all(teamId).map(row => ({ id: row.id, data: JSON.parse(row.data) }));
    const entries = new Map();
    for (const change of changes.filter(item => item.kind === 'entries')) { const row = find('entries', change.id); if (row && !row.deleted) entries.set(change.id, JSON.parse(row.data)); }
    return { invoices, entries };
  }
  function validateAccounting(changes, before) {
    const state = financialSnapshot();
    try {
      state.business = Business.validateBusiness(state.business, state);
      for (const change of changes.filter(item => item.kind === 'invoices' && !item.deleted)) {
        const current = state.business.invoices.find(item => item.id === change.id);
        const previous = before.invoices.find(item => item.id === change.id)?.data;
        if (current && current.status !== 'void' && (!previous || previous.status === 'draft')) Business.assertInvoiceEntries(current, state);
      }
    } catch { throw new HttpError(400, 'Shared financial records violate invoice, contract, allocation, or source-time constraints. Review the change and retry.', 'FINANCIAL_INVARIANT'); }
    for (const [entryId, previousEntry] of before.entries) {
      const locked = before.invoices.some(previous => previous.data.status !== 'void' && previous.data.lines.some(line => line.entryId === entryId) && state.business.invoices.some(current => current.id === previous.id && current.status !== 'void' && current.lines.some(line => line.entryId === entryId)));
      if (!locked) continue;
      const currentRow = find('entries', entryId);
      if (!currentRow || currentRow.deleted || !isDeepStrictEqual(JSON.parse(currentRow.data), previousEntry)) throw new HttpError(409, 'Shared time reserved by an active invoice cannot change. Ask a finance member to void or revise the draft first.', 'BILLED_TIME_LOCKED');
    }
  }
  function getRecords(kind) {
    if (!KINDS.has(kind)) throw new HttpError(400, 'Unknown record kind.');
    return db.prepare('SELECT * FROM records WHERE team_id=? AND kind=? AND deleted=0 ORDER BY id').all(teamId, kind).filter(row => canRead(member, user.id, row)).map(canonical);
  }
  function putRecord(kind, id, data, baseVersion, deleted = false) {
    identifier(id);
    if (!KINDS.has(kind)) throw new HttpError(400, 'Unknown record kind.');
    const existing = find(kind, id);
    if (!canWrite(member, user.id, kind, existing)) throw new HttpError(403, 'Your team role does not permit changing this record.', 'FORBIDDEN');
    const expected = baseVersion ?? (existing ? existing.version : 0);
    if (!Number.isSafeInteger(expected) || expected < 0) throw new HttpError(400, 'Base version must be a nonnegative integer.');
    if ((existing?.version || 0) !== expected) throw new HttpError(409, 'Record changed on another device. Resolve the conflict before retrying.', 'CONFLICT');
    if (!existing && deleted) throw new HttpError(400, 'Cannot delete a record that does not exist.');
    if (!existing && db.prepare('SELECT COUNT(*) AS count FROM records WHERE team_id=?').get(teamId).count >= 50000) throw new HttpError(409, 'This team has reached its 50,000-record limit.', 'RECORD_LIMIT');
    const normalized = deleted ? {} : normalizeData(kind, id, data);
    if (kind === 'invoices') {
      try { Business.assertInvoiceTransition(existing && !existing.deleted ? JSON.parse(existing.data) : null, deleted ? null : normalized); }
      catch { throw new HttpError(409, 'Invoice accounting snapshots and payment history are immutable after sending. Void an invoice instead of deleting it.', 'INVOICE_IMMUTABLE'); }
    }
    const ownerId = existing?.owner_id || user.id;
    const version = (existing?.version || 0) + 1;
    const timestamp = now();
    const json = JSON.stringify(normalized);
    db.prepare(`INSERT INTO records(team_id,kind,id,owner_id,data,version,deleted,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(team_id,kind,id) DO UPDATE SET data=excluded.data,version=excluded.version,deleted=excluded.deleted,updated_at=excluded.updated_at`).run(teamId, kind, id, ownerId, json, version, Number(deleted), timestamp);
    db.prepare('INSERT INTO events(team_id,kind,id,owner_id,data,version,deleted,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(teamId, kind, id, ownerId, json, version, Number(deleted), timestamp);
    return canonical(find(kind, id));
  }
  function sync(changes) {
    if (!Array.isArray(changes) || changes.length > 500) throw new HttpError(400, 'Send at most 500 changes per sync.');
    const seen = new Set();
    for (const change of changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new HttpError(400, 'Invalid change.');
      const { kind, id, data, baseVersion, deleted = false } = change;
      identifier(id);
      if (!KINDS.has(kind) || !Number.isSafeInteger(baseVersion) || baseVersion < 0 || typeof deleted !== 'boolean') throw new HttpError(400, 'Changes require a kind, ID, baseVersion, and optional deleted boolean.');
      const key = `${kind}:${id}`;
      if (seen.has(key)) throw new HttpError(400, 'A record may appear only once in a sync batch.');
      seen.add(key);
      if (!canWrite(member, user.id, kind, find(kind, id))) throw new HttpError(403, 'Your role does not permit one or more changes.', 'FORBIDDEN');
      if (!deleted) normalizeData(kind, id, data);
    }
    return transaction(db, () => {
      const records = [], conflicts = [];
      const appliedChanges = [];
      const accountingBefore = captureAccounting(changes);
      for (const change of changes) {
        const row = find(change.kind, change.id);
        if ((row?.version || 0) !== change.baseVersion) {
          conflicts.push({ kind: change.kind, id: change.id, baseVersion: change.baseVersion, current: row && canRead(member, user.id, row) ? canonical(row) : null });
        } else { records.push(putRecord(change.kind, change.id, change.data, change.baseVersion, change.deleted ?? false)); appliedChanges.push(change); }
      }
      validateAccounting(appliedChanges, accountingBefore);
      return { cursor: cursor(), records, conflicts };
    });
  }
  function pull(since = 0) {
    if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'Sync cursor must be a nonnegative integer.');
    if (since > cursor()) throw new HttpError(409, 'Cursor belongs to another team or a newer database. Restart a full sync.', 'INVALID_CURSOR');
    const rows = db.prepare('SELECT * FROM events WHERE team_id=? AND cursor>? ORDER BY cursor LIMIT 1001').all(teamId, since);
    const page = rows.slice(0, 1000);
    // Returning the last scanned event also advances past records the member cannot see.
    return { cursor: page.at(-1)?.cursor ?? since, records: page.filter(row => canRead(member, user.id, row)).map(canonical), hasMore: rows.length > 1000 };
  }
  const kvGet = (namespace, key) => {
    cleanText(namespace, 'Namespace', 100); cleanText(key, 'Key', 300);
    const row = db.prepare('SELECT value FROM kv WHERE team_id=? AND namespace=? AND key=?').get(teamId, namespace, key);
    return row ? JSON.parse(row.value) : null;
  };
  const kvPut = (namespace, key, value) => {
    cleanText(namespace, 'Namespace', 100); cleanText(key, 'Key', 300); validJson(value);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 1024 * 1024) throw new HttpError(413, 'Stored service value exceeds 1 MiB.', 'TOO_LARGE');
    db.prepare('INSERT INTO kv(team_id,namespace,key,value) VALUES(?,?,?,?) ON CONFLICT(team_id,namespace,key) DO UPDATE SET value=excluded.value').run(teamId, namespace, key, json);
  };
  function mutateRecord(kind, id, data, baseVersion, deleted) {
    return transaction(db, () => { const changes = [{ kind, id, deleted }], before = captureAccounting(changes); const result = putRecord(kind, id, data, baseVersion, deleted); validateAccounting(changes, before); return result; });
  }
  return { getRecords, putRecord: (kind, id, data, baseVersion) => mutateRecord(kind, id, data, baseVersion, false), deleteRecord: (kind, id, baseVersion) => mutateRecord(kind, id, null, baseVersion, true), sync, pull, kvGet, kvPut, cursor };
}

function dayKey(ms, timezone) {
  if (!dayFormatters.has(timezone)) {
    if (dayFormatters.size >= 128) dayFormatters.delete(dayFormatters.keys().next().value);
    dayFormatters.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  const parts = dayFormatters.get(timezone).formatToParts(new Date(ms));
  const field = type => parts.find(item => item.type === type).value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

function splitDays(start, end, timezone) {
  const result = [];
  while (start < end) {
    const day = dayKey(start, timezone);
    if (dayKey(end - 1, timezone) === day) { result.push({ day, start, end }); break; }
    let lo = start + 1, hi = Math.min(end, start + 36 * 3600000);
    while (lo < hi) { const mid = lo + Math.floor((hi - lo) / 2); if (dayKey(mid, timezone) === day) lo = mid + 1; else hi = mid; }
    result.push({ day, start, end: lo }); start = lo;
  }
  return result;
}

function unionDuration(intervals) {
  const sorted = intervals.toSorted((a, b) => a.start - b.start);
  let duration = 0, end = -Infinity;
  for (const item of sorted) { if (item.end > end) { duration += item.end - Math.max(end, item.start); end = item.end; } }
  return duration;
}

function analytics(db, teamId, member, query, now) {
  const timezone = query.get('timezone') || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new HttpError(400, 'Unknown IANA timezone.'); }
  const date = value => { const parsed = new Date(`${value}T00:00:00Z`); return /^\d{4}-\d\d-\d\d$/.test(value || '') && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; };
  const startDate = query.get('startDate') || new Date(now() - 6 * 86400000).toISOString().slice(0, 10);
  const endDate = query.get('endDate') || new Date(now()).toISOString().slice(0, 10);
  if (!date(startDate) || !date(endDate) || startDate > endDate || Date.parse(endDate) - Date.parse(startDate) > 366 * 86400000) throw new HttpError(400, 'Analytics dates must form a range no longer than one year.');
  const grouped = new Map();
  for (const row of db.prepare("SELECT * FROM records WHERE team_id=? AND kind='entries' AND deleted=0").all(teamId)) {
    const entry = JSON.parse(row.data);
    for (const part of splitDays(Date.parse(entry.start), Date.parse(entry.end), timezone)) {
      if (part.day < startDate || part.day > endDate) continue;
      const key = `${row.owner_id}:${part.day}`;
      if (!grouped.has(key)) grouped.set(key, { userId: row.owner_id, date: part.day, intervals: [], billableIntervals: [], entryCount: 0 });
      const item = grouped.get(key); item.intervals.push(part); if (entry.billable) item.billableIntervals.push(part); item.entryCount++;
    }
  }
  const members = db.prepare('SELECT m.user_id,u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=?').all(teamId);
  const timesheet = [...grouped.values()].map(item => ({ userId: item.userId, date: item.date, durationMs: unionDuration(item.intervals), billableMs: unionDuration(item.billableIntervals), entryCount: item.entryCount })).sort((a, b) => a.date.localeCompare(b.date) || a.userId.localeCompare(b.userId));
  const days = Math.floor((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  const capacityHours = Number(query.get('capacityHours') ?? 40);
  if (!Number.isFinite(capacityHours) || capacityHours < 1 || capacityHours > 168) throw new HttpError(400, 'Weekly capacity must be between 1 and 168 hours.');
  const utilization = members.map(item => {
    const rows = timesheet.filter(row => row.userId === item.user_id);
    const durationMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
    const capacityMs = capacityHours * days / 7 * 3600000;
    return { userId: item.user_id, name: item.name, durationMs, billableMs: rows.reduce((sum, row) => sum + row.billableMs, 0), capacityMs, utilization: capacityMs ? durationMs / capacityMs : 0 };
  });
  // Aggregates have no descriptions, URLs, application names, or window titles.
  return { timezone, startDate, endDate, timesheet, utilization, totals: { durationMs: timesheet.reduce((sum, row) => sum + row.durationMs, 0), billableMs: timesheet.reduce((sum, row) => sum + row.billableMs, 0) }, capacityBasis: 'Weekly capacity prorated across calendar days; overlapping entries count once per member.' };
}

module.exports = { KINDS, authorize, canRead, canWrite, canonical, normalizeData, createWorkspace, analytics, splitDays };
