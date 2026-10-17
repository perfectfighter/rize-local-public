'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createService } = require('../server/index.cjs');
const { openDatabase } = require('../server/database.cjs');
const { SESSION_TTL } = require('../server/auth.cjs');
const { createStore } = require('../desktop/store.cjs');

async function fixture(t, options = {}) {
  let time = Date.parse('2026-10-17T12:00:00Z');
  const service = createService({ dbPath: ':memory:', env: {}, now: () => time, ...options });
  const address = await service.listen(0);
  t.after(async () => { await service.close(); if (options.cleanup) options.cleanup(); });
  const base = `http://127.0.0.1:${address.port}`;
  async function call(method, route, body, token, headers = {}) {
    const response = await fetch(base + route, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  const register = async (email, name = email.split('@')[0]) => {
    const result = await call('POST', '/v1/auth/register', { email, password: 'a long synthetic password', name });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  };
  const team = async (account, name = 'Synthetic team') => {
    const result = await call('POST', '/v1/teams', { name }, account.token);
    assert.equal(result.status, 201); return result.body.team;
  };
  const invite = async (owner, teamId, account, role = 'member') => {
    const result = await call('POST', `/v1/teams/${teamId}/invites`, { email: account.user.email, role }, owner.token);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const joined = await call('POST', '/v1/teams/join', { code: result.body.code }, account.token);
    assert.equal(joined.status, 200, JSON.stringify(joined.body)); return result.body;
  };
  return { service, call, register, team, invite, base, advance: ms => { time += ms; } };
}

const entry = (id, start = '2026-10-17T04:00:00Z', end = '2026-10-17T05:00:00Z') => ({ id, start, end, description: 'Shared approved work', status: 'approved', category: 'productive', clientId: '', projectId: '', taskId: '', billable: true, source: 'manual', durationMs: Date.parse(end) - Date.parse(start) });
const change = (kind, id, data, baseVersion = 0) => ({ kind, id, data, baseVersion });
function accountingInvoice(id = 'invoice', entryId = 'owner-entry', sequence = 1) {
  const store = createStore({ now: () => Date.parse('2026-10-17T12:00:00Z') });
  const mutate = (type, payload) => store.mutate({ type, payload });
  mutate('workspace.create', { displayName: 'Synthetic issuer' });
  mutate('client.upsert', { id: 'client', name: 'Synthetic client', hourlyRate: 100 });
  mutate('entry.upsert', { ...entry(entryId), clientId: 'client', app: 'Manual', title: '', billable: true });
  const value = mutate('invoice.create', { clientId: 'client', startDate: '2026-10-01', endDate: '2026-10-31' }).business.invoices[0];
  return { ...value, id, sequence, number: `INV-${String(sequence).padStart(4, '0')}` };
}

test('HTTP accounts use opaque revocable sessions and retain no plaintext credentials', async t => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.server-test-'));
  const dbPath = path.join(directory, 'accounts.sqlite');
  const f = await fixture(t, { dbPath, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) });
  const account = await f.register('Owner@Example.test');
  assert.equal(account.user.email, 'owner@example.test');
  assert.match(account.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.call('GET', '/v1/me', undefined, account.token)).body.user.id, account.user.id);
  const inspect = openDatabase(dbPath);
  const stored = inspect.prepare('SELECT * FROM users').get();
  assert.match(stored.password_hash, /^scrypt:32768:8:3:/);
  assert.ok(!stored.password_hash.includes('synthetic'));
  assert.notEqual(inspect.prepare('SELECT token_hash FROM sessions').get().token_hash, account.token);
  inspect.close();
  assert.equal((await f.call('POST', '/v1/auth/login', { email: account.user.email, password: 'incorrect but long password' })).status, 401);
  assert.equal((await f.call('POST', '/v1/auth/login', { email: 'absent@example.test', password: 'incorrect but long password' })).status, 401);
  const login = await f.call('POST', '/v1/auth/login', { email: account.user.email, password: 'a long synthetic password' });
  assert.equal(login.status, 200);
  assert.notEqual(login.body.token, account.token);
  assert.equal((await f.call('POST', '/v1/auth/logout', {}, login.body.token)).status, 200);
  assert.equal((await f.call('GET', '/v1/me', undefined, login.body.token)).status, 401);
  f.advance(SESSION_TTL + 1);
  assert.equal((await f.call('GET', '/v1/me', undefined, account.token)).status, 401);
});

