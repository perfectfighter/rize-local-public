'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore, validateSnapshot } = require('../desktop/store.cjs');
const { financialSummary, invoiceHtml, charge, validateInvoice, assertInvoiceTransition, assertInvoiceEntries } = require('../desktop/business.cjs');
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const run = (store, type, payload = {}) => store.mutate({ type, payload });
function fixture() { const store = createStore({ now: () => NOW }); run(store, 'workspace.create'); run(store, 'client.upsert', { id: 'c', name: 'Client', hourlyRate: 100 }); run(store, 'project.upsert', { id: 'p', name: 'Project', clientId: 'c' }); return store; }
function entry(store, overrides = {}) { return run(store, 'entry.upsert', { id: 'e', start: '2026-10-17T09:00:00.000Z', end: '2026-10-17T10:00:00.000Z', description: 'Development', clientId: 'c', projectId: 'p', billable: true, ...overrides }); }
const invoice = (store, overrides = {}) => run(store, 'invoice.create', { clientId: 'c', startDate: '2026-10-01', endDate: '2026-10-31', ...overrides }).business.invoices.at(-1);
const contract = (store, overrides = {}) => run(store, 'contract.upsert', { id: 'contract', clientId: 'c', projectId: 'p', type: 'hourly', hourlyRate: 100, costRate: 40, budgetHours: 10, currency: 'USD', startDate: '2026-10-01', endDate: '2026-10-31', ...overrides });

test('old schema 1 snapshots migrate business defaults and roundtrip labels/external IDs', () => {
  const store = fixture(); const old = store.exportSnapshot(); delete old.business; delete old.sharedIds; const clean = validateSnapshot(old); assert.equal(clean.business.nextInvoiceNumber, 1); assert.deepEqual(clean.business.invoices, []);
  run(store, 'label.upsert', { id: 'l', name: 'Design', keywords: 'Figma, design', color: '#ff00ff' }); entry(store, { labelIds: ['l'], externalId: 'calendar-123', externalProvider: 'ics', externalUrl: 'https://example.com/event' });
  const target = createStore(); target.importData(store.exportSnapshot()); assert.deepEqual(target.getState(), store.getState());
  assert.throws(() => entry(store, { labelIds: ['missing'] }), /label does not exist/);
});

test('money uses exact minor-unit rounding for fractional rates and zero/three-digit currencies', () => {
  assert.equal(charge(1800000, 0.29, 2), 15); assert.equal(charge(3600000, 1.005, 2), 101); assert.equal(charge(1800000, 123, 0), 62); assert.equal(charge(1800000, 0.001, 3), 1);
  const store = fixture(); run(store, 'client.upsert', { id: 'c', hourlyRate: 0.29 }); entry(store, { end: '2026-10-17T09:30:00.000Z' });
  assert.equal(invoice(store).totalMinor, 15);
});

