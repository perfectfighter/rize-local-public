'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, transaction } = require('./database.cjs');
const { HttpError, cleanText, emailAddress, password, passwordHash, checkPassword, publicUser, issueSession, authenticated, digest, SESSION_TTL } = require('./auth.cjs');
const { authorize, createWorkspace, analytics } = require('./workspace.cjs');

const MAX_BODY = 1024 * 1024;
const INVITE_TTL = 7 * 86400000;
const isLoopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
const memberShape = row => ({ userId: row.user_id, name: row.name, email: row.email, role: row.role, finance: Boolean(row.finance), resourcing: Boolean(row.resourcing), joinedAt: new Date(row.joined_at).toISOString() });
const teamShape = row => ({ id: row.id, name: row.name, role: row.role, finance: Boolean(row.finance), resourcing: Boolean(row.resourcing) });

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return resolve({});
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return reject(new HttpError(415, 'Compressed requests are not supported.'));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) return reject(new HttpError(413, 'Request body exceeds 1 MiB.', 'TOO_LARGE'));
    const chunks = []; let size = 0, rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { if (!rejected) reject(new HttpError(413, 'Request body exceeds 1 MiB.', 'TOO_LARGE')); rejected = true; chunks.length = 0; }
      else if (!rejected) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (rejected) return;
      if (!size) return resolve({});
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Send application/json.'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
        resolve(body);
      } catch { reject(new HttpError(400, 'Request body must be a JSON object.')); }
    });
  });
}