test('HTTP rejects weak passwords, blocked origins, malformed bodies, and excessive auth attempts', async t => {
  const f = await fixture(t, { env: { RIZE_ALLOWED_ORIGINS: 'http://localhost:5173' } });
  assert.equal((await f.call('POST', '/v1/auth/register', { email: 'x@example.test', name: 'X', password: 'short' })).status, 400);
  assert.equal((await f.call('GET', '/healthz', undefined, null, { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.call('OPTIONS', '/v1/me', undefined, null, { origin: 'http://localhost:5173' })).status, 204);
  const health = await f.call('GET', '/healthz', undefined, null, { origin: 'http://localhost:5173' });
  assert.equal(health.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const malformed = await fetch(f.base + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const large = await fetch(f.base + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(1024 * 1024) }) });
  assert.equal(large.status, 413);
  let result;
  for (let i = 0; i < 12; i++) result = await f.call('POST', '/v1/auth/login', { email: 'limited@example.test', password: 'a long synthetic password' });
  assert.equal(result.status, 429);
});

test('HTTP invitations are email-bound, single use, expire, and cannot grant owner', async t => {
  const f = await fixture(t);
  const owner = await f.register('owner@example.test'), member = await f.register('member@example.test'), other = await f.register('other@example.test');
  const team = await f.team(owner);
  assert.equal((await f.call('POST', `/v1/teams/${team.id}/invites`, { email: member.user.email, role: 'owner' }, owner.token)).status, 403);
  const invitation = await f.call('POST', `/v1/teams/${team.id}/invites`, { email: member.user.email, role: 'member' }, owner.token);
  assert.equal((await f.call('POST', '/v1/teams/join', { code: invitation.body.code }, other.token)).status, 400);
  assert.equal((await f.call('POST', '/v1/teams/join', { code: invitation.body.code }, member.token)).status, 200);
  assert.equal((await f.call('POST', '/v1/teams/join', { code: invitation.body.code }, member.token)).status, 400);
  const expiry = await f.call('POST', `/v1/teams/${team.id}/invites`, { email: other.user.email, role: 'member' }, owner.token);
  f.advance(7 * 86400000 + 1);
  const loggedIn = await f.call('POST', '/v1/auth/login', { email: other.user.email, password: 'a long synthetic password' });
  assert.equal((await f.call('POST', '/v1/teams/join', { code: expiry.body.code }, loggedIn.body.token)).status, 400);
});

test('HTTP membership prevents escalation, self grants, last-owner loss, and cross-team reads', async t => {
  const f = await fixture(t);
  const owner = await f.register('owner@example.test'), admin = await f.register('admin@example.test'), member = await f.register('member@example.test'), outsider = await f.register('outside@example.test');
  const team = await f.team(owner); await f.invite(owner, team.id, admin, 'admin'); await f.invite(owner, team.id, member);
  assert.equal((await f.call('GET', `/v1/teams/${team.id}/members`, undefined, outsider.token)).status, 404);
  assert.equal((await f.call('PATCH', `/v1/teams/${team.id}/members/${owner.user.id}`, { role: 'member' }, owner.token)).body.code, 'LAST_OWNER');
  assert.equal((await f.call('PATCH', `/v1/teams/${team.id}/members/${admin.user.id}`, { finance: true }, admin.token)).body.code, 'SELF_EDIT');
  assert.equal((await f.call('PATCH', `/v1/teams/${team.id}/members/${member.user.id}`, { role: 'owner' }, admin.token)).status, 403);
  assert.equal((await f.call('PATCH', `/v1/teams/${team.id}/members/${member.user.id}`, { role: 'admin' }, member.token)).status, 403);
  const promoted = await f.call('PATCH', `/v1/teams/${team.id}/members/${member.user.id}`, { role: 'owner' }, owner.token);
  assert.equal(promoted.body.member.role, 'owner');
  assert.equal(promoted.body.member.finance, true);
  assert.equal((await f.call('PATCH', `/v1/teams/${team.id}/members/${owner.user.id}`, { role: 'member', finance: false, resourcing: false }, member.token)).status, 200);
  const teams = await f.call('GET', '/v1/teams', undefined, owner.token);
  assert.equal(teams.body.teams[0].role, 'member');
  assert.equal(teams.body.teams[0].finance, false);
});

test('HTTP sync isolates teams, preserves ownership, and returns stale-version conflicts', async t => {
  const f = await fixture(t);
  const first = await f.register('first@example.test'), second = await f.register('second@example.test');
  const teamA = await f.team(first, 'A'), teamB = await f.team(second, 'B');
  const route = id => `/v1/teams/${id}/sync`;
  const pushed = await f.call('POST', route(teamA.id), { changes: [change('entries', 'same-id', entry('same-id'))] }, first.token);
  assert.equal(pushed.status, 200); assert.equal(pushed.body.records[0].version, 1); assert.equal(pushed.body.records[0].ownerId, first.user.id);
  assert.equal((await f.call('GET', route(teamA.id), undefined, second.token)).status, 404);
  await f.call('POST', route(teamB.id), { changes: [change('entries', 'same-id', { ...entry('same-id'), description: 'Other team' })] }, second.token);
  assert.equal((await f.call('GET', route(teamA.id), undefined, first.token)).body.records[0].data.description, 'Shared approved work');
  const stale = await f.call('POST', route(teamA.id), { changes: [change('entries', 'same-id', { ...entry('same-id'), description: 'Stale overwrite' }, 0)] }, first.token);
  assert.equal(stale.status, 200); assert.equal(stale.body.conflicts.length, 1); assert.equal(stale.body.records.length, 0);
  assert.equal(stale.body.conflicts[0].current.data.description, 'Shared approved work');
  const updated = await f.call('POST', route(teamA.id), { changes: [change('entries', 'same-id', { ...entry('same-id'), description: 'Fresh' }, 1)] }, first.token);
  assert.equal(updated.body.records[0].version, 2);
  const deleted = await f.call('POST', route(teamA.id), { changes: [{ kind: 'entries', id: 'same-id', deleted: true, baseVersion: 2 }] }, first.token);
  assert.equal(deleted.body.records[0].data, null); assert.equal(deleted.body.records[0].deleted, true);
  const pulled = await f.call('GET', route(teamA.id) + '?since=' + updated.body.cursor, undefined, first.token);
  assert.equal(pulled.body.records.length, 1); assert.equal(pulled.body.records[0].version, 3);
});

test('HTTP sync rejects private raw activity, unapproved time, invalid timezones, and invalid batches atomically', async t => {
  const f = await fixture(t); const account = await f.register('owner@example.test'); const team = await f.team(account); const route = `/v1/teams/${team.id}/sync`;
  for (const field of ['app', 'title', 'windowTitle', 'url', 'metadata']) {
    const response = await f.call('POST', route, { changes: [change('entries', 'raw', { ...entry('raw'), [field]: 'Private content' })] }, account.token);
    assert.equal(response.status, 400); assert.equal(response.body.code, 'PRIVATE_ACTIVITY');
  }
  assert.equal((await f.call('POST', route, { changes: [change('entries', 'pending', { ...entry('pending'), status: 'pending' })] }, account.token)).body.code, 'APPROVAL_REQUIRED');
  assert.equal((await f.call('POST', route, { changes: [change('entries', 'bad', { ...entry('bad'), start: '2026-02-30T00:00:00Z' })] }, account.token)).status, 400);
  assert.equal((await f.call('POST', route, { changes: [change('clients', 'valid', { name: 'Valid' }), change('entries', 'bad', { ...entry('bad'), start: '2026-10-17T04:00:00' })] }, account.token)).status, 400);
  assert.equal((await f.call('GET', route, undefined, account.token)).body.records.length, 0);
  assert.equal((await f.call('GET', `/v1/teams/${team.id}/analytics?timezone=Invalid/Zone`, undefined, account.token)).status, 400);
  assert.equal((await f.call('GET', `/v1/teams/${team.id}/analytics?startDate=2026-99-01`, undefined, account.token)).status, 400);
});

test('HTTP roles gate own entries, finance, resourcing, common taxonomy, and read-only viewers', async t => {
  const f = await fixture(t); const owner = await f.register('owner@example.test'), member = await f.register('member@example.test'), viewer = await f.register('viewer@example.test');
  const team = await f.team(owner); await f.invite(owner, team.id, member); await f.invite(owner, team.id, viewer, 'viewer'); const route = `/v1/teams/${team.id}/sync`;
  const ownerPush = await f.call('POST', route, { changes: [change('entries', 'owner-entry', { ...entry('owner-entry'), clientId: 'client' }), change('clients', 'client', { name: 'Shared client' }), change('projects', 'project', { name: 'Shared project', clientId: 'client' }), change('invoices', 'invoice', accountingInvoice())] }, owner.token);
  assert.equal(ownerPush.status, 200, JSON.stringify(ownerPush.body));
  assert.equal((await f.call('POST', route, { changes: [change('entries', 'member-entry', { ...entry('member-entry'), clientId: 'client' })] }, member.token)).status, 200);
  assert.equal((await f.call('POST', route, { changes: [change('entries', 'owner-entry', entry('owner-entry'), 1)] }, member.token)).status, 403);
  assert.equal((await f.call('POST', route, { changes: [change('clients', 'new-client', { name: 'No' })] }, member.token)).status, 403);
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'new-invoice', { number: 'No' })] }, member.token)).status, 403);
  const visible = await f.call('GET', route, undefined, member.token);
  assert.deepEqual(visible.body.records.map(row => row.id).sort(), ['client', 'member-entry', 'project']);
  assert.equal((await f.call('POST', route, { changes: [change('entries', 'viewer-entry', entry('viewer-entry'))] }, viewer.token)).status, 403);
  await f.call('PATCH', `/v1/teams/${team.id}/members/${member.user.id}`, { finance: true, resourcing: true }, owner.token);
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'member-invoice', accountingInvoice('member-invoice', 'member-entry', 2)), change('allocations', 'allocation', { memberId: member.user.id, memberName: 'Member', projectId: 'project', week: '2026-10-12', hours: 20, capacityHours: 40 })] }, member.token)).status, 200);
  assert.ok((await f.call('GET', route, undefined, member.token)).body.records.some(row => row.id === 'invoice'));
});

