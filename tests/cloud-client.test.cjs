'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createService } = require('../server/index.cjs');
const { createStore } = require('../desktop/store.cjs');
const { createCloudClient, serverUrl, syncBatches } = require('../desktop/cloud-client.cjs');
const command = (store, type, payload = {}) => store.mutate({ type, payload });
const entry = (id, extra = {}) => ({ id, start: '2026-10-17T09:00:00.123Z', end: '2026-10-17T09:30:00.456Z', description: 'Reviewed work', app: 'Private source app', title: 'A private window title', status: 'approved', source: 'automatic', category: 'productive', ...extra });
const run = (client, action, payload = {}) => client.execute({ action, payload });
const sync = (client, extra = {}) => run(client, 'sync', { consent: true, ...extra });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t, options = {}) {
  let time = Date.parse('2026-10-17T12:00:00Z');
  const service = createService({ dbPath: ':memory:', env: options.env || {}, fetchImpl: options.providerFetchImpl || globalThis.fetch, now: () => time });
  const address = await service.listen(0); const origin = `http://127.0.0.1:${address.port}`;
  const root = fs.mkdtempSync(path.join(process.cwd(), '.cloud-test-'));
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function device(name, overrides = {}) {
    const store = overrides.store || createStore({ now: () => time });
    if (!store.getState().onboarded) command(store, 'workspace.create', { displayName: name });
    const audit = [], sessions = [];
    const realFetch = async (url, config = {}) => {
      audit.push({ url: String(url), method: config.method || 'GET', body: config.body });
      if (overrides.intercept) { const result = await overrides.intercept(url, config); if (result) return result; }
      const response = await fetch(url, config);
      if (/\/auth\/(register|login)$/.test(String(url)) && response.ok) sessions.push((await response.clone().json()).token);
      return response;
    };
    const file = overrides.file || path.join(root, `${name}.json`);
    const client = createCloudClient({ file, store, fetchImpl: realFetch, now: () => time, secureStorage: overrides.secureStorage });
    return { store, client, audit, sessions, file, realFetch };
  }
  async function register(device, email = 'owner@example.test') { await run(device.client, 'configure', { serverUrl: origin }); await run(device.client, 'register', { email, password: 'a long synthetic password', name: email.split('@')[0] }); return device; }
  async function login(device, email = 'owner@example.test') { await run(device.client, 'configure', { serverUrl: origin }); await run(device.client, 'login', { email, password: 'a long synthetic password' }); return device; }
  async function team(device, name = 'Synthetic team') { return (await run(device.client, 'team.create', { name })).result.team; }
  async function raw(device, method, route, body) { const response = await fetch(origin + route, { method, headers: { authorization: `Bearer ${device.sessions.at(-1)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; }
  return { service, origin, device, register, login, team, raw, advance: ms => { time += ms; } };
}

test('Two real HTTP desktop clients sync approved work while pending activity and native metadata stay local', async t => {
  const f = await fixture(t), a = await f.register(f.device('a')); const team = await f.team(a);
  command(a.store, 'client.upsert', { id: 'client', name: 'Client', hourlyRate: 100 });
  command(a.store, 'project.upsert', { id: 'project', name: 'Project', clientId: 'client' });
  command(a.store, 'entry.upsert', entry('approved', { projectId: 'project' }));
  command(a.store, 'entry.upsert', entry('pending', { status: 'pending', description: 'Unreviewed private activity' }));
  const first = await sync(a.client); assert.equal(first.result.pushed, 3);
  const posted = a.audit.filter(request => request.method === 'POST' && request.url.endsWith('/sync')).map(request => request.body).join('');
  assert.ok(!posted.includes('Private source app')); assert.ok(!posted.includes('A private window title')); assert.ok(!posted.includes('Unreviewed private activity'));
  const b = await f.login(f.device('b')); await run(b.client, 'team.select', { teamId: team.id });
  command(b.store, 'entry.upsert', entry('b-pending', { status: 'pending', title: 'Only on B' }));
  await sync(b.client);
  assert.equal(b.store.getState().entries.find(item => item.id === 'approved').title, '');
  assert.equal(b.store.getState().entries.find(item => item.id === 'approved').app, 'Cloud sync');
  assert.equal(b.store.getState().entries.find(item => item.id === 'b-pending').title, 'Only on B');
  assert.equal(b.store.getState().projects[0].clientId, 'client');
  const remote = await f.raw(a, 'GET', `/v1/teams/${team.id}/sync`);
  assert.equal(remote.body.records.filter(row => row.kind === 'entries').length, 1);
  assert.ok(!Object.hasOwn(remote.body.records.find(row => row.kind === 'entries').data, 'title'));
});

test('Two devices preserve conflicts and both explicit local and remote resolutions work', async t => {
  const f = await fixture(t), a = await f.register(f.device('a')); const team = await f.team(a);
  command(a.store, 'entry.upsert', entry('entry')); await sync(a.client);
  const b = await f.login(f.device('b')); await run(b.client, 'team.select', { teamId: team.id }); await sync(b.client);
  command(a.store, 'entry.upsert', { id: 'entry', description: 'A remote revision' }); await sync(a.client);
  command(b.store, 'entry.upsert', { id: 'entry', description: 'B local revision' });
  const conflict = await sync(b.client); assert.equal(conflict.result.conflicts.length, 1); assert.equal(b.store.getState().entries[0].description, 'B local revision');
  assert.equal(conflict.result.conflicts[0].remote.data.description, 'A remote revision');
  await sync(b.client, { resolutions: [{ kind: 'entries', id: 'entry', strategy: 'local' }] });
  await sync(a.client); assert.equal(a.store.getState().entries[0].description, 'B local revision');
  command(b.store, 'entry.upsert', { id: 'entry', description: 'B second revision' }); await sync(b.client);
  command(a.store, 'entry.upsert', { id: 'entry', description: 'A second local' }); await sync(a.client);
  await sync(a.client, { resolutions: [{ kind: 'entries', id: 'entry', strategy: 'remote' }] });
  assert.equal(a.store.getState().entries[0].description, 'B second revision'); assert.equal(a.client.status().conflicts.length, 0);
});

test('Pending ID collisions cannot be overwritten or pushed as remote deletions', async t => {
  const f = await fixture(t), a = await f.register(f.device('a')); const team = await f.team(a);
  command(a.store, 'entry.upsert', entry('collision')); await sync(a.client);
  const b = await f.login(f.device('b')); await run(b.client, 'team.select', { teamId: team.id });
  command(b.store, 'entry.upsert', entry('collision', { status: 'pending', description: 'Private pending collision' }));
  const result = await sync(b.client); assert.equal(result.result.conflicts[0].privateLocal, true); assert.equal(b.store.getState().entries[0].status, 'pending');
  await assert.rejects(sync(b.client, { resolutions: [{ kind: 'entries', id: 'collision', strategy: 'remote' }] }), /Review or rename/);
  command(a.store, 'entry.upsert', { id: 'collision', description: 'Newer peer revision' }); await sync(a.client);
  const newer = await sync(b.client); assert.equal(newer.result.conflicts[0].remote.version, 2); assert.equal(newer.result.conflicts[0].remote.data.description, 'Newer peer revision');
  command(a.store, 'entry.review', { id: 'collision', status: 'pending' }); await sync(a.client);
  const remote = await f.raw(a, 'GET', `/v1/teams/${team.id}/sync`); assert.equal(remote.body.records.at(-1).deleted, false); assert.equal(remote.body.records.at(-1).version, 2);
  assert.ok(!b.audit.filter(request => request.method === 'POST' && request.url.endsWith('/sync')).some(request => request.body.includes('Private pending collision')));
  command(b.store, 'entry.review', { id: 'collision', status: 'approved' });
  await sync(b.client, { resolutions: [{ kind: 'entries', id: 'collision', strategy: 'remote' }] });
  assert.equal(b.store.getState().entries[0].description, 'Newer peer revision');
});

test('HTTP sync follows 1000-event pagination and emits byte-bounded bodies for multibyte descriptions', async t => {
  const f = await fixture(t), a = await f.register(f.device('a')); const team = await f.team(a);
  const state = a.store.exportSnapshot();
  state.clients = Array.from({ length: 1001 }, (_, index) => ({ id: `client-${index}`, name: `Client ${index}`, hourlyRate: 0, keywords: [] }));
  state.entries = Array.from({ length: 300 }, (_, index) => entry(`entry-${index}`, { description: 'अ'.repeat(2000) }));
  a.store.importData(state); const result = await sync(a.client); assert.equal(result.result.pushed, 1301);
  const bodies = a.audit.filter(request => request.method === 'POST' && request.url.endsWith('/sync')).map(request => request.body);
  assert.ok(bodies.length >= 6); assert.ok(bodies.every(body => Buffer.byteLength(body) <= 1024 * 1024));
  const b = await f.login(f.device('b')); await run(b.client, 'team.select', { teamId: team.id }); await sync(b.client);
  assert.equal(b.store.getState().clients.length, 1001); assert.equal(b.store.getState().entries.length, 300);
  assert.ok(b.audit.some(request => /\/sync\?since=1000$/.test(request.url)));
  const standalone = syncBatches(Array.from({ length: 250 }, (_, index) => ({ kind: 'reports', id: String(index), data: { text: 'अ'.repeat(4000) }, baseVersion: 0 })));
  assert.ok(standalone.length > 1); assert.ok(standalone.every(changes => Buffer.byteLength(JSON.stringify({ changes })) <= 1024 * 1024));
});

test('A rejected remote merge leaves local state and its pull cursor unchanged', async t => {
  const f = await fixture(t), a = await f.register(f.device('a')); const team = await f.team(a);
  command(a.store, 'client.upsert', { id: 'good-client', name: 'Shared client' }); await sync(a.client);
  let corrupt = true;
  const b = await f.login(f.device('b', { intercept: async (url, config) => {
    if (!corrupt || config.method !== 'GET' || !String(url).includes('/sync?')) return null;
    const response = await fetch(url, config), body = await response.json();
    body.records.push({ kind: 'entries', id: 'bad-entry', ownerId: a.client.status().user.id, version: 1, deleted: false, data: { ...entry('bad-entry'), start: 'invalid timestamp' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  } }));
  await run(b.client, 'team.select', { teamId: team.id }); const before = b.store.getState();
  await assert.rejects(sync(b.client), /ISO timestamp/); assert.deepEqual(b.store.getState(), before); assert.equal(b.client.status().lastSyncAt, null);
  corrupt = false; await sync(b.client);
  assert.equal(b.store.getState().clients[0].id, 'good-client'); assert.equal(b.audit.filter(request => request.url.endsWith('/sync?since=0')).length, 2);
});

test('Workspace reset invalidates an in-flight or queued sync before it can erase shared data', async t => {
  const f = await fixture(t), a = await f.register(f.device('a')); const team = await f.team(a);
  command(a.store, 'entry.upsert', entry('remote-entry')); await sync(a.client);
  let blockRoute = null, entered = deferred(), release = deferred();
  const b = await f.login(f.device('b', { intercept: async (url, config) => {
    if (blockRoute && String(url).includes(blockRoute)) { const match = blockRoute; blockRoute = null; const response = await fetch(url, config); entered.resolve(match); await release.promise; return response; }
    return null;
  } }));
  await run(b.client, 'team.select', { teamId: team.id }); await sync(b.client);
  blockRoute = '/sync?'; const inFlight = sync(b.client); await entered.promise;
  b.client.pauseSync(); command(b.store, 'workspace.create', { displayName: 'Fresh workspace' }); release.resolve();
  await assert.rejects(inFlight, /workspace changed/); assert.equal(b.store.getState().entries.length, 0);
  entered = deferred(); release = deferred(); blockRoute = '/members';
  const members = run(b.client, 'team.members'); await entered.promise;
  const queued = sync(b.client), queuedAuto = run(b.client, 'sync.auto', { enabled: true, consent: true });
  b.client.pauseSync(); command(b.store, 'workspace.create', { displayName: 'Another workspace' }); release.resolve();
  await members; await assert.rejects(queued, /workspace changed/); await assert.rejects(queuedAuto, /workspace changed/);
  assert.equal(b.client.status().autoSync, false);
  const remote = await f.raw(a, 'GET', `/v1/teams/${team.id}/sync`); assert.equal(remote.body.records.at(-1).deleted, false);
});

test('A bound workspace cannot publish into another team, and sync gates precede network sharing', async t => {
  const f = await fixture(t), a = await f.register(f.device('a')); const first = await f.team(a);
  command(a.store, 'entry.upsert', entry('private-to-first')); await sync(a.client);
  const second = await f.team(a, 'Other team'); await assert.rejects(sync(a.client), /another account or team/);
  const remote = await f.raw(a, 'GET', `/v1/teams/${second.id}/sync`); assert.equal(remote.body.records.length, 0);
  await run(a.client, 'team.select', { teamId: first.id }); await assert.rejects(run(a.client, 'sync', {}), /Approve synchronization/);
  const b = await f.register(f.device('b'), 'second-user@example.test'); const invitation = await run(a.client, 'team.invite', { email: 'second-user@example.test', role: 'member' });
  await run(b.client, 'team.join', { code: invitation.result.code }); await run(a.client, 'logout'); await run(a.client, 'login', { email: 'second-user@example.test', password: 'a long synthetic password' });
  await run(a.client, 'team.select', { teamId: first.id }); await assert.rejects(sync(a.client), /another account or team/);
  command(a.store, 'workspace.demo'); await assert.rejects(sync(a.client), /real workspace/);
  assert.throws(() => serverUrl('http://example.test'), /HTTPS/); assert.throws(() => serverUrl('https://user:pass@example.test'), /credentials/);
});

test('Credential persistence is session-only without secure storage and encrypted sessions restore', async t => {
  const f = await fixture(t), plain = await f.register(f.device('plain')); const team = await f.team(plain);
  await run(plain.client, 'sync.auto', { enabled: true, consent: true });
  const savedPlain = fs.readFileSync(plain.file, 'utf8'); assert.ok(!savedPlain.includes(plain.sessions[0])); assert.ok(!JSON.parse(savedPlain).tokenCipher);
  const restoredPlain = createCloudClient({ file: plain.file, store: plain.store }); assert.equal(restoredPlain.status().authenticated, false); assert.equal(restoredPlain.status().autoSync, false);
  const key = crypto.randomBytes(32);
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv), ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]); },
    decryptString: value => { const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); },
  };
  const secure = await f.login(f.device('secure', { secureStorage })); await run(secure.client, 'team.select', { teamId: team.id });
  const savedSecure = fs.readFileSync(secure.file, 'utf8'); assert.ok(JSON.parse(savedSecure).tokenCipher); assert.ok(!savedSecure.includes(secure.sessions[0]));
  const restored = createCloudClient({ file: secure.file, store: secure.store, secureStorage }); assert.equal(restored.status().authenticated, true);
  assert.equal((await run(restored, 'team.members')).result.members.length, 1);
  await run(restored, 'logout'); assert.equal(createCloudClient({ file: secure.file, store: secure.store, secureStorage }).status().authenticated, false);
});

test('Native cloud routing forwards analytics filters, strict member patches, OAuth callback, and disconnect', async t => {
  const providerCalls = [];
  const f = await fixture(t, {
    env: { RIZE_PUBLIC_ORIGIN: 'https://rize.example.test', RIZE_GOOGLE_CLIENT_ID: 'synthetic-google-id', RIZE_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret', RIZE_SECRET_KEY: Buffer.alloc(32, 17).toString('base64') },
    providerFetchImpl: async (url, options) => { providerCalls.push({ url, body: options.body }); if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600 }), { status: 200 }); throw new Error('Unexpected synthetic provider call'); },
  });
  const a = await f.register(f.device('a')); const team = await f.team(a); const b = await f.register(f.device('b'), 'member@example.test');
  const invite = await run(a.client, 'team.invite', { email: 'member@example.test', role: 'member' }); await run(b.client, 'team.join', { code: invite.result.code });
  const memberId = b.client.status().user.id;
  const updated = await run(a.client, 'team.member.update', { userId: memberId, finance: true, resourcing: true }); assert.equal(updated.result.member.finance, true);
  const analytics = await run(a.client, 'analytics', { startDate: '2026-10-16', endDate: '2026-10-17', timezone: 'Asia/Kolkata', capacityHours: 32 });
  assert.equal(analytics.result.timezone, 'Asia/Kolkata'); assert.ok(a.audit.at(-1).url.includes('capacityHours=32'));
  const oauth = await run(a.client, 'integrations.oauth.start', { provider: 'google' }); const authorization = new URL(oauth.result.authorizationUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com'); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const state = authorization.searchParams.get('state');
  const callback = await fetch(`${f.origin}/v1/oauth/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`); const body = await callback.json();
  assert.equal(callback.status, 200, JSON.stringify(body)); assert.equal(body.connected, true); assert.ok(!JSON.stringify(body).includes('synthetic-access'));
  assert.ok(String(providerCalls[0].body).includes('code_verifier='));
  assert.equal((await fetch(`${f.origin}/v1/oauth/google/callback?state=${state}&code=duplicate`)).status, 400);
  const connected = await run(a.client, 'integrations.list'); assert.equal(connected.result.integrations.find(item => item.provider === 'google').connected, true);
  assert.equal((await run(a.client, 'integrations.disconnect', { provider: 'google' })).result.disconnected, true);
  assert.equal((await run(a.client, 'integrations.list')).result.integrations.find(item => item.provider === 'google').connected, false);
  assert.equal((await run(a.client, 'team.member.remove', { userId: memberId })).result.ok, true);
  assert.equal((await run(b.client, 'teams')).result.teams.length, 0);
});

test('A finance member can import invoice snapshots without access to peers individual time records', async t => {
  const f = await fixture(t), owner = await f.register(f.device('owner')); const team = await f.team(owner);
  command(owner.store, 'client.upsert', { id: 'client', name: 'Client', hourlyRate: 100 });
  command(owner.store, 'entry.upsert', entry('owner-time', { clientId: 'client', billable: true }));
  command(owner.store, 'invoice.create', { clientId: 'client', startDate: '2026-10-01', endDate: '2026-10-31' }); await sync(owner.client);
  const finance = await f.register(f.device('finance'), 'finance@example.test');
  const invitation = await run(owner.client, 'team.invite', { email: 'finance@example.test', role: 'member' });
  await run(finance.client, 'team.join', { code: invitation.result.code });
  await run(owner.client, 'team.member.update', { userId: finance.client.status().user.id, finance: true });
  const result = await sync(finance.client); assert.equal(result.result.conflicts.length, 0);
  assert.equal(finance.store.getState().entries.length, 0); assert.equal(finance.store.getState().business.invoices.length, 1);
  assert.equal(finance.store.getState().business.invoices[0].lines[0].entryId, 'owner-time');
});
