'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const KINDS = ['clients', 'projects', 'tasks', 'entries', 'contracts', 'allocations', 'invoices'];
const copy = value => structuredClone(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
const encoded = value => JSON.stringify(canonical(value));
const keyOf = record => `${record.kind}:${record.id}`;
const MAX_SYNC_BODY = 1024 * 1024;
function syncBatches(changes) {
  const batches = []; let batch = [], bytes = Buffer.byteLength('{"changes":[]}');
  for (const change of changes) {
    const size = Buffer.byteLength(JSON.stringify(change));
    if (size + Buffer.byteLength('{"changes":[]}') > MAX_SYNC_BODY) throw new Error('One shared record exceeds the server request limit. Reduce its size before synchronizing.');
    if (batch.length && (batch.length >= 250 || bytes + size + 1 > MAX_SYNC_BODY)) { batches.push(batch); batch = []; bytes = Buffer.byteLength('{"changes":[]}'); }
    bytes += size + (batch.length ? 1 : 0); batch.push(change);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function serverUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Enter a server URL.');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use an HTTPS server origin, or HTTP on localhost. Do not include credentials or a path.');
  }
  return url.origin;
}
function workData(kind, data, id) {
  const value = { ...copy(data), id };
  if (kind === 'entries') {
    return { id, start: value.start, end: value.end, description: value.description || '',
      durationMs: Date.parse(value.end) - Date.parse(value.start), category: value.category || 'neutral',
      status: 'approved', source: ['manual', 'automatic', 'timer'].includes(value.source) ? value.source : 'manual',
      clientId: value.clientId || '', projectId: value.projectId || '', taskId: value.taskId || '', billable: !!value.billable,
    };
  }
  return value;
}
function localRecords(state) {
  const records = [];
  for (const kind of KINDS) {
    const items = ['clients', 'projects', 'tasks', 'entries'].includes(kind) ? state[kind] : state.business?.[kind];
    for (const item of items || []) {
      if (kind === 'entries' && (item.status !== 'approved' || item.category === 'break')) continue;
      records.push({ kind, id: item.id, data: workData(kind, item, item.id) });
    }
  }
  return new Map(records.map(record => [keyOf(record), record]));
}
function createCloudClient({ file, store, secureStorage, fetchImpl = globalThis.fetch, now = Date.now, onChange = () => {} } = {}) {
  if (!store?.getState || !store?.mergeShared) throw new Error('Cloud sync needs a compatible workspace store.');
  let config = { version: 1, serverUrl: '', user: null, teams: [], teamId: '', autoSync: false, teamSync: {}, workspaceTeams: {} };
  let token = '';
  let storageMessage = '';
  let executingSync = false;
  let syncEpoch = 0;
  let serialization = Promise.resolve();
  const canEncrypt = () => !!secureStorage?.isEncryptionAvailable?.();
  if (file && fs.existsSync(file)) {
    try {
      if (fs.statSync(file).size > 40 * 1024 * 1024) throw new Error('Cloud configuration is oversized.');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1) throw new Error('Unsupported cloud configuration version.');
      config = { ...config, ...saved, serverUrl: saved.serverUrl ? serverUrl(saved.serverUrl) : '', teamSync: saved.teamSync || {} };
      delete config.tokenCipher;
      if (saved.tokenCipher && canEncrypt()) token = secureStorage.decryptString(Buffer.from(saved.tokenCipher, 'base64'));
      else if (saved.tokenCipher) storageMessage = 'Sign in again: secure credential storage is unavailable.';
    } catch { storageMessage = 'The cloud connection could not be restored. Configure it again; local work is preserved.'; }
  }
  function meta() {
    const scope = `${store.getState().workspaceId}:${config.user?.id || ''}:${config.teamId}`;
    return config.teamSync[scope] ||= { cursor: 0, versions: {}, baselines: {}, owners: {}, conflicts: [], lastSyncAt: null };
  }
  function status() {
    const current = config.teamId ? meta() : null;
    return copy({ serverUrl: config.serverUrl, configured: !!config.serverUrl, authenticated: !!token,
      user: token ? config.user : null, teams: token ? config.teams : [], teamId: token ? config.teamId : '',
      autoSync: !!(token && config.autoSync), lastSyncAt: current?.lastSyncAt || null,
      conflicts: current?.conflicts || [], credentialStorage: canEncrypt() ? 'encrypted' : 'session-only', message: storageMessage });
  }
  function persist() {
    if (!file) { onChange(status()); return; }
    const saved = copy(config);
    if (token && canEncrypt()) saved.tokenCipher = secureStorage.encryptString(token).toString('base64');
    // A platform without secure storage never writes authentication tokens as plaintext.
    const temporary = `${file}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(saved);
    if (Buffer.byteLength(serialized) > 40 * 1024 * 1024) throw new Error('Cloud synchronization metadata exceeds 40 MiB. Export a backup and use a separate workspace before sharing more records.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
    catch (error) { try { fs.unlinkSync(temporary); } catch {} throw new Error(`Could not save cloud settings: ${error.message}`); }
    onChange(status());
  }
  async function request(method, route, body, authenticated = true) {
    if (!config.serverUrl) throw new Error('Configure your Rize Local server first.');
    if (authenticated && !token) throw new Error('Sign in to your server first.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetchImpl(config.serverUrl + route, { method, signal: controller.signal, redirect: 'error',
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      let raw = '';
      if (response.body?.[Symbol.asyncIterator]) {
        let size = 0; const chunks = [];
        for await (const chunk of response.body) { size += chunk.byteLength; if (size > 12 * 1024 * 1024) { controller.abort(); throw new Error('Server response exceeds the workspace size limit.'); } chunks.push(Buffer.from(chunk)); }
        raw = Buffer.concat(chunks).toString('utf8');
      } else { raw = await response.text(); if (Buffer.byteLength(raw) > 12 * 1024 * 1024) throw new Error('Server response exceeds the workspace size limit.'); }
      let result;
      try { result = raw ? JSON.parse(raw) : {}; } catch { throw new Error('The server returned an invalid response.'); }
      if (!response.ok) {
        if (response.status === 401 && authenticated) { token = ''; config.autoSync = false; persist(); }
        const error = new Error(typeof result.error === 'string' ? result.error.slice(0, 500) : `Server request failed (${response.status}).`);
        error.code = result.code; error.status = response.status; throw error;
      }
      return result;
    } catch (error) { if (error.name === 'AbortError') throw new Error('The server request timed out.'); throw error; }
    finally { clearTimeout(timeout); }
  }
  const teamRoute = suffix => {
    if (!config.teamId) throw new Error('Select or create a team first.');
    return `/v1/teams/${encodeURIComponent(config.teamId)}${suffix}`;
  };
  async function refreshTeams() { const data = await request('GET', '/v1/teams'); config.teams = data.teams || []; if (config.teamId && !config.teams.some(team => team.id === config.teamId)) { config.teamId = ''; config.autoSync = false; } persist(); return data; }
  function eligible(kind, record, currentMeta) {
    const team = config.teams.find(item => item.id === config.teamId);
    const role = team?.role || team?.membership?.role || 'viewer';
    if (role === 'viewer') return false;
    if (['contracts', 'invoices'].includes(kind)) return role === 'owner' || !!(team?.finance || team?.membership?.finance);
    if (kind === 'allocations') return role === 'owner' || !!(team?.resourcing || team?.membership?.resourcing);
    if (role === 'owner' || role === 'admin') return true;
    if (kind === 'entries') return !currentMeta.owners[keyOf(record)] || currentMeta.owners[keyOf(record)] === config.user?.id;
    return false;
  }
  function normalizeRemote(record) {
    if (!record || !KINDS.includes(record.kind) || typeof record.id !== 'string' || !Number.isSafeInteger(record.version) || record.version < 1) return null;
    return { ...copy(record), deleted: !!record.deleted, data: record.deleted ? null : workData(record.kind, record.data || {}, record.id) };
  }
  async function sync(payload = {}) {
    if (payload.consent !== true) throw new Error('Approve synchronization of reviewed time and shared work records first.');
    if (store.getState().demo) throw new Error('Create a real workspace before synchronizing.');
    if (executingSync) throw new Error('Synchronization is already running.');
    executingSync = true;
    const workspaceId = store.getState().workspaceId, epoch = syncEpoch;
    const guard = () => { if (epoch !== syncEpoch || store.getState().workspaceId !== workspaceId) throw new Error('The workspace changed during synchronization. Start sync again in the current workspace.'); };
    let applied = 0, pushed = 0;
    const skipped = [];
    try {
      await refreshTeams();
      guard();
      if (!config.teamId) throw new Error('Select or create a team first.');
      config.workspaceTeams ||= {};
      const binding = config.workspaceTeams[store.getState().workspaceId];
      const target = `${config.serverUrl}:${config.user?.id || ''}:${config.teamId}`;
      if (binding && binding !== target) throw new Error('This workspace is synchronized with another account or team. Create a separate workspace before sharing here.');
      config.workspaceTeams[store.getState().workspaceId] = target;
      const current = meta();
      current.versions ||= {}; current.baselines ||= {}; current.owners ||= {}; current.conflicts ||= [];
      for (const resolution of payload.resolutions || []) {
        const index = current.conflicts.findIndex(item => item.kind === resolution.kind && item.id === resolution.id);
        if (index < 0) continue;
        const conflict = current.conflicts[index];
        if (!['local', 'remote'].includes(resolution.strategy)) throw new Error('Choose the local or remote conflict version.');
        if (conflict.kind === 'entries' && store.getState().entries.some(entry => entry.id === conflict.id && (entry.status !== 'approved' || entry.category === 'break'))) throw new Error('Review or rename the private local entry before resolving this ID collision.');
        if (conflict.remote && resolution.strategy === 'remote') { store.mergeShared([conflict.remote]); applied++; }
        if (conflict.remote) {
          const key = keyOf(conflict.remote); current.versions[key] = conflict.remote.version; current.owners[key] = conflict.remote.ownerId;
          current.baselines[key] = conflict.remote.deleted ? null : encoded(conflict.remote.data);
        }
        current.conflicts.splice(index, 1);
      }
      async function pull() {
        let pages = 0;
        do {
        const before = Number(current.cursor) || 0;
        const response = await request('GET', teamRoute(`/sync?since=${Number(current.cursor) || 0}`));
        guard();
        const locals = localRecords(store.getState());
        const privateEntryIds = new Set(store.getState().entries.filter(entry => entry.status !== 'approved' || entry.category === 'break').map(entry => entry.id));
        const accepted = [], metadata = [];
        const remoteRecords = new Map();
        for (const raw of response.records || []) { const record = normalizeRemote(raw); if (!record) continue; const previous = remoteRecords.get(keyOf(record)); if (!previous || record.version > previous.version) remoteRecords.set(keyOf(record), record); }
        const newConflicts = [];
        for (const remote of remoteRecords.values()) {
          const key = keyOf(remote), local = locals.get(key), previous = current.baselines[key];
          const existingConflict = current.conflicts.find(item => keyOf(item) === key);
          if (existingConflict) { if (remote.version > (existingConflict.remote?.version || 0)) newConflicts.push({ ...existingConflict, remote }); continue; }
          if (remote.kind === 'entries' && privateEntryIds.has(remote.id)) { newConflicts.push({ kind: remote.kind, id: remote.id, local: null, remote, privateLocal: true, reason: 'An unreviewed or private local entry uses this ID. Review or rename it before resolving this collision.' }); continue; }
          const hasBaseline = Object.hasOwn(current.baselines, key);
          const localText = local ? encoded(local.data) : null;
          const remoteText = remote.deleted ? null : encoded(remote.data);
          const localChanged = hasBaseline ? localText !== previous : !!local;
          if (remote.version > (current.versions[key] || 0) && localChanged && localText !== remoteText) {
            newConflicts.push({ kind: remote.kind, id: remote.id, local: local?.data || null, remote, reason: 'Both this device and the server changed this record.' });
            continue;
          }
          if (remote.version <= (current.versions[key] || 0)) continue;
          if (!remote.deleted || hasBaseline) accepted.push(remote);
          metadata.push({ key, remote, remoteText });
        }
        if (accepted.length) { store.mergeShared(accepted); applied += accepted.length; }
        for (const conflict of newConflicts) { const index = current.conflicts.findIndex(item => keyOf(item) === keyOf(conflict)); if (index >= 0) current.conflicts[index] = conflict; else current.conflicts.push(conflict); }
        for (const { key, remote, remoteText } of metadata) { current.versions[key] = remote.version; current.baselines[key] = remoteText; current.owners[key] = remote.ownerId; }
        current.cursor = Math.max(Number(current.cursor) || 0, Number(response.cursor) || 0);
        if (!response.hasMore) break;
        if (current.cursor <= before || ++pages > 1000) throw new Error('The server returned an invalid synchronization cursor.');
        } while (true);
      }
      await pull();
      const locals = localRecords(store.getState()), pending = [];
      const privateEntryIds = new Set(store.getState().entries.filter(entry => entry.status !== 'approved' || entry.category === 'break').map(entry => entry.id));
      const blocked = new Set(current.conflicts.map(keyOf));
      for (const [key, record] of locals) {
        if (blocked.has(key) || encoded(record.data) === current.baselines[key]) continue;
        if (!eligible(record.kind, record, current)) { skipped.push({ kind: record.kind, id: record.id, reason: 'Your team role cannot publish changes to this record.' }); continue; }
        pending.push({ ...record, baseVersion: current.versions[key] || 0 });
      }
      for (const key of Object.keys(current.baselines)) {
        if (locals.has(key) || blocked.has(key) || current.baselines[key] === null) continue;
        const split = key.indexOf(':'), record = { kind: key.slice(0, split), id: key.slice(split + 1) };
        if (record.kind === 'entries' && privateEntryIds.has(record.id)) continue;
        if (KINDS.includes(record.kind) && eligible(record.kind, record, current)) pending.push({ ...record, baseVersion: current.versions[key], deleted: true });
      }
      for (const changes of syncBatches(pending)) {
        guard();
        const response = await request('POST', teamRoute('/sync'), { changes });
        guard();
        for (const raw of response.records || []) {
          const remote = normalizeRemote(raw); if (!remote) continue;
          const key = keyOf(remote); current.versions[key] = remote.version; current.baselines[key] = remote.deleted ? null : encoded(remote.data); current.owners[key] = remote.ownerId; pushed++;
        }
        for (const conflict of response.conflicts || []) {
          const local = locals.get(`${conflict.kind}:${conflict.id}`);
          const remote = normalizeRemote(conflict.current || conflict.remote);
          current.conflicts.push({ kind: conflict.kind, id: conflict.id, local: local?.data || null, remote, reason: conflict.error || conflict.message || 'The server has a different record version.' });
        }
        // Do not advance the pull cursor from a POST response: concurrent team
        // changes may have happened between the previous pull and this write.
      }
      await pull();
      current.lastSyncAt = new Date(now()).toISOString(); persist();
      return { result: { pushed, applied, skipped, conflicts: copy(current.conflicts), cursor: current.cursor, lastSyncAt: current.lastSyncAt }, workspace: store.getState() };
    } finally { executingSync = false; }
  }
  async function executeInner({ action, payload = {} } = {}) {
    if (typeof action !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid cloud command.');
    let result, workspace;
    if (action === 'status') result = status();
    else if (action === 'configure') {
      const next = serverUrl(payload.serverUrl);
      if (next !== config.serverUrl) { token = ''; config.user = null; config.teams = []; config.teamId = ''; config.autoSync = false; config.teamSync = {}; }
      config.serverUrl = next; storageMessage = ''; persist(); result = status();
    } else if (action === 'register' || action === 'login') {
      const data = await request('POST', `/v1/auth/${action}`, payload, false);
      if (typeof data.token !== 'string' || !data.user?.id) throw new Error('The server did not return a valid session.');
      token = data.token; config.user = data.user; storageMessage = ''; await refreshTeams(); result = { user: data.user };
    } else if (action === 'logout') {
      try { if (token) await request('POST', '/v1/auth/logout', {}); }
      finally { token = ''; config.user = null; config.teams = []; config.teamId = ''; config.autoSync = false; persist(); }
      result = { signedOut: true };
    } else if (action === 'teams') result = await refreshTeams();
    else if (action === 'team.create' || action === 'team.join') { result = await request('POST', action === 'team.create' ? '/v1/teams' : '/v1/teams/join', payload); await refreshTeams(); if (result.team?.id) config.teamId = result.team.id; config.autoSync = false; persist(); }
    else if (action === 'team.select') {
      await refreshTeams(); if (!config.teams.some(team => team.id === payload.teamId)) throw new Error('This account cannot access that team.');
      config.teamId = payload.teamId; config.autoSync = false; persist(); result = status();
    } else if (action === 'team.members') result = await request('GET', teamRoute('/members'));
    else if (action === 'team.invite') result = await request('POST', teamRoute('/invites'), payload);
    else if (action === 'team.member.update') { const { userId, ...patch } = payload; result = await request('PATCH', teamRoute(`/members/${encodeURIComponent(userId)}`), patch); await refreshTeams(); }
    else if (action === 'team.member.remove') { result = await request('DELETE', teamRoute(`/members/${encodeURIComponent(payload.userId)}`)); await refreshTeams(); }
    else if (action === 'analytics') { const query = new URLSearchParams(); for (const key of ['startDate', 'endDate', 'timezone']) if (typeof payload[key] === 'string') query.set(key, payload[key]); if (payload.capacityHours !== undefined) query.set('capacityHours', String(payload.capacityHours)); result = await request('GET', teamRoute('/analytics' + (query.size ? `?${query}` : ''))); }
    else if (action === 'sync') ({ result, workspace } = await sync(payload));
    else if (action === 'sync.auto') { if (payload.enabled && payload.consent !== true) throw new Error('Approve background synchronization first.'); if (payload.enabled && (!token || !config.teamId || store.getState().demo)) throw new Error('Select a team in a real workspace first.'); config.autoSync = !!payload.enabled; persist(); result = status(); }
    else {
      const routes = {
        'services.status': ['GET', '/status'], 'ai.chat': ['POST', '/ai/chat'], 'ai.tag': ['POST', '/ai/tag'], 'ai.report': ['POST', '/ai/report'],
        'ai.reports.list': ['GET', '/ai/reports'], 'ai.reports.save': ['POST', '/ai/reports'],
        'ai.skills.list': ['GET', '/ai/skills'], 'ai.skills.save': ['POST', '/ai/skills'], 'ai.routines.list': ['GET', '/ai/routines'], 'ai.routines.save': ['POST', '/ai/routines'],
        'integrations.list': ['GET', '/integrations'], 'calendar.import': ['POST', '/calendar/import'],
      };
      let route = routes[action];
      if (['ai.skills.delete', 'ai.routines.delete', 'ai.reports.delete'].includes(action)) route = ['DELETE', `/ai/${action.split('.')[1]}/${encodeURIComponent(payload.id)}`];
      if (['integrations.connect', 'integrations.sync', 'integrations.disconnect'].includes(action)) {
        if (!['linear', 'clickup', 'asana', 'google', 'microsoft'].includes(payload.provider)) throw new Error('Choose a supported integration.');
        route = [action === 'integrations.disconnect' ? 'DELETE' : 'POST', `/integrations/${payload.provider}${action === 'integrations.connect' ? '/connect' : action === 'integrations.sync' ? '/sync' : ''}`];
      }
      if (action === 'integrations.oauth.start') { if (!['google', 'microsoft'].includes(payload.provider)) throw new Error('Choose a supported OAuth provider.'); route = ['POST', `/integrations/${payload.provider}/oauth/start`]; }
      if (!route) throw new Error(`Unknown cloud action: ${action}`);
      result = await request(route[0], teamRoute('/services' + route[1]), route[0] === 'GET' || route[0] === 'DELETE' ? undefined : payload);
    }
    return { cloud: status(), result, ...(workspace ? { workspace } : {}) };
  }
  return { status, pauseSync() { syncEpoch++; config.autoSync = false; persist(); }, execute(command) {
    const epoch = syncEpoch, workspaceId = store.getState().workspaceId;
    const operation = serialization.then(() => {
      if ((command?.action === 'sync' || command?.action === 'sync.auto' && command.payload?.enabled) && (epoch !== syncEpoch || workspaceId !== store.getState().workspaceId)) throw new Error('The workspace changed before synchronization could start. Approve sync again in the current workspace.');
      return executeInner(command);
    });
    serialization = operation.catch(() => {}); return operation;
  } };
}

module.exports = { createCloudClient, serverUrl, localRecords, workData, syncBatches };