test('HTTP analytics split local midnight and union overlapping work without leaking descriptions', async t => {
  const f = await fixture(t); const owner = await f.register('owner@example.test'); const team = await f.team(owner);
  const entries = [entry('night', '2026-10-16T17:30:00Z', '2026-10-16T19:30:00Z'), entry('overlap', '2026-10-16T18:45:00Z', '2026-10-16T19:15:00Z')];
  assert.equal((await f.call('POST', `/v1/teams/${team.id}/sync`, { changes: entries.map(item => change('entries', item.id, item)) }, owner.token)).status, 200);
  const result = await f.call('GET', `/v1/teams/${team.id}/analytics?startDate=2026-10-16&endDate=2026-10-17&timezone=Asia%2FKolkata`, undefined, owner.token);
  assert.equal(result.status, 200); assert.equal(result.body.totals.durationMs, 7200000);
  assert.deepEqual(result.body.timesheet.map(item => [item.date, item.durationMs]), [['2026-10-16', 3600000], ['2026-10-17', 3600000]]);
  assert.ok(!JSON.stringify(result.body).includes('Shared approved work'));
  // DST spring-forward day is 23 real hours, while the date boundary still splits correctly.
  const { splitDays } = require('../server/workspace.cjs');
  const parts = splitDays(Date.parse('2026-03-08T05:00:00Z'), Date.parse('2026-03-09T05:00:00Z'), 'America/New_York');
  assert.deepEqual(parts.map(item => [item.day, item.end - item.start]), [['2026-03-08', 23 * 3600000], ['2026-03-09', 3600000]]);
});

