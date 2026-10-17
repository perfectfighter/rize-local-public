'use strict';

const {
  randomUUID
} = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const clone = value => structuredClone(value);
const obj = (v, n) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new Error(`${n} must be an object.`);
  return v;
};
const txt = (v, n, max = 2000, required = false) => {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new Error(`${n} must be valid text.`);
  const t = v.trim();
  if (required && !t) throw new Error(`${n} is required.`);
  return t;
};
const identifier = (v, n = 'ID') => txt(v, n, 160, true);
const num = (v, n, min = 0, max = 1e12) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${n} must be between ${min} and ${max}.`);
  return v;
};
const integer = (v, n, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  num(v, n, min, max);
  if (!Number.isSafeInteger(v)) throw new Error(`${n} must be an integer.`);
  return v;
};
const arr = (v, n, max = 50000) => {
  if (!Array.isArray(v) || v.length > max) throw new Error(`${n} must be an array of at most ${max} items.`);
  return v;
};
const unique = (items, name) => {
  const ids = new Set();
  for (const i of items) {
    if (ids.has(i.id)) throw new Error(`Duplicate ${name} ID.`);
    ids.add(i.id);
  }
  return items;
};
const date = (v, n = 'Date') => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw new Error(`${n} must be a valid YYYY-MM-DD date.`);
  return v;
};
const optionalDate = (v, n) => v ? date(v, n) : '';
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));
function currency(v = 'USD') {
  if (typeof v !== 'string' || !supportedCurrencies.has(v)) throw new Error('Choose a supported ISO currency.');
  return v;
}
const digits = code => new Intl.NumberFormat('en', {
  style: 'currency',
  currency: currency(code)
}).resolvedOptions().maximumFractionDigits;
function rate(v, name = 'Hourly rate') {
  num(v, name, 0, 1000000);
  if (Math.abs(v * 1e6 - Math.round(v * 1e6)) > 0.0001) throw new Error(`${name} supports at most six decimal places.`);
  return v;
}
function roundedRatio(n, d) {
  if (d <= 0n || n < 0n) throw new Error('Invalid money calculation.');
  const value = (n + d / 2n) / d;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Money amount exceeds safe limits.');
  return Number(value);
}
function charge(durationMs, hourlyRate, currencyDigits) {
  return roundedRatio(BigInt(Math.round(hourlyRate * 1e6)) * BigInt(Math.round(durationMs)) * 10n ** BigInt(currencyDigits), 3600000000000n);
}
function amountForHours(hours, hourlyRate, currencyDigits) {
  return charge(Math.round(hours * 3600000), hourlyRate, currencyDigits);
}
function reference(id, items, name, required = false) {
  const value = txt(id ?? '', name, 160, required);
  if (value && !items.some(i => i.id === value)) throw new Error(`${name} does not exist.`);
  return value;
}
function period(start, end) {
  date(start, 'Start date');
  date(end, 'End date');
  if (end < start) throw new Error('End date must follow start date.');
  return {
    startDate: start,
    endDate: end
  };
}
function defaultBusiness() {
  return {
    profile: {
      name: '',
      address: '',
      email: '',
      paymentInstructions: '',
      invoicePrefix: 'INV-'
    },
    clientTerms: [],
    contracts: [],
    invoices: [],
    allocations: [],
    labels: [],
    nextInvoiceNumber: 1
  };
}
function profile(v) {
  obj(v, 'Business profile');
  return {
    name: txt(v.name ?? '', 'Business name', 200),
    address: txt(v.address ?? '', 'Business address'),
    email: txt(v.email ?? '', 'Business email', 320),
    paymentInstructions: txt(v.paymentInstructions ?? '', 'Payment instructions', 4000),
    invoicePrefix: txt(v.invoicePrefix ?? 'INV-', 'Invoice prefix', 30, true)
  };
}
function terms(v, state) {
  obj(v, 'Client terms');
  return {
    id: identifier(v.id),
    clientId: reference(v.clientId, state.clients, 'Client', true),
    contact: txt(v.contact ?? '', 'Contact', 200),
    email: txt(v.email ?? '', 'Email', 320),
    address: txt(v.address ?? '', 'Address'),
    currency: currency(v.currency ?? 'USD'),
    paymentDays: integer(v.paymentDays ?? 30, 'Payment days', 0, 365)
  };
}
function contract(v, state) {
  obj(v, 'Contract');
  const clientId = reference(v.clientId, state.clients, 'Client', true);
  const projectId = reference(v.projectId ?? '', state.projects, 'Project');
  if (projectId && state.projects.find(i => i.id === projectId).clientId !== clientId) throw new Error('Contract project must belong to the selected client.');
  if (!['hourly', 'retainer', 'hybrid'].includes(v.type)) throw new Error('Contract type must be hourly, retainer, or hybrid.');
  const result = {
    id: identifier(v.id),
    clientId,
    projectId,
    type: v.type,
    hourlyRate: rate(v.hourlyRate ?? 0),
    retainerMinor: integer(v.retainerMinor ?? 0, 'Retainer amount'),
    includedHours: num(v.includedHours ?? 0, 'Included hours', 0, 100000),
    budgetHours: num(v.budgetHours ?? 0, 'Budget hours', 0, 1000000),
    costRate: rate(v.costRate ?? 0, 'Cost rate'),
    startDate: date(v.startDate, 'Contract start'),
    endDate: optionalDate(v.endDate, 'Contract end'),
    currency: currency(v.currency ?? 'USD')
  };
  if (result.endDate && result.endDate < result.startDate) throw new Error('Contract end must follow start.');
  if (result.type !== 'hourly' && !result.endDate) throw new Error('Retainer and hybrid contracts need a fixed end date.');
  return result;
}
function allocation(v, state) {
  obj(v, 'Allocation');
  const week = date(v.week, 'Allocation week');
  if (new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) throw new Error('Allocation week must be a Monday.');
  return {
    id: identifier(v.id),
    memberId: identifier(v.memberId),
    memberName: txt(v.memberName, 'Member name', 200, true),
    projectId: reference(v.projectId, state.projects, 'Project', true),
    week,
    hours: num(v.hours, 'Allocated hours', 0, 168),
    capacityHours: num(v.capacityHours ?? 40, 'Weekly capacity', 0, 168)
  };
}
function label(v) {
  obj(v, 'Label');
  const keys = typeof v.keywords === 'string' ? v.keywords.split(',') : arr(v.keywords ?? [], 'Label keywords', 100);
  const color = txt(v.color ?? '#7660bd', 'Label color', 7);
  if (!/^#[a-fA-F0-9]{6}$/.test(color)) throw new Error('Label color must be a six-digit hex color.');
  return {
    id: identifier(v.id),
    name: txt(v.name, 'Label name', 200, true),
    color,
    keywords: [...new Set(keys.map(k => txt(k, 'Label keyword', 120)).filter(Boolean))]
  };
}
function invoiceTotals(lines, taxBps, discountMinor) {
  const subtotalMinor = lines.reduce((n, line) => n + line.amountMinor, 0);
  integer(subtotalMinor, 'Subtotal');
  if (discountMinor > subtotalMinor) throw new Error('Discount cannot exceed subtotal.');
  const taxable = subtotalMinor - discountMinor;
  const taxMinor = roundedRatio(BigInt(taxable) * BigInt(taxBps), 10000n);
  const totalMinor = integer(taxable + taxMinor, 'Invoice total');
  return {
    subtotalMinor,
    taxMinor,
    totalMinor
  };
}
function validateInvoice(v) {
  obj(v, 'Invoice');
  const code = currency(v.currency);
  const currencyDigits = digits(code);
  if (v.currencyDigits !== currencyDigits) throw new Error('Invoice currency precision is invalid.');
  if (!['draft', 'sent', 'paid', 'void'].includes(v.status)) throw new Error('Invoice status is invalid.');
  const lines = unique(arr(v.lines, 'Invoice lines', 50000).map(raw => {
    obj(raw, 'Invoice line');
    const entryId = txt(raw.entryId ?? '', 'Entry ID', 160);
    const quantityHours = num(raw.quantityHours, 'Quantity hours', 0, 1000000);
    const durationMs = raw.durationMs === undefined ? Math.round(quantityHours * 3600000) : integer(raw.durationMs, 'Line duration');
    const r = rate(raw.rate);
    const amountMinor = integer(raw.amountMinor, 'Line amount');
    const kind = raw.kind ?? 'time';
    if (!['time', 'retainer'].includes(kind)) throw new Error('Invoice line type is invalid.');
    if (kind === 'time' && (!entryId || durationMs <= 0)) throw new Error('Time invoice lines need a source entry and positive duration.');
    if (kind === 'retainer' && (entryId || durationMs !== 0 || quantityHours !== 0 || r !== 0 || !raw.contractId)) throw new Error('Retainer invoice lines need a contract and no time quantity.');
    if (kind === 'time' && amountMinor !== charge(durationMs, r, currencyDigits)) throw new Error('Invoice line amount does not match its time and rate.');
    if (kind === 'time' && Math.abs(quantityHours - durationMs / 3600000) > 1e-9) throw new Error('Invoice hours do not match duration.');
    return {
      id: identifier(raw.id),
      entryId,
      contractId: txt(raw.contractId ?? '', 'Contract ID', 160),
      description: txt(raw.description, 'Line description', 2000),
      kind,
      quantityHours,
      durationMs,
      rate: r,
      amountMinor
    };
  }), 'invoice line');
  const taxBps = integer(v.taxBps ?? 0, 'Tax basis points', 0, 10000);
  const discountMinor = integer(v.discountMinor ?? 0, 'Discount');
  const totals = invoiceTotals(lines, taxBps, discountMinor);
  for (const k of ['subtotalMinor', 'taxMinor', 'totalMinor']) if (v[k] !== totals[k]) throw new Error(`Invoice ${k} does not match its line items.`);
  const issueDate = date(v.issueDate, 'Issue date'),
    dueDate = date(v.dueDate, 'Due date');
  if (dueDate < issueDate) throw new Error('Due date cannot precede issue date.');
  const payments = unique(arr(v.payments ?? [], 'Payments', 10000).map(p => ({
    id: identifier(p.id),
    amountMinor: integer(p.amountMinor, 'Payment amount', 1),
    date: date(p.date, 'Payment date'),
    reference: txt(p.reference ?? '', 'Payment reference', 300)
  })), 'payment');
  const paidMinor = integer(payments.reduce((n, p) => n + p.amountMinor, 0), 'Paid amount');
  if (paidMinor > totals.totalMinor) throw new Error('Payments cannot exceed invoice total.');
  if (paidMinor !== v.paidMinor || v.outstandingMinor !== totals.totalMinor - paidMinor) throw new Error('Invoice payment balance is invalid.');
  if (v.status === 'draft' && paidMinor) throw new Error('Draft invoices cannot contain payments.');
  if (v.status === 'paid' && paidMinor !== totals.totalMinor) throw new Error('Paid invoice must be paid in full.');
  if (v.status === 'sent' && paidMinor === totals.totalMinor) throw new Error('A fully settled invoice must have paid status.');
  if (v.status === 'void' && paidMinor) throw new Error('Paid invoices cannot be voided.');
  const selection = period(v.startDate, v.endDate);
  const issuer = profile(v.issuer);
  const billTo = {
    contact: txt(v.billTo?.contact ?? '', 'Bill-to contact', 200),
    email: txt(v.billTo?.email ?? '', 'Bill-to email', 320),
    address: txt(v.billTo?.address ?? '', 'Bill-to address')
  };
  return {
    id: identifier(v.id),
    number: txt(v.number, 'Invoice number', 80, true),
    sequence: integer(v.sequence, 'Invoice sequence', 1),
    clientId: identifier(v.clientId),
    clientName: txt(v.clientName, 'Client name', 200, true),
    billTo,
    issuer,
    currency: code,
    currencyDigits,
    ...selection,
    issueDate,
    dueDate,
    paymentDays: integer(v.paymentDays ?? 30, 'Payment days', 0, 365),
    status: v.status,
    lines,
    subtotalMinor: totals.subtotalMinor,
    taxBps,
    taxMinor: totals.taxMinor,
    discountMinor,
    totalMinor: totals.totalMinor,
    payments,
    paidMinor,
    outstandingMinor: totals.totalMinor - paidMinor,
    notes: txt(v.notes ?? '', 'Invoice notes', 4000),
    paymentInstructions: txt(v.paymentInstructions ?? '', 'Payment instructions', 4000),
    voidReason: txt(v.voidReason ?? '', 'Void reason', 2000, v.status === 'void')
  };
}

function assertInvoiceTransition(previous, next) {
  if (!previous) return next ? validateInvoice(next) : null;
  if (!next) throw new Error('Invoice snapshots cannot be deleted. Void the invoice to preserve its number and history.');
  const before = validateInvoice(previous), after = validateInvoice(next);
  if (before.id !== after.id || before.number !== after.number || before.sequence !== after.sequence) throw new Error('Invoice identity and number cannot change.');
  if (before.status === 'draft') return after;
  const frozen = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['status', 'payments', 'paidMinor', 'outstandingMinor', 'voidReason'].includes(key)));
  if (!isDeepStrictEqual(frozen(before), frozen(after))) throw new Error('A sent invoice cannot change its frozen accounting fields.');
  if (after.status === 'draft') throw new Error('A sent invoice cannot become a draft.');
  if (before.status === 'void' && (after.status !== 'void' || before.voidReason !== after.voidReason)) throw new Error('A void invoice cannot be reopened or rewritten.');
  if (before.payments.some((payment, index) => !isDeepStrictEqual(payment, after.payments[index]))) throw new Error('Recorded invoice payments cannot be removed, reordered, or rewritten.');
  return after;
}

function assertInvoiceEntries(value, state) {
  const invoice = validateInvoice(value);
  const durations = new Map();
  for (const line of invoice.lines) {
    if (line.kind !== 'time') continue;
    const entry = state.entries.find(item => item.id === line.entryId);
    if (!entry || entry.status !== 'approved' || !entry.billable || entry.clientId !== invoice.clientId) throw new Error('Invoice time must come from approved billable entries for its client.');
    if (!inPeriod(entry, invoice.startDate, invoice.endDate)) throw new Error('Invoice time falls outside its selected date range.');
    durations.set(entry.id, (durations.get(entry.id) ?? 0) + line.durationMs);
  }
  if (!durations.size) throw new Error('An invoice needs approved billable source time.');
  for (const [entryId, duration] of durations) if (duration !== state.entries.find(item => item.id === entryId).durationMs) throw new Error('Invoice time quantities must equal the complete source entry duration.');
  return invoice;
}
function validateBusiness(value, state) {
  const v = value === undefined ? defaultBusiness() : obj(value, 'Business data');
  const base = defaultBusiness();
  const result = {
    profile: profile(v.profile ?? base.profile),
    clientTerms: unique(arr(v.clientTerms ?? [], 'Client terms', 2000).map(x => terms(x, state)), 'client terms'),
    contracts: unique(arr(v.contracts ?? [], 'Contracts', 10000).map(x => contract(x, state)), 'contract'),
    invoices: unique(arr(v.invoices ?? [], 'Invoices', 50000).map(validateInvoice), 'invoice'),
    allocations: unique(arr(v.allocations ?? [], 'Allocations', 50000).map(x => allocation(x, state)), 'allocation'),
    labels: unique(arr(v.labels ?? [], 'Labels', 5000).map(label), 'label'),
    nextInvoiceNumber: integer(v.nextInvoiceNumber ?? 1, 'Next invoice number', 1)
  };
  const capacities = new Map(),
    allocationKeys = new Set();
  for (const a of result.allocations) {
    const key = `${a.memberId}:${a.week}`;
    if (capacities.has(key) && capacities.get(key) !== a.capacityHours) throw new Error('A member must have one consistent weekly capacity.');
    capacities.set(key, a.capacityHours);
    const projectKey = `${key}:${a.projectId}`;
    if (allocationKeys.has(projectKey)) throw new Error('Use one allocation per member, project, and week.');
    allocationKeys.add(projectKey);
  }
  if (new Set(result.clientTerms.map(t => t.clientId)).size !== result.clientTerms.length) throw new Error('Only one set of payment terms is allowed per client.');
  const numbers = new Set(),
    sequences = new Set(),
    reserved = new Set(),
    retainedPeriods = new Set();
  for (const inv of result.invoices) {
    if (numbers.has(inv.number) || sequences.has(inv.sequence)) throw new Error('Invoice numbers cannot be reused.');
    numbers.add(inv.number);
    sequences.add(inv.sequence);
    if (inv.sequence >= result.nextInvoiceNumber) throw new Error('Next invoice number must exceed every issued number.');
    if (inv.status !== 'void') {
      for (const line of inv.lines.filter(item => item.kind === 'retainer')) {
        const periodKey = JSON.stringify([line.contractId, inv.startDate, inv.endDate]);
        if (retainedPeriods.has(periodKey)) throw new Error('A fixed contract fee cannot appear on multiple active invoices for its period.');
        retainedPeriods.add(periodKey);
      }
      const invoiceEntries = new Set(inv.lines.map(l => l.entryId).filter(Boolean));
      for (const entryId of invoiceEntries) {
        if (reserved.has(entryId)) throw new Error('A time entry cannot appear on multiple active invoices.');
        reserved.add(entryId);
      }
    }
  }
  for (let i = 0; i < result.contracts.length; i++) for (let j = i + 1; j < result.contracts.length; j++) {
    const a = result.contracts[i],
      b = result.contracts[j];
    if (a.clientId === b.clientId && a.projectId === b.projectId && a.startDate <= (b.endDate || '9999-12-31') && b.startDate <= (a.endDate || '9999-12-31')) throw new Error('Contracts for the same scope cannot overlap.');
  }
  return result;
}
const inPeriod = (entry, start, end) => entry.start.slice(0, 10) >= start && entry.start.slice(0, 10) <= end;
function contractFor(state, entry) {
  const day = entry.start.slice(0, 10);
  const all = state.business.contracts.filter(c => c.clientId === entry.clientId && (!c.projectId || c.projectId === entry.projectId) && c.startDate <= day && (!c.endDate || c.endDate >= day));
  return all.find(c => c.projectId) || all[0];
}
function invoiceDraft(state, payload, now, previous) {
  const business = state.business,
    client = state.clients.find(c => c.id === payload.clientId);
  if (!client) throw new Error('Select an existing client.');
  const selection = period(payload.startDate, payload.endDate);
  const clientTerms = business.clientTerms.find(t => t.clientId === client.id);
  const code = currency(payload.currency ?? clientTerms?.currency ?? 'USD');
  const precision = digits(code);
  const taxBps = integer(payload.taxBps ?? 0, 'Tax basis points', 0, 10000);
  const discountMinor = integer(payload.discountMinor ?? 0, 'Discount');
  const occupied = new Set(business.invoices.filter(i => i.id !== previous?.id && i.status !== 'void').flatMap(i => i.lines.map(l => l.entryId)).filter(Boolean));
  const entries = state.entries.filter(e => e.clientId === client.id && e.status === 'approved' && e.billable && inPeriod(e, selection.startDate, selection.endDate) && !occupied.has(e.id)).sort((a, b) => a.start.localeCompare(b.start));
  const lines = [],
    includedUsed = new Map(),
    retainerAdded = new Set();
  for (const inv of business.invoices.filter(i => i.id !== previous?.id && i.status !== 'void')) for (const line of inv.lines) if (line.contractId && line.kind === 'time') includedUsed.set(line.contractId, (includedUsed.get(line.contractId) ?? 0) + line.durationMs);
  for (const e of entries) {
    const c = contractFor(state, e);
    if (c && c.currency !== code) throw new Error('Selected entries use a contract in another currency. Create a separate invoice.');
    let r = c?.hourlyRate ?? client.hourlyRate;
    if (c?.type === 'retainer' || c?.type === 'hybrid') {
      if (selection.startDate !== c.startDate || selection.endDate !== c.endDate) throw new Error('Retainer and hybrid invoices must use the exact fixed contract start and end dates.');
      if (!retainerAdded.has(c.id)) {
        const duplicate = business.invoices.some(inv => inv.id !== previous?.id && inv.status !== 'void' && inv.lines.some(l => l.id === `retainer:${c.id}:${selection.startDate}:${selection.endDate}`));
        if (!duplicate) lines.push({
          id: `retainer:${c.id}:${selection.startDate}:${selection.endDate}`,
          entryId: '',
          contractId: c.id,
          description: `${c.type === 'hybrid' ? 'Hybrid' : 'Retainer'} fee (${selection.startDate} – ${selection.endDate})`,
          kind: 'retainer',
          quantityHours: 0,
          durationMs: 0,
          rate: 0,
          amountMinor: c.retainerMinor
        });
        retainerAdded.add(c.id);
      }
      if (c.type === 'retainer') r = 0;
    }
    let durationMs = e.durationMs;
    if (c?.type === 'hybrid') {
      const used = includedUsed.get(c.id) ?? 0;
      const included = Math.max(0, Math.round(c.includedHours * 3600000) - used);
      includedUsed.set(c.id, used + durationMs);
      const chargeable = Math.max(0, durationMs - included);
      if (chargeable !== durationMs) {
        const includedDuration = durationMs - chargeable;
        lines.push({
          id: `${e.id}:included`,
          entryId: e.id,
          contractId: c?.id ?? '',
          description: `${e.description || 'Tracked time'} (included in retainer)`,
          kind: 'time',
          quantityHours: includedDuration / 3600000,
          durationMs: includedDuration,
          rate: 0,
          amountMinor: 0
        });
        durationMs = chargeable;
      }
    }
    if (durationMs || !lines.some(l => l.entryId === e.id)) lines.push({
      id: `${e.id}:time`,
      entryId: e.id,
      contractId: c?.id ?? '',
      description: e.description || 'Tracked time',
      kind: 'time',
      quantityHours: durationMs / 3600000,
      durationMs,
      rate: r,
      amountMinor: charge(durationMs, r, precision)
    });
  }
  if (!lines.length) throw new Error('There are no uninvoiced approved billable entries in this date range.');
  const totals = invoiceTotals(lines, taxBps, discountMinor);
  const issueDate = date(payload.issueDate ?? new Date(now).toISOString().slice(0, 10), 'Issue date');
  const paymentDays = integer(payload.paymentDays ?? clientTerms?.paymentDays ?? 30, 'Payment days', 0, 365);
  const due = new Date(`${issueDate}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + paymentDays);
  const sequence = previous?.sequence ?? business.nextInvoiceNumber;
  return {
    id: previous?.id ?? randomUUID(),
    number: previous?.number ?? `${business.profile.invoicePrefix}${String(sequence).padStart(5, '0')}`,
    sequence,
    clientId: client.id,
    clientName: client.name,
    billTo: {
      contact: clientTerms?.contact ?? '',
      email: clientTerms?.email ?? '',
      address: clientTerms?.address ?? ''
    },
    issuer: clone(business.profile),
    currency: code,
    currencyDigits: precision,
    ...selection,
    issueDate,
    dueDate: due.toISOString().slice(0, 10),
    paymentDays,
    status: 'draft',
    lines,
    ...totals,
    taxBps,
    discountMinor,
    payments: [],
    paidMinor: 0,
    outstandingMinor: totals.totalMinor,
    notes: txt(payload.notes ?? '', 'Invoice notes', 4000),
    paymentInstructions: business.profile.paymentInstructions,
    voidReason: ''
  };
}
function applyBusinessCommand(state, command, now) {
  const type = command.type,
    p = obj(command.payload ?? {}, 'Business command');
  state.business ??= defaultBusiness();
  const b = state.business;
  if (type === 'allocation.import') {
    const incoming = unique(arr(p.allocations, 'Allocation import', 10000).map(item => allocation({
      ...item,
      id: item.id || b.allocations.find(a => a.memberId === item.memberId && a.projectId === item.projectId && a.week === item.week)?.id || randomUUID()
    }, state)), 'allocation');
    const capacities = new Map();
    for (const item of incoming) {
      const key = `${item.memberId}:${item.week}`;
      if (capacities.has(key) && capacities.get(key) !== item.capacityHours) throw new Error('Imported member capacity must be consistent for each week.');
      capacities.set(key, item.capacityHours);
    }
    for (const item of incoming) {
      const index = b.allocations.findIndex(a => a.id === item.id);
      if (index < 0) b.allocations.push(item);else b.allocations[index] = item;
      for (const peer of b.allocations) if (peer.memberId === item.memberId && peer.week === item.week) peer.capacityHours = item.capacityHours;
    }
    return state;
  }
  if (type === 'business.profile.update') {
    b.profile = profile({
      ...b.profile,
      ...p
    });
    return state;
  }
  const match = /^(business\.clientTerms|contract|allocation|label)\.(upsert|delete)$/.exec(type);
  if (match) {
    const kind = {
      'business.clientTerms': 'clientTerms',
      contract: 'contracts',
      allocation: 'allocations',
      label: 'labels'
    }[match[1]];
    if (match[2] === 'delete') {
      const target = identifier(p.id);
      if (!b[kind].some(i => i.id === target)) throw new Error('The business record does not exist.');
      b[kind] = b[kind].filter(i => i.id !== target);
      if (kind === 'labels') state.entries.forEach(e => {
        e.labelIds = (e.labelIds ?? []).filter(i => i !== target);
      });
      return state;
    }
    const target = p.id ? identifier(p.id) : (kind === 'clientTerms' ? b.clientTerms.find(t => t.clientId === p.clientId)?.id : '') || randomUUID();
    const previous = b[kind].find(i => i.id === target);
    const value = {
      ...previous,
      ...p,
      id: target
    };
    const fn = {
      clientTerms: terms,
      contracts: contract,
      allocations: allocation,
      labels: label
    }[kind];
    const normalized = fn(value, state);
    if (kind === 'allocations') for (const peer of b.allocations) if (peer.memberId === normalized.memberId && peer.week === normalized.week) peer.capacityHours = normalized.capacityHours;
    const index = b[kind].findIndex(i => i.id === target);
    if (index < 0) b[kind].push(normalized);else b[kind][index] = normalized;
    return state;
  }
  if (type === 'invoice.create') {
    b.invoices.push(invoiceDraft(state, p, now));
    b.nextInvoiceNumber++;
    return state;
  }
  if (type.startsWith('invoice.')) {
    const invoice = b.invoices.find(i => i.id === identifier(p.id));
    if (!invoice) throw new Error('Invoice does not exist.');
    if (type === 'invoice.update') {
      if (invoice.status !== 'draft') throw new Error('Sent invoices are immutable; void and issue a new invoice instead.');
      const index = b.invoices.indexOf(invoice);
      b.invoices[index] = invoiceDraft(state, {
        ...invoice,
        ...p
      }, now, invoice);
    } else if (type === 'invoice.markSent') {
      if (invoice.status !== 'draft') throw new Error('Only draft invoices can be marked sent.');
      invoice.status = invoice.totalMinor === 0 ? 'paid' : 'sent';
    } else if (type === 'invoice.payment') {
      if (!['sent', 'paid'].includes(invoice.status)) throw new Error('Payments require a sent invoice.');
      const amountMinor = integer(p.amountMinor, 'Payment amount', 1);
      if (amountMinor > invoice.outstandingMinor) throw new Error('Payment cannot exceed outstanding balance.');
      invoice.payments.push({
        id: randomUUID(),
        amountMinor,
        date: date(p.date ?? new Date(now).toISOString().slice(0, 10), 'Payment date'),
        reference: txt(p.reference ?? '', 'Payment reference', 300)
      });
      invoice.paidMinor += amountMinor;
      invoice.outstandingMinor -= amountMinor;
      if (!invoice.outstandingMinor) invoice.status = 'paid';
    } else if (type === 'invoice.void') {
      if (invoice.status === 'void') throw new Error('Invoice is already void.');
      if (invoice.paidMinor) throw new Error('Paid invoices cannot be voided.');
      invoice.status = 'void';
      invoice.voidReason = txt(p.reason ?? '', 'Void reason', 2000, true);
    } else throw new Error(`Unknown command: ${type}`);
    return state;
  }
  return null;
}
function financialSummary(state, query = {}) {
  const clean = clone(state);
  clean.business = validateBusiness(state.business, state);
  const startDate = date(query.startDate ?? '1970-01-01', 'Start date');
  const endDate = date(query.endDate ?? '9999-12-31', 'End date');
  period(startDate, endDate);
  const groups = new Map(),
    byCurrency = new Map(),
    usedHours = new Map();
  const group = (projectId, clientId, code) => {
    const key = `${projectId}\u0000${clientId}\u0000${code}`;
    if (!groups.has(key)) groups.set(key, {
      projectId,
      projectName: clean.projects.find(p => p.id === projectId)?.name ?? 'Unassigned',
      clientId,
      clientName: clean.clients.find(c => c.id === clientId)?.name ?? 'Unassigned',
      currency: code,
      currencyDigits: digits(code),
      totalHours: 0,
      billableHours: 0,
      revenueMinor: 0,
      costMinor: 0,
      profitMinor: 0,
      budgetHours: 0,
      budgetRemainingHours: null,
      budgetContracts: new Set()
    });
    return groups.get(key);
  };
  // Included-hour allowances are consumed over the full fixed contract period,
  // including approved billable entries outside a narrower report query.
  for (const e of clean.entries.filter(e => e.status === 'approved').sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))) {
    const c = contractFor(clean, e);
    const code = c?.currency ?? clean.business.clientTerms.find(t => t.clientId === e.clientId)?.currency ?? 'USD';
    const precision = digits(code),
      hours = e.durationMs / 3600000;
    let revenueMinor = 0;
    if (e.billable) {
      if (!c || c.type === 'hourly') revenueMinor = charge(e.durationMs, c?.hourlyRate ?? clean.clients.find(x => x.id === e.clientId)?.hourlyRate ?? 0, precision);else if (c.type === 'hybrid') {
        const previous = usedHours.get(c.id) ?? 0;
        revenueMinor = amountForHours(Math.max(0, previous + hours - c.includedHours) - Math.max(0, previous - c.includedHours), c.hourlyRate, precision);
        usedHours.set(c.id, previous + hours);
      }
    }
    if (!inPeriod(e, startDate, endDate)) continue;
    const g = group(e.projectId, e.clientId, code);
    g.totalHours += hours;
    if (e.billable) g.billableHours += hours;
    g.revenueMinor += revenueMinor;
    g.costMinor += charge(e.durationMs, c?.costRate ?? 0, precision);
    if (c?.projectId && !g.budgetContracts.has(c.id)) {
      g.budgetHours += c.budgetHours;
      g.budgetContracts.add(c.id);
    }
  }
  // A fixed fee is recognized exactly once, on the contract start date. There is
  // no invented monthly recurrence and no silent fee prorating.
  for (const c of clean.business.contracts.filter(c => c.type !== 'hourly' && c.startDate >= startDate && c.startDate <= endDate)) {
    const g = group(c.projectId, c.clientId, c.currency);
    g.revenueMinor += c.retainerMinor;
    if (c.projectId && !g.budgetContracts.has(c.id)) {
      g.budgetHours += c.budgetHours;
      g.budgetContracts.add(c.id);
    }
  }
  const currencyTotal = code => {
    if (!byCurrency.has(code)) byCurrency.set(code, {
      currency: code,
      currencyDigits: digits(code),
      totalHours: 0,
      billableHours: 0,
      revenueMinor: 0,
      costMinor: 0,
      profitMinor: 0,
      invoicedMinor: 0,
      outstandingMinor: 0
    });
    return byCurrency.get(code);
  };
  for (const g of groups.values()) {
    g.profitMinor = g.revenueMinor - g.costMinor;
    // Budget consumption covers the complete contract, not merely visible days.
    const budgetUsed = clean.entries.filter(e => e.status === 'approved' && e.projectId === g.projectId && g.budgetContracts.has(contractFor(clean, e)?.id)).reduce((n, e) => n + e.durationMs / 3600000, 0);
    g.budgetRemainingHours = g.budgetHours ? g.budgetHours - budgetUsed : null;
    delete g.budgetContracts;
    const total = currencyTotal(g.currency);
    for (const key of ['totalHours', 'billableHours', 'revenueMinor', 'costMinor', 'profitMinor']) total[key] += g[key];
  }
  for (const inv of clean.business.invoices.filter(i => ['sent', 'paid'].includes(i.status) && i.issueDate >= startDate && i.issueDate <= endDate)) {
    const total = currencyTotal(inv.currency);
    total.invoicedMinor += inv.totalMinor;
    total.outstandingMinor += inv.outstandingMinor;
  }
  const contracts = clean.business.contracts.filter(c => c.startDate <= endDate && (!c.endDate || c.endDate >= startDate)).map(c => {
    const totalHours = clean.entries.filter(e => e.status === 'approved' && contractFor(clean, e)?.id === c.id).reduce((n, e) => n + e.durationMs / 3600000, 0);
    return {
      contractId: c.id,
      clientId: c.clientId,
      projectId: c.projectId,
      currency: c.currency,
      totalHours,
      budgetHours: c.budgetHours,
      budgetRemainingHours: c.budgetHours ? c.budgetHours - totalHours : null
    };
  });
  for (const record of [...byCurrency.values(), ...groups.values()]) {
    for (const [key, value] of Object.entries(record)) if (key.endsWith('Minor') && !Number.isSafeInteger(value)) throw new Error('Financial summary exceeds safe money limits.');
  }
  return {
    startDate,
    endDate,
    currencies: [...byCurrency.values()],
    projects: [...groups.values()],
    contracts,
    notes: ['Estimates use approved entries and contract rates; currencies are reported separately without conversion.', 'Retainer/hybrid contracts have one fixed period. The fixed fee is recognized on its start date; included hours span its entire period. No recurrence or proration is assumed.', 'Invoice selection uses the UTC date on which each entry starts.']
  };
}
const escape = v => String(v ?? '').replace(/[&<>"']/g, x => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[x]);
function invoiceHtml(value) {
  const inv = validateInvoice(value);
  const money = n => escape(new Intl.NumberFormat('en', {
    style: 'currency',
    currency: inv.currency
  }).format(n / 10 ** inv.currencyDigits));
  const nl = text => escape(text).replaceAll('\n', '<br>');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Invoice ${escape(inv.number)}</title><style>body{font:14px Arial,sans-serif;color:#20202a;padding:36px;line-height:1.5}h1{font-size:30px}header,.parties{display:flex;justify-content:space-between;gap:36px}section{margin:24px 0}.parties>div{width:48%}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #ddd;padding:10px}th:last-child,td:last-child{text-align:right}.totals{margin-left:auto;width:320px}.totals p{display:flex;justify-content:space-between}.status{font-weight:bold;text-transform:uppercase}footer{margin-top:40px;color:#555}@page{margin:18mm}tr{break-inside:avoid}</style></head><body><header><div><h1>Invoice ${escape(inv.number)}</h1><p class="status">${escape(inv.status)}</p></div><div>Issued: ${escape(inv.issueDate)}<br>Due: ${escape(inv.dueDate)}<br>Currency: ${escape(inv.currency)}</div></header><section class="parties"><div><strong>From</strong><p>${nl(inv.issuer.name)}<br>${nl(inv.issuer.address)}<br>${escape(inv.issuer.email)}</p></div><div><strong>Bill to</strong><p>${escape(inv.clientName)}<br>${escape(inv.billTo.contact)}<br>${nl(inv.billTo.address)}<br>${escape(inv.billTo.email)}</p></div></section><table><thead><tr><th>Description</th><th>Hours</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${inv.lines.map(l => `<tr><td>${nl(l.description)}</td><td>${l.kind === 'retainer' ? '—' : escape(l.quantityHours.toFixed(4))}</td><td>${l.kind === 'retainer' ? '—' : money(charge(3600000, l.rate, inv.currencyDigits))}</td><td>${money(l.amountMinor)}</td></tr>`).join('')}</tbody></table><section class="totals"><p><span>Subtotal</span><span>${money(inv.subtotalMinor)}</span></p><p><span>Discount</span><span>${money(inv.discountMinor)}</span></p><p><span>Tax (${escape(inv.taxBps / 100)}%)</span><span>${money(inv.taxMinor)}</span></p><p><strong>Total</strong><strong>${money(inv.totalMinor)}</strong></p><p><span>Paid</span><span>${money(inv.paidMinor)}</span></p><p><strong>Outstanding</strong><strong>${money(inv.outstandingMinor)}</strong></p></section>${inv.payments.length ? `<section><h3>Payments</h3>${inv.payments.map(p => `<p>${escape(p.date)} · ${money(p.amountMinor)} · ${escape(p.reference)}</p>`).join('')}</section>` : ''}<section>${nl(inv.notes)}</section><footer>${nl(inv.paymentInstructions)}${inv.status === 'void' ? `<p>Void reason: ${nl(inv.voidReason)}</p>` : ''}</footer></body></html>`;
}
module.exports = {
  defaultBusiness,
  validateBusiness,
  validateInvoice,
  assertInvoiceTransition,
  assertInvoiceEntries,
  applyBusinessCommand,
  financialSummary,
  invoiceHtml,
  charge
};