test('invoice excludes pending, nonbillable, other-client, and out-of-range time', () => {
  const store = fixture(); entry(store); entry(store, { id: 'pending', status: 'pending' }); entry(store, { id: 'nonbillable', billable: false }); entry(store, { id: 'old', start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:00:00Z' });
  run(store, 'client.upsert', { id: 'other', name: 'Other' }); entry(store, { id: 'other', clientId: 'other', projectId: '' }); const inv = invoice(store);
  assert.deepEqual(inv.lines.map(l => l.entryId), ['e']); assert.equal(inv.totalMinor, 10000);
  assert.throws(() => invoice(store), /no uninvoiced approved billable/);
});

test('invoice discount then tax, payment dates and partial/full balances are consistent', () => {
  const store = fixture(); entry(store); const inv = invoice(store, { taxBps: 725, discountMinor: 1000, issueDate: '2026-10-17', paymentDays: 30 });
  assert.equal(inv.subtotalMinor, 10000); assert.equal(inv.taxMinor, 653); assert.equal(inv.totalMinor, 9653); assert.equal(inv.dueDate, '2026-11-16');
  run(store, 'invoice.markSent', { id: inv.id }); run(store, 'invoice.payment', { id: inv.id, amountMinor: 1000, date: '2026-10-18', reference: 'Bank transfer' });
  let saved = store.getState().business.invoices[0]; assert.equal(saved.status, 'sent'); assert.equal(saved.outstandingMinor, 8653);
  const before = store.getState(); assert.throws(() => run(store, 'invoice.payment', { id: inv.id, amountMinor: 9000 }), /exceed/); assert.deepEqual(store.getState(), before);
  run(store, 'invoice.payment', { id: inv.id, amountMinor: 8653 }); saved = store.getState().business.invoices[0]; assert.equal(saved.status, 'paid'); assert.equal(saved.paidMinor, 9653); assert.equal(saved.outstandingMinor, 0); assert.throws(() => run(store, 'invoice.void', { id: inv.id, reason: 'No' }), /Paid invoices/);
});

test('sent invoice freezes issuer/client/rates and can only receive payments or be voided', () => {
  const store = fixture(); run(store, 'business.profile.update', { name: 'Original Ltd', address: 'Original' }); run(store, 'business.clientTerms.upsert', { clientId: 'c', contact: 'Ada', address: 'Client address', currency: 'USD', paymentDays: 14 }); entry(store); const inv = invoice(store); run(store, 'invoice.markSent', { id: inv.id });
  run(store, 'business.profile.update', { name: 'Changed Ltd' }); run(store, 'client.upsert', { id: 'c', name: 'Renamed', hourlyRate: 200 }); const saved = store.getState().business.invoices[0]; assert.equal(saved.issuer.name, 'Original Ltd'); assert.equal(saved.clientName, 'Client'); assert.equal(saved.lines[0].rate, 100); assert.equal(saved.billTo.contact, 'Ada');
  assert.throws(() => run(store, 'invoice.update', { id: inv.id, notes: 'edit' }), /immutable/); assert.throws(() => entry(store, { description: 'alter invoiced source' }), /active invoice/); assert.throws(() => run(store, 'entry.delete', { id: 'e' }), /active invoice/);
});

test('voiding frees entries while preserving numbers; changed prefixes cannot reset sequence', () => {
  const store = fixture(); entry(store); const first = invoice(store); run(store, 'invoice.void', { id: first.id, reason: 'Reissue' }); run(store, 'business.profile.update', { invoicePrefix: 'NEW-' }); const second = invoice(store);
  assert.equal(first.number, 'INV-00001'); assert.equal(second.number, 'NEW-00002'); assert.equal(store.getState().business.nextInvoiceNumber, 3); assert.equal(store.getState().business.invoices[0].status, 'void');
});

test('draft update rebuilds allowed fields without changing reserved number or duplicating entry', () => {
  const store = fixture(); entry(store); const first = invoice(store); const state = run(store, 'invoice.update', { id: first.id, notes: 'Updated', taxBps: 500 });
  assert.equal(state.business.invoices[0].number, first.number); assert.equal(state.business.invoices[0].totalMinor, 10500); assert.equal(state.business.invoices[0].notes, 'Updated'); assert.equal(state.business.nextInvoiceNumber, 2);
});

test('retainer/hybrid charge included hours once, with immutable time allocation snapshots', () => {
  const store = fixture(); contract(store, { type: 'hybrid', retainerMinor: 10000, includedHours: 1.5 }); entry(store); entry(store, { id: 'e2', start: '2026-10-17T10:00:00Z', end: '2026-10-17T11:00:00Z' }); const inv = invoice(store);
  assert.equal(inv.totalMinor, 15000); assert.equal(inv.lines.filter(l => l.kind === 'retainer').length, 1); assert.equal(inv.lines.filter(l => l.entryId === 'e2').length, 2); assert.equal(new Set(inv.lines.filter(l => l.entryId).map(l => l.entryId)).size, 2);
  assert.equal(financialSummary(store.getState()).currencies[0].revenueMinor, 15000);
});

test('contract scope/date validation rejects ambiguity but allows project-specific overrides', () => {
  const store = fixture(); contract(store); const before = store.getState(); assert.throws(() => contract(store, { id: 'overlap' }), /cannot overlap/); assert.deepEqual(store.getState(), before);
  contract(store, { id: 'general', projectId: '', hourlyRate: 50 }); entry(store); assert.equal(invoice(store).totalMinor, 10000);
  assert.throws(() => contract(store, { id: 'bad', startDate: '2026-02-30' }), /valid YYYY/);
});

test('currencies remain separate and summary derives cost, profit and remaining budget', () => {
  const store = fixture(); contract(store); entry(store); run(store, 'client.upsert', { id: 'j', name: 'Japan', hourlyRate: 123 }); run(store, 'business.clientTerms.upsert', { clientId: 'j', currency: 'JPY' }); entry(store, { id: 'yen', clientId: 'j', projectId: '', end: '2026-10-17T09:30:00Z' }); const summary = financialSummary(store.getState());
  const usd = summary.currencies.find(c => c.currency === 'USD'), yen = summary.currencies.find(c => c.currency === 'JPY'); assert.equal(usd.revenueMinor, 10000); assert.equal(usd.costMinor, 4000); assert.equal(usd.profitMinor, 6000); assert.equal(yen.revenueMinor, 62); assert.equal(yen.currencyDigits, 0); assert.equal(summary.projects.find(p => p.projectId === 'p').budgetRemainingHours, 9); assert.equal(financialSummary(store.getState(), { startDate: '2026-11-01', endDate: '2026-11-30' }).currencies.length, 0);
});

test('invoice HTML escapes all editable fields and has no executable markup', () => {
  const store = fixture(); run(store, 'business.profile.update', { name: '<script>alert(1)</script>', paymentInstructions: '<img src=x onerror=alert(2)>' }); entry(store, { description: '</td><script>alert(3)</script>' }); const inv = invoice(store, { notes: '<iframe src="https://evil.example">' }); const html = invoiceHtml(inv);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(html.includes('&lt;iframe')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.ok(html.includes("default-src 'none'"));
});

test('forged amounts, currencies, number reuse and unsafe quantities fail atomically', () => {
  const store = fixture(); entry(store); invoice(store); const good = store.exportSnapshot();
  for (const mutate of [x => x.business.invoices[0].totalMinor++, x => x.business.invoices[0].lines[0].amountMinor++, x => x.business.nextInvoiceNumber = 1, x => x.business.invoices[0].currencyDigits = 3, x => x.business.invoices[0].taxBps = 0.5, x => x.business.invoices[0].payments.push({ id: 'x', amountMinor: 500, date: '2026-10-17' })]) { const bad = structuredClone(good); mutate(bad); assert.throws(() => store.importData(bad)); assert.deepEqual(store.getState(), good); }
  assert.throws(() => run(store, 'contract.upsert', { id: 'bad', clientId: 'c', type: 'hourly', startDate: '2026-10-01', currency: 'ZZZ' }), /supported ISO/);
});

test('allocation CSV-style imports are atomic and capacities/weeks are validated', () => {
  const store = fixture(); const allocation = { id: 'a', memberId: 'local-ada', memberName: 'Ada', projectId: 'p', week: '2026-10-19', hours: 20, capacityHours: 40 }; run(store, 'allocation.import', { allocations: [allocation] }); assert.equal(store.getState().business.allocations[0].hours, 20); const before = store.getState();
  assert.throws(() => run(store, 'allocation.import', { allocations: [{ ...allocation, id: 'good' }, { ...allocation, id: 'bad', week: '2026-10-20' }] }), /Monday/); assert.deepEqual(store.getState(), before); assert.throws(() => run(store, 'allocation.upsert', { ...allocation, capacityHours: 200 }), /Weekly capacity/);
});

test('labels regenerate from local rules and keyword matching without pretending to be AI', () => {
  const store = fixture(); run(store, 'label.upsert', { id: 'focus', name: 'Focus', keywords: ['code'] }); run(store, 'rule.upsert', { id: 'rule', name: 'Development', keyword: 'code', action: 'productive', clientId: 'c', projectId: 'p' }); entry(store, { clientId: '', projectId: '', app: 'Code', category: 'neutral' }); const state = run(store, 'entry.regenerate', { id: 'e' }); assert.equal(state.entries[0].clientId, 'c'); assert.equal(state.entries[0].category, 'productive'); assert.deepEqual(state.entries[0].labelIds, ['focus']); run(store, 'label.delete', { id: 'focus' }); assert.deepEqual(store.getState().entries[0].labelIds, []);
});

test('split and merge conserve milliseconds, tags and contiguous work with transactional rejection', () => {
  const store = fixture(); entry(store, { start: '2026-10-17T09:00:00.123Z', end: '2026-10-17T09:00:05.456Z' }); const before = store.getState(); assert.throws(() => run(store, 'entry.split', { id: 'e', at: before.entries[0].start }), /inside/); assert.deepEqual(store.getState(), before);
  let state = run(store, 'entry.split', { id: 'e', at: '2026-10-17T09:00:02.345Z' }); assert.equal(state.entries.reduce((n, e) => n + e.durationMs, 0), 5333); assert.ok(state.entries.every(e => e.clientId === 'c' && e.projectId === 'p')); state = run(store, 'entry.merge', { ids: state.entries.map(e => e.id) }); assert.equal(state.entries.length, 1); assert.equal(state.entries[0].durationMs, 5333); assert.equal(state.entries[0].start, before.entries[0].start); assert.equal(state.entries[0].end, before.entries[0].end);
});

test('merge rejects gaps, overlap and incompatible metadata; bulk does not alter time or source', () => {
  const store = fixture(); entry(store); entry(store, { id: 'e2', start: '2026-10-17T11:00:00Z', end: '2026-10-17T12:00:00Z' }); assert.throws(() => run(store, 'entry.merge', { ids: ['e', 'e2'] }), /contiguous/); entry(store, { id: 'e2', start: '2026-10-17T10:00:00Z', end: '2026-10-17T11:00:00Z', category: 'distracting' }); assert.throws(() => run(store, 'entry.merge', { ids: ['e', 'e2'] }), /same tags/);
  const before = store.getState(); assert.throws(() => run(store, 'entry.bulk', { ids: ['e', 'e2'], patch: { start: '2026-10-17T00:00:00Z' } }), /unsupported/); assert.deepEqual(store.getState(), before); const after = run(store, 'entry.bulk', { ids: ['e', 'e2'], patch: { billable: false, status: 'pending' } }); assert.ok(after.entries.every(e => !e.billable && e.status === 'pending')); assert.deepEqual(after.entries.map(e => [e.start, e.end]), before.entries.map(e => [e.start, e.end]));
});

test('advanced entry commands cannot change invoiced work', () => {
  const store = fixture(); entry(store); invoice(store);
  for (const [type, payload] of [['entry.split', { id: 'e', at: '2026-10-17T09:30:00Z' }], ['entry.bulk', { ids: ['e'], patch: { billable: false } }], ['entry.regenerate', { id: 'e' }]]) assert.throws(() => run(store, type, payload), /active invoice/);
});

test('team merge preserves local settings/timer/pending/raw metadata and integration IDs', () => {
  const store = fixture(); entry(store, { app: 'Private local app', title: 'Private local title', source: 'automatic' }); entry(store, { id: 'pending', status: 'pending', title: 'Sensitive unreviewed' }); run(store, 'timer.start', { goal: 'Do not reset' }); const before = store.getState();
  const merged = store.mergeShared([{ kind: 'entries', id: 'e', data: { ...before.entries[0], app: 'Remote forged', title: 'Remote forged', description: 'Shared approved update' }, version: 1 }, { kind: 'entries', id: 'pending', data: { ...before.entries[1], description: 'Overwrite' }, version: 1 }, { kind: 'tasks', id: 'remote-task', data: { name: 'Imported', clientId: 'c', projectId: 'p', keywords: [], done: true, externalProvider: 'linear', externalId: 'LIN-123', externalUrl: 'https://linear.app/task' }, version: 1 }]);
  assert.deepEqual(merged.settings, before.settings); assert.deepEqual(merged.timer, before.timer); assert.deepEqual(merged.entries.find(e => e.id === 'pending'), before.entries.find(e => e.id === 'pending')); assert.equal(merged.entries.find(e => e.id === 'e').title, 'Private local title'); assert.equal(merged.entries.find(e => e.id === 'e').description, 'Shared approved update'); assert.equal(merged.tasks[0].externalId, 'LIN-123'); assert.equal(merged.tasks[0].done, true);
});

test('team tombstones only delete known synchronized records and never pending/unrelated data', () => {
  const store = fixture(); entry(store, { id: 'local' }); store.mergeShared([{ kind: 'entries', id: 'remote', data: { start: '2026-10-17T11:00:00Z', end: '2026-10-17T12:00:00Z', description: 'Remote' }, version: 1 }]); const first = store.getState().entries.find(e => e.id === 'remote'); assert.equal(first.app, 'Cloud sync'); assert.equal(first.title, '');
  store.mergeShared([{ kind: 'entries', id: 'local', deleted: true, version: 2 }, { kind: 'entries', id: 'remote', deleted: true, version: 2 }, { kind: 'clients', id: 'c', deleted: true, version: 2 }]); assert.deepEqual(store.getState().entries.map(e => e.id), ['local']); assert.equal(store.getState().clients[0].id, 'c');
});

test('business state survives real atomic disk persistence', t => {
  const root = path.resolve(__dirname, '.business-fixtures'); fs.mkdirSync(root, { recursive: true }); const dir = fs.mkdtempSync(path.join(root, 'case-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const file = path.join(dir, 'workspace.json'); const source = fixture(); entry(source); invoice(source); const store = createStore({ file, now: () => NOW }); store.importData(source.exportSnapshot()); assert.deepEqual(createStore({ file, now: () => NOW }).getState(), source.getState());
});

test('break sessions retain history without creating calendar work', () => {
  let time = NOW; const store = createStore({ now: () => time }); run(store, 'workspace.create'); run(store, 'timer.start', { kind: 'break' }); time += 300000; const state = run(store, 'timer.stop'); assert.equal(state.entries.length, 0); assert.equal(state.sessions[0].kind, 'break'); assert.equal(state.sessions[0].elapsedMs, 300000);
});

test('workspace identity survives ordinary mutations and legacy migration but resets for a new workspace', () => {
  const store = fixture(); const original = store.getState().workspaceId; assert.ok(original); entry(store); assert.equal(store.getState().workspaceId, original); const old = store.exportSnapshot(); delete old.workspaceId; store.importData(old); const migrated = store.getState().workspaceId; assert.ok(migrated); assert.notEqual(migrated, original); run(store, 'settings.update', { displayName: 'Stable' }); assert.equal(store.getState().workspaceId, migrated); run(store, 'workspace.create'); assert.notEqual(store.getState().workspaceId, migrated);
});

test('member weekly capacity is consistent across projects and contradictory imports roll back', () => {
  const store = fixture(); run(store, 'project.upsert', { id: 'p2', name: 'Other', clientId: 'c' }); const a = { id: 'a', memberId: 'ada', memberName: 'Ada', projectId: 'p', week: '2026-10-19', hours: 20, capacityHours: 40 }; run(store, 'allocation.upsert', a); run(store, 'allocation.upsert', { ...a, id: 'b', projectId: 'p2', hours: 10, capacityHours: 32 }); assert.ok(store.getState().business.allocations.every(item => item.capacityHours === 32)); const before = store.getState(); assert.throws(() => run(store, 'allocation.import', { allocations: [{ ...a, capacityHours: 20 }, { ...a, id: 'b', projectId: 'p2', capacityHours: 30 }] }), /consistent/); assert.deepEqual(store.getState(), before);
});

test('fixed-period hybrid fee cannot be recharged through arbitrary ranges or late time invoices', () => {
  const store = fixture(); contract(store, { type: 'hybrid', retainerMinor: 10000, includedHours: 1.5 }); entry(store); const before = store.getState(); assert.throws(() => invoice(store, { startDate: '2026-10-17', endDate: '2026-10-17' }), /exact fixed contract/); assert.deepEqual(store.getState(), before); const first = invoice(store); assert.equal(first.totalMinor, 10000); run(store, 'invoice.markSent', { id: first.id }); entry(store, { id: 'late', start: '2026-10-18T09:00:00Z', end: '2026-10-18T10:00:00Z' }); const second = invoice(store); assert.equal(second.lines.filter(l => l.kind === 'retainer').length, 0); assert.equal(second.totalMinor, 5000); assert.equal(second.lines.reduce((n, l) => n + l.durationMs, 0), 3600000);
  assert.throws(() => contract(store, { id: 'open', projectId: '', type: 'retainer', endDate: '' }), /fixed end date/);
});

test('narrow financial reports do not reset fixed fees, allowances or contract budget consumption', () => {
  const store = fixture(); contract(store, { type: 'hybrid', retainerMinor: 10000, includedHours: 1, budgetHours: 5 }); entry(store); entry(store, { id: 'second', start: '2026-10-18T09:00:00Z', end: '2026-10-18T10:00:00Z' }); const day = financialSummary(store.getState(), { startDate: '2026-10-18', endDate: '2026-10-18' }); assert.equal(day.currencies[0].revenueMinor, 10000); assert.equal(day.projects[0].budgetRemainingHours, 3); const start = financialSummary(store.getState(), { startDate: '2026-10-01', endDate: '2026-10-01' }); assert.equal(start.currencies[0].revenueMinor, 10000); assert.equal(start.currencies[0].totalHours, 0); const full = financialSummary(store.getState()); assert.equal(full.currencies[0].revenueMinor, 20000);
});

test('receivables exclude drafts until marked sent and preserve immutable sync snapshots', () => {
  const store = fixture(); entry(store); const inv = invoice(store); let summary = financialSummary(store.getState()); assert.equal(summary.currencies[0].invoicedMinor, 0); run(store, 'invoice.markSent', { id: inv.id }); summary = financialSummary(store.getState()); assert.equal(summary.currencies[0].invoicedMinor, 10000); assert.equal(summary.currencies[0].outstandingMinor, 10000); const sent = store.getState().business.invoices[0]; const forged = structuredClone(sent); forged.notes = 'Remote rewrite'; assert.throws(() => store.mergeShared([{ kind: 'invoices', id: inv.id, data: forged, version: 2 }]), /frozen accounting/); assert.deepEqual(store.getState().business.invoices[0], sent);
});

test('pure invoice transition validator enforces identity, frozen amounts and append-only payments', () => {
  const store = fixture(); entry(store); const draft = invoice(store); assert.equal(assertInvoiceTransition(null, draft).id, draft.id); const changedIdentity = structuredClone(draft); changedIdentity.number = 'NEW-1'; assert.throws(() => assertInvoiceTransition(draft, changedIdentity), /identity and number/); assert.throws(() => assertInvoiceTransition(draft, null), /cannot be deleted/);
  run(store, 'invoice.markSent', { id: draft.id }); const sent = store.getState().business.invoices[0]; const changed = structuredClone(sent); changed.notes = 'Rewrite'; assert.throws(() => assertInvoiceTransition(sent, changed), /frozen/); assert.throws(() => assertInvoiceTransition(sent, draft), /become a draft/);
  run(store, 'invoice.payment', { id: draft.id, amountMinor: 1000, reference: 'First' }); const partial = store.getState().business.invoices[0]; assert.equal(assertInvoiceTransition(sent, partial).paidMinor, 1000); const rewrite = structuredClone(partial); rewrite.payments[0].reference = 'Rewrite'; assert.throws(() => assertInvoiceTransition(partial, rewrite), /cannot be removed, reordered, or rewritten/);
  const voided = { ...sent, status: 'void', voidReason: 'Canceled' }; assert.equal(assertInvoiceTransition(sent, voided).status, 'void'); assert.throws(() => assertInvoiceTransition(voided, sent), /reopened/); assert.throws(() => assertInvoiceTransition(voided, { ...voided, voidReason: 'Rewritten' }), /rewritten/);
});

test('pure source validator rejects invented, unreviewed, wrong-client and partial invoice time', () => {
  const store = fixture(); entry(store); const inv = invoice(store); const state = store.getState(); assert.equal(assertInvoiceEntries(inv, state).totalMinor, 10000); assert.throws(() => assertInvoiceEntries(inv, { ...state, clients: [] }), /client does not exist/);
  for (const entryChange of [{ status: 'pending' }, { billable: false }, { clientId: 'other' }]) { const bad = structuredClone(state); Object.assign(bad.entries[0], entryChange); assert.throws(() => assertInvoiceEntries(inv, bad), /approved billable/); }
  assert.throws(() => assertInvoiceEntries(inv, { ...state, entries: [] }), /approved billable/); assert.throws(() => assertInvoiceEntries({ ...inv, lines: [], subtotalMinor: 0, totalMinor: 0, outstandingMinor: 0 }, state), /approved billable source time/);
  const partial = structuredClone(inv); Object.assign(partial.lines[0], { durationMs: 1800000, quantityHours: 0.5, amountMinor: 5000 }); Object.assign(partial, { subtotalMinor: 5000, totalMinor: 5000, outstandingMinor: 5000 }); assert.equal(validateInvoice(partial).totalMinor, 5000); assert.throws(() => assertInvoiceEntries(partial, state), /complete source entry duration/); assert.throws(() => assertInvoiceEntries({ ...inv, startDate: '2026-11-01', endDate: '2026-11-30' }, state), /outside/);
});

test('validation rejects duplicate fixed contract fees and malformed zero-quantity time lines', () => {
  const store = fixture(); contract(store, { type: 'retainer', retainerMinor: 10000 }); entry(store); invoice(store); const before = store.getState(); const bad = store.exportSnapshot(); const duplicate = structuredClone(bad.business.invoices[0]); Object.assign(duplicate, { id: 'duplicate', number: 'INV-00002', sequence: 2, lines: duplicate.lines.filter(line => line.kind === 'retainer') }); bad.business.invoices.push(duplicate); bad.business.nextInvoiceNumber = 3; assert.throws(() => store.importData(bad), /fixed contract fee/); assert.deepEqual(store.getState(), before);
  const invalid = structuredClone(before.business.invoices[0]); const timeLine = invalid.lines.find(line => line.kind === 'time'); timeLine.durationMs = 0; timeLine.quantityHours = 0; assert.throws(() => validateInvoice(invalid), /positive duration/);
});