test('HTTP external binding requires exact HTTPS public origin and registration can be disabled', async t => {
  const service = createService({ dbPath: ':memory:', env: {} });
  await assert.rejects(service.listen(0, '0.0.0.0'), /RIZE_PUBLIC_ORIGIN/); await service.close();
  const f = await fixture(t, { env: { RIZE_DISABLE_REGISTRATION: '1' } });
  assert.equal((await f.call('POST', '/v1/auth/register', { email: 'blocked@example.test', password: 'a long synthetic password', name: 'Blocked' })).body.code, 'REGISTRATION_DISABLED');
});

test('HTTP sync pagination does not skip events across the 1000-event boundary', async t => {
  const f = await fixture(t); const owner = await f.register('owner@example.test'); const team = await f.team(owner); const route = `/v1/teams/${team.id}/sync`;
  for (const offset of [0, 500, 1000]) {
    const changes = Array.from({ length: offset === 1000 ? 1 : 500 }, (_, index) => { const id = `client-${offset + index}`; return change('clients', id, { id, name: id }); });
    assert.equal((await f.call('POST', route, { changes }, owner.token)).status, 200);
  }
  const first = await f.call('GET', route, undefined, owner.token);
  assert.equal(first.body.records.length, 1000); assert.equal(first.body.hasMore, true);
  const last = await f.call('GET', `${route}?since=${first.body.cursor}`, undefined, owner.token);
  assert.equal(last.body.records.length, 1); assert.equal(last.body.hasMore, false); assert.equal(last.body.records[0].id, 'client-1000');
});