function createService({ dbPath = path.resolve('data/rize-service.sqlite'), env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const db = openDatabase(dbPath);
  const origins = new Set((env.RIZE_ALLOWED_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean));
  for (const origin of origins) {
    try { const url = new URL(origin); if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !isLoopback(url.hostname))) throw new Error(); }
    catch { db.close(); throw new Error('RIZE_ALLOWED_ORIGINS must contain exact HTTPS origins, or loopback HTTP origins.'); }
  }
  const limits = new Map();
  let authInFlight = 0, routineTimer = null, routinesBusy = false;
  function limited(key, limit, windowMs) {
    const time = now();
    let value = limits.get(key);
    if (!value || value.reset <= time) { value = { count: 0, reset: time + windowMs }; limits.set(key, value); }
    value.count++;
    if (limits.size > 10000) { for (const [entry, item] of limits) if (item.reset <= time) limits.delete(entry); if (limits.size > 10000) limits.delete(limits.keys().next().value); }
    if (value.count > limit) throw new HttpError(429, 'Too many requests. Try again later.', 'RATE_LIMITED');
  }
  function memberFor(teamId, userId) {
    const member = db.prepare('SELECT * FROM members WHERE team_id=? AND user_id=?').get(teamId, userId);
    if (!member) throw new HttpError(404, 'Team not found.', 'NOT_FOUND');
    return member;
  }
  function memberResult(teamId, userId) {
    const row = db.prepare('SELECT m.*,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND m.user_id=?').get(teamId, userId);
    return row ? memberShape(row) : null;
  }
  function getTeam(teamId, userId) {
    const row = db.prepare('SELECT t.*,m.role,m.finance,m.resourcing FROM teams t JOIN members m ON m.team_id=t.id WHERE t.id=? AND m.user_id=?').get(teamId, userId);
    return row ? teamShape(row) : null;
  }
  function context({ req, res, body = {}, url, user, teamId, member, send = () => {}, fail = () => {} }) {
    const workspace = createWorkspace(db, teamId, user, member, now);
    return { req, res, body, url, user, teamId, member, env, fetchImpl, now, send, fail, authorize: action => authorize(member, action), ...workspace };
  }
  async function tickServices() {
    if (routinesBusy) return { skipped: true };
    routinesBusy = true;
    try {
      let services;
      try { services = require('./services.cjs'); } catch (error) { if (error.code === 'MODULE_NOT_FOUND' && error.message.includes("'./services.cjs'")) return { unavailable: true }; throw error; }
      if (typeof services.tickRoutines !== 'function') return { unavailable: true };
      const results = [];
      for (const team of db.prepare("SELECT t.id,m.user_id FROM teams t JOIN members m ON m.team_id=t.id WHERE m.role!='viewer' ORDER BY m.joined_at,m.user_id").all()) {
        const user = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(team.user_id));
        const ctx = context({ user, teamId: team.id, member: memberFor(team.id, user.id), url: new URL(`http://localhost/v1/teams/${team.id}/services/ai/routines`) });
        try { results.push({ teamId: team.id, userId: user.id, result: await services.tickRoutines(ctx) }); }
        catch { results.push({ teamId: team.id, userId: user.id, error: 'Routine execution failed; inspect the routine status.' }); }
      }
      return { results };
    } finally { routinesBusy = false; }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
      res.end(JSON.stringify(data));
    };
    const fail = (status, message, code = 'INVALID_REQUEST') => send(status, { error: message, code });
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (!origins.has(origin)) throw new HttpError(403, 'This origin is not allowed.', 'ORIGIN_DENIED');
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if (!origin || !origins.has(origin)) throw new HttpError(403, 'This origin is not allowed.', 'ORIGIN_DENIED');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); return;
      }
      const url = new URL(req.url, 'http://localhost');
      limited(`general:${req.socket.remoteAddress}`, 600, 60000);
      if (url.pathname === '/healthz' && req.method === 'GET') return send(200, { ok: true, service: 'rize-local', accounts: 'self-hosted', version: 1 });
      const callback = /^\/v1\/oauth\/(google|microsoft)\/callback$/.exec(url.pathname);
      if (callback && req.method === 'GET') {
        const services = require('./services.cjs');
        if (typeof services.resolveOAuthState !== 'function' || typeof services.completeOAuth !== 'function') throw new HttpError(503, 'OAuth is not available on this server.', 'OAUTH_UNAVAILABLE');
        const provider = callback[1], state = url.searchParams.get('state') || '';
        const pending = services.resolveOAuthState(provider, state, now());
        if (!pending?.teamId || !pending.userId) throw new HttpError(400, 'OAuth state is invalid or expired. Start the connection again.', 'INVALID_OAUTH_STATE');
        const row = db.prepare('SELECT * FROM users WHERE id=?').get(pending.userId);
        if (!row) throw new HttpError(400, 'OAuth account is no longer available.', 'INVALID_OAUTH_STATE');
        const member = memberFor(pending.teamId, pending.userId);
        if (!authorize(member, 'admin')) throw new HttpError(403, 'Only a current team owner or admin may complete this connection.', 'FORBIDDEN');
        await services.completeOAuth(context({ req, res, body: {}, url, user: publicUser(row), teamId: pending.teamId, member, send, fail }), provider, { state, code: url.searchParams.get('code'), error: url.searchParams.get('error') });
        return;
      }
      if (['/v1/auth/register', '/v1/auth/login'].includes(url.pathname) && req.method === 'POST') {
        limited(`auth:${req.socket.remoteAddress}`, 20, 15 * 60000);
        if (authInFlight >= 4) throw new HttpError(429, 'Authentication is busy. Try again shortly.', 'RATE_LIMITED');
        const body = await readBody(req);
        const email = emailAddress(body.email);
        limited(`auth-email:${email}`, 10, 15 * 60000);
        const secret = password(body.password);
        authInFlight++;
        try {
          if (url.pathname.endsWith('/register')) {
            if (env.RIZE_DISABLE_REGISTRATION === '1') throw new HttpError(403, 'Registration is disabled on this server.', 'REGISTRATION_DISABLED');
            const name = cleanText(body.name, 'Name', 80);
            const hash = await passwordHash(secret);
            const user = { id: crypto.randomUUID(), email, name };
            const token = transaction(db, () => {
              if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new HttpError(409, 'An account with this email already exists.', 'ACCOUNT_EXISTS');
              db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(user.id, email, name, hash, now());
              return issueSession(db, user.id, now());
            });
            return send(201, { token, user, expiresAt: new Date(now() + SESSION_TTL).toISOString() });
          }
          const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
          const valid = await checkPassword(secret, row?.password_hash);
          if (!row || !valid) throw new HttpError(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS');
          const token = issueSession(db, row.id, now());
          return send(200, { token, user: publicUser(row), expiresAt: new Date(now() + SESSION_TTL).toISOString() });
        } finally { authInFlight--; }
      }
      const user = authenticated(db, req, now());
      if (url.pathname === '/v1/auth/logout' && req.method === 'POST') { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(req.headers.authorization.slice(7))); return send(200, { ok: true }); }
      if (url.pathname === '/v1/me' && req.method === 'GET') return send(200, { user });
      if (url.pathname === '/v1/teams' && req.method === 'GET') {
        return send(200, { teams: db.prepare('SELECT t.*,m.role,m.finance,m.resourcing FROM teams t JOIN members m ON m.team_id=t.id WHERE m.user_id=? ORDER BY t.created_at,t.id').all(user.id).map(teamShape) });
      }
      if (url.pathname === '/v1/teams' && req.method === 'POST') {
        const body = await readBody(req); const name = cleanText(body.name, 'Team name', 100);
        if (db.prepare('SELECT COUNT(*) AS count FROM members WHERE user_id=?').get(user.id).count >= 50) throw new HttpError(400, 'Account team limit reached.');
        const id = crypto.randomUUID();
        transaction(db, () => { db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(id, name, now()); db.prepare("INSERT INTO members(team_id,user_id,role,finance,resourcing,joined_at) VALUES(?,?,'owner',1,1,?)").run(id, user.id, now()); });
        return send(201, { team: getTeam(id, user.id) });
      }
      if (url.pathname === '/v1/teams/join' && req.method === 'POST') {
        limited(`join:${user.id}`, 30, 3600000);
        const body = await readBody(req); const code = cleanText(body.code, 'Invitation code', 100);
        const teamId = transaction(db, () => {
          const invitation = db.prepare('SELECT * FROM invites WHERE code_hash=?').get(digest(code));
          if (!invitation || invitation.used_at !== null || invitation.expires_at <= now() || invitation.email !== user.email) throw new HttpError(400, 'Invitation is invalid, expired, used, or addressed to another email.', 'INVALID_INVITE');
          if (db.prepare('SELECT 1 FROM members WHERE team_id=? AND user_id=?').get(invitation.team_id, user.id)) throw new HttpError(409, 'You already belong to this team.', 'ALREADY_MEMBER');
          // A demoted inviter cannot leave a powerful valid invitation behind.
          const inviter = memberFor(invitation.team_id, invitation.inviter_id);
          if (!authorize(inviter, 'admin') || (invitation.role === 'admin' && inviter.role !== 'owner')) throw new HttpError(400, 'Invitation no longer has a permitted inviter.', 'INVALID_INVITE');
          db.prepare('INSERT INTO members(team_id,user_id,role,finance,resourcing,joined_at) VALUES(?,?,?,0,0,?)').run(invitation.team_id, user.id, invitation.role, now());
          db.prepare('UPDATE invites SET used_at=? WHERE code_hash=?').run(now(), digest(code));
          return invitation.team_id;
        });
        return send(200, { team: getTeam(teamId, user.id) });
      }
      const match = /^\/v1\/teams\/([A-Za-z0-9_-]{1,160})(?:\/(.*))?$/.exec(url.pathname);
      if (!match) throw new HttpError(404, 'Endpoint not found.', 'NOT_FOUND');
      const [, teamId, route = ''] = match;
      const member = memberFor(teamId, user.id);
      if (route === 'members' && req.method === 'GET') {
        const members = db.prepare('SELECT m.*,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY m.joined_at,m.user_id').all(teamId).map(memberShape);
        return send(200, { members });
      }
      if (route === 'invites' && req.method === 'POST') {
        if (!authorize(member, 'admin')) throw new HttpError(403, 'Only team owners and admins can invite members.', 'FORBIDDEN');
        limited(`invites:${user.id}`, 50, 3600000);
        const body = await readBody(req); const email = emailAddress(body.email); const role = body.role || 'member';
        if (!['admin', 'member', 'viewer'].includes(role) || (role === 'admin' && member.role !== 'owner')) throw new HttpError(403, 'You cannot invite that role.', 'FORBIDDEN');
        if (email === user.email) throw new HttpError(400, 'You already belong to this team.');
        const code = crypto.randomBytes(24).toString('base64url'), expiresAt = now() + INVITE_TTL;
        db.prepare('INSERT INTO invites(code_hash,team_id,email,role,inviter_id,expires_at) VALUES(?,?,?,?,?,?)').run(digest(code), teamId, email, role, user.id, expiresAt);
        return send(201, { code, expiresAt: new Date(expiresAt).toISOString(), invite: { email, role } });
      }
      const memberMatch = /^members\/([A-Za-z0-9_-]{1,160})$/.exec(route);
      if (memberMatch && req.method === 'PATCH') {
        if (!authorize(member, 'admin')) throw new HttpError(403, 'Only team owners and admins can manage members.', 'FORBIDDEN');
        const targetId = memberMatch[1]; const target = memberFor(teamId, targetId);
        const body = await readBody(req);
        if (!Object.keys(body).length || Object.keys(body).some(key => !['role', 'finance', 'resourcing'].includes(key))) throw new HttpError(400, 'Only role, finance, and resourcing may be changed.');
        const role = body.role ?? target.role;
        if (!['owner', 'admin', 'member', 'viewer'].includes(role)) throw new HttpError(400, 'Unknown role.');
        if (target.role === 'owner' && role !== 'owner' && db.prepare("SELECT COUNT(*) AS count FROM members WHERE team_id=? AND role='owner'").get(teamId).count <= 1) throw new HttpError(409, 'A team must retain an owner.', 'LAST_OWNER');
        if (targetId === user.id) throw new HttpError(403, 'Another owner must change your own membership.', 'SELF_EDIT');
        if (member.role !== 'owner' && (target.role === 'owner' || target.role === 'admin' || ['owner', 'admin'].includes(role) || body.finance !== undefined || body.resourcing !== undefined)) throw new HttpError(403, 'Only owners may change powerful roles or resource permissions.', 'FORBIDDEN');
        if (body.finance !== undefined && typeof body.finance !== 'boolean' || body.resourcing !== undefined && typeof body.resourcing !== 'boolean') throw new HttpError(400, 'Resource permissions must be booleans.');
        db.prepare('UPDATE members SET role=?,finance=?,resourcing=? WHERE team_id=? AND user_id=?').run(role, role === 'owner' ? 1 : role === 'viewer' ? 0 : Number(body.finance ?? Boolean(target.finance)), role === 'owner' ? 1 : role === 'viewer' ? 0 : Number(body.resourcing ?? Boolean(target.resourcing)), teamId, targetId);
        return send(200, { member: memberResult(teamId, targetId) });
      }
      if (memberMatch && req.method === 'DELETE') {
        const targetId = memberMatch[1]; const target = memberFor(teamId, targetId);
        if (targetId !== user.id && (!authorize(member, 'admin') || (member.role !== 'owner' && ['owner', 'admin'].includes(target.role)))) throw new HttpError(403, 'Your role cannot remove that member.', 'FORBIDDEN');
        if (target.role === 'owner' && db.prepare("SELECT COUNT(*) AS count FROM members WHERE team_id=? AND role='owner'").get(teamId).count <= 1) throw new HttpError(409, 'A team must retain an owner.', 'LAST_OWNER');
        transaction(db, () => {
          db.prepare('DELETE FROM members WHERE team_id=? AND user_id=?').run(teamId, targetId);
          db.prepare('DELETE FROM invites WHERE team_id=? AND inviter_id=? AND used_at IS NULL').run(teamId, targetId);
        });
        return send(200, { ok: true });
      }
      const workspace = createWorkspace(db, teamId, user, member, now);
      if (route === 'sync' && req.method === 'GET') { const since = url.searchParams.get('since') || '0'; if (!/^\d+$/.test(since)) throw new HttpError(400, 'Invalid sync cursor.'); return send(200, workspace.pull(Number(since))); }
      if (route === 'sync' && req.method === 'POST') { const body = await readBody(req); return send(200, workspace.sync(body.changes)); }
      if (route === 'analytics' && req.method === 'GET') return send(200, analytics(db, teamId, member, url.searchParams, now));
      if (route.startsWith('services/')) {
        const body = await readBody(req); let services;
        try { services = require('./services.cjs'); } catch (error) { if (error.code === 'MODULE_NOT_FOUND' && error.message.includes("'./services.cjs'")) throw new HttpError(503, 'Provider services are not installed.', 'SERVICES_UNAVAILABLE'); throw error; }
        if (await services.handleServices(context({ req, res, body, url, user, teamId, member, send, fail }))) return;
      }
      throw new HttpError(404, 'Endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      if (error instanceof HttpError || Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) fail(error.status, error.message, error.code);
      else fail(500, 'The server could not complete this request.', 'INTERNAL_ERROR');
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;
  async function listen(port = Number(env.PORT || env.RIZE_SERVER_PORT || 4791), host = env.RIZE_SERVER_HOST || '127.0.0.1') {
    if (!isLoopback(host)) {
      let publicUrl;
      try { publicUrl = new URL(env.RIZE_PUBLIC_ORIGIN); } catch { throw new Error('External binding requires RIZE_PUBLIC_ORIGIN=https://your-host and a TLS reverse proxy.'); }
      if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.origin !== env.RIZE_PUBLIC_ORIGIN) throw new Error('RIZE_PUBLIC_ORIGIN must be an exact HTTPS origin.');
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    if (env.RIZE_RUN_ROUTINES === '1') { routineTimer = setInterval(() => { tickServices().catch(() => {}); }, 60000); routineTimer.unref(); }
    return server.address();
  }
  async function close() {
    if (routineTimer) clearInterval(routineTimer);
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
  return { server, listen, close, tickServices };
}

if (require.main === module) {
  const service = createService({ dbPath: process.env.RIZE_DB_PATH || path.resolve('data/rize-service.sqlite') });
  service.listen().then(address => console.log(`Rize Local service listening on ${address.address}:${address.port}`)).catch(error => { console.error(error.message); process.exitCode = 1; service.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close().then(() => process.exit(0)));
}

module.exports = { createService };