test('HTTP services use the same authorization and owner-bound records; member removal revokes access', async t => {
  const f = await fixture(t); const owner = await f.register('owner@example.test'), member = await f.register('member@example.test');
  const team = await f.team(owner); await f.invite(owner, team.id, member); const prefix = `/v1/teams/${team.id}`;
  const status = await f.call('GET', `${prefix}/services/status`, undefined, member.token);
  assert.equal(status.status, 200); assert.equal(status.body.ai.configured, false);
  assert.equal((await f.call('POST', `${prefix}/services/ai/chat`, { message: 'Report', consent: true }, member.token)).status, 503);
  const skill = await f.call('POST', `${prefix}/services/ai/skills`, { name: 'My report', instructions: 'Use concise weekly summaries' }, member.token);
  assert.equal(skill.status, 200, JSON.stringify(skill.body));
  const ownerSkill = await f.call('POST', `${prefix}/services/ai/skills`, { name: 'Owner only', instructions: 'Do not share with members' }, owner.token);
  assert.equal(ownerSkill.status, 200);
  const visible = await f.call('GET', `${prefix}/services/ai/skills`, undefined, member.token);
  assert.deepEqual(visible.body.skills.map(item => item.id), [skill.body.skill.id]);
  assert.equal((await f.call('DELETE', `${prefix}/services/ai/skills/${ownerSkill.body.skill.id}`, {}, member.token)).status, 404);
  assert.equal((await f.call('DELETE', `${prefix}/members/${owner.user.id}`, {}, owner.token)).body.code, 'LAST_OWNER');
  assert.equal((await f.call('DELETE', `${prefix}/members/${member.user.id}`, {}, owner.token)).status, 200);
  assert.equal((await f.call('GET', `${prefix}/services/ai/skills`, undefined, member.token)).status, 404);
  assert.equal((await f.call('GET', '/v1/teams', undefined, member.token)).body.teams.length, 0);
});

test('Service routine scheduler executes once under its author permissions and excludes peers private inputs', async t => {
  const requests = [];
  const f = await fixture(t, {
    env: { RIZE_RUN_ROUTINES: '1', RIZE_AI_BASE_URL: 'https://synthetic-ai.example.test/v1', RIZE_AI_API_KEY: 'synthetic-provider-key', RIZE_AI_MODEL: 'synthetic-model' },
    fetchImpl: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic scheduled report' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  const owner = await f.register('owner@example.test'), member = await f.register('member@example.test');
  const team = await f.team(owner); await f.invite(owner, team.id, member); const prefix = `/v1/teams/${team.id}`;
  await f.call('POST', `${prefix}/sync`, { changes: [change('entries', 'owner-entry', { ...entry('owner-entry'), description: 'Private peer approved description' })] }, owner.token);
  await f.call('POST', `${prefix}/sync`, { changes: [change('entries', 'member-entry', { ...entry('member-entry'), description: 'My approved description' })] }, member.token);
  const routine = await f.call('POST', `${prefix}/services/ai/routines`, { name: 'Quarter hour summary', prompt: 'Summarize my work', intervalMinutes: 15, enabled: true, consent: true }, member.token);
  assert.equal(routine.status, 200, JSON.stringify(routine.body));
  await f.service.tickServices(); assert.equal(requests.length, 0);
  f.advance(16 * 60000);
  await f.service.tickServices(); await f.service.tickServices();
  assert.equal(requests.length, 1);
  assert.ok(JSON.stringify(requests[0].body).includes('My approved description'));
  assert.ok(!JSON.stringify(requests[0].body).includes('Private peer approved description'));
  const reports = await f.call('GET', `${prefix}/services/ai/reports`, undefined, member.token);
  assert.equal(reports.body.reports.length, 1); assert.equal(reports.body.reports[0].text, 'Synthetic scheduled report');
});

test('Direct HTTP finance writes validate real source time, balances, duplicate billing, contract scope, and allocations atomically', async t => {
  const f = await fixture(t), owner = await f.register('owner@example.test'); const team = await f.team(owner); const route = `/v1/teams/${team.id}/sync`;
  const initial = [change('clients', 'client', { name: 'Client', hourlyRate: 100 }), change('projects', 'project', { name: 'Project', clientId: 'client' }), change('projects', 'project-2', { name: 'Other project', clientId: 'client' }), change('entries', 'owner-entry', { ...entry('owner-entry'), clientId: 'client' }), change('invoices', 'invoice', accountingInvoice())];
  assert.equal((await f.call('POST', route, { changes: initial }, owner.token)).status, 200);
  const before = await f.call('GET', route, undefined, owner.token);
  const badTotals = { ...accountingInvoice('bad', 'owner-entry', 2), totalMinor: 1 };
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'bad', badTotals)] }, owner.token)).body.code, 'FINANCIAL_INVARIANT');
  const duplicate = await f.call('POST', route, { changes: [change('clients', 'rolled-back', { name: 'Must roll back' }), change('invoices', 'duplicate', accountingInvoice('duplicate', 'owner-entry', 2))] }, owner.token);
  assert.equal(duplicate.status, 400); assert.equal(duplicate.body.code, 'FINANCIAL_INVARIANT');
  const missing = await f.call('POST', route, { changes: [change('invoices', 'missing-source', accountingInvoice('missing-source', 'missing-entry', 2))] }, owner.token);
  assert.equal(missing.status, 400); assert.ok(!missing.body.error.includes('owner-entry'));
  const contract = { clientId: 'foreign-client', projectId: '', type: 'hourly', hourlyRate: 100, costRate: 40, startDate: '2026-10-01', endDate: '', currency: 'USD' };
  assert.equal((await f.call('POST', route, { changes: [change('contracts', 'bad-contract', contract)] }, owner.token)).body.code, 'FINANCIAL_INVARIANT');
  const capacity = { memberId: owner.user.id, memberName: 'Owner', projectId: 'project', week: '2026-10-12', hours: 20, capacityHours: 40 };
  assert.equal((await f.call('POST', route, { changes: [change('allocations', 'a', capacity), change('allocations', 'b', { ...capacity, projectId: 'project-2', capacityHours: 30 })] }, owner.token)).body.code, 'FINANCIAL_INVARIANT');
  const after = await f.call('GET', route, undefined, owner.token); assert.equal(after.body.cursor, before.body.cursor); assert.deepEqual(after.body.records, before.body.records);
  // A legitimate void and source edit are one atomic transaction, regardless of change order.
  const voided = { ...accountingInvoice(), status: 'void', voidReason: 'Cancel before issuing' };
  const valid = await f.call('POST', route, { changes: [change('entries', 'owner-entry', { ...entry('owner-entry'), clientId: 'client', description: 'Corrected after void' }, 1), change('invoices', 'invoice', voided, 1)] }, owner.token);
  assert.equal(valid.status, 200, JSON.stringify(valid.body)); assert.equal(valid.body.records[0].version, 2);
});

test('Direct HTTP cannot rewrite sent accounting, rewrite or reorder payments, delete audit records, or alter billed time', async t => {
  const f = await fixture(t), owner = await f.register('owner@example.test'); const team = await f.team(owner); const route = `/v1/teams/${team.id}/sync`;
  const invoice = accountingInvoice();
  assert.equal((await f.call('POST', route, { changes: [change('clients', 'client', { name: 'Client', hourlyRate: 100 }), change('entries', 'owner-entry', { ...entry('owner-entry'), clientId: 'client' }), change('invoices', 'invoice', invoice)] }, owner.token)).status, 200);
  const locked = await f.call('POST', route, { changes: [change('entries', 'owner-entry', { ...entry('owner-entry'), clientId: 'client', description: 'Forged source' }, 1)] }, owner.token);
  assert.equal(locked.status, 409); assert.equal(locked.body.code, 'BILLED_TIME_LOCKED');
  assert.equal((await f.call('POST', route, { changes: [{ kind: 'entries', id: 'owner-entry', baseVersion: 1, deleted: true }] }, owner.token)).body.code, 'BILLED_TIME_LOCKED');
  const sent = { ...invoice, status: 'sent' };
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'invoice', sent, 1)] }, owner.token)).status, 200);
  for (const patch of [{ notes: 'Rewrite frozen note' }, { status: 'draft' }, { number: 'NEW-NUMBER' }]) {
    const changed = await f.call('POST', route, { changes: [change('invoices', 'invoice', { ...sent, ...patch }, 2)] }, owner.token);
    assert.equal(changed.status, 409); assert.equal(changed.body.code, 'INVOICE_IMMUTABLE');
  }
  assert.equal((await f.call('POST', route, { changes: [{ kind: 'invoices', id: 'invoice', baseVersion: 2, deleted: true }] }, owner.token)).body.code, 'INVOICE_IMMUTABLE');
  const firstPayment = { id: 'payment-1', amountMinor: 1000, date: '2026-10-17', reference: 'Bank 1' };
  const partial = { ...sent, payments: [firstPayment], paidMinor: 1000, outstandingMinor: sent.totalMinor - 1000 };
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'invoice', partial, 2)] }, owner.token)).status, 200);
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'invoice', { ...partial, payments: [{ ...firstPayment, reference: 'Rewritten' }] }, 3)] }, owner.token)).body.code, 'INVOICE_IMMUTABLE');
  const secondPayment = { id: 'payment-2', amountMinor: 1000, date: '2026-10-17', reference: 'Bank 2' };
  const two = { ...partial, payments: [firstPayment, secondPayment], paidMinor: 2000, outstandingMinor: sent.totalMinor - 2000 };
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'invoice', two, 3)] }, owner.token)).status, 200);
  assert.equal((await f.call('POST', route, { changes: [change('invoices', 'invoice', { ...two, payments: [secondPayment, firstPayment] }, 4)] }, owner.token)).body.code, 'INVOICE_IMMUTABLE');
  const final = (await f.call('GET', `${route}?since=0`, undefined, owner.token)).body.records.filter(row => row.kind === 'invoices').at(-1);
  assert.equal(final.version, 4); assert.equal(final.data.payments[0].reference, 'Bank 1');
});
