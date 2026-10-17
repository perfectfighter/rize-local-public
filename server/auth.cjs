'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const SESSION_TTL = 7 * 86400000;
// OWASP's 32 MiB scrypt configuration; parallel authentication is bounded by HTTP.
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

class HttpError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}

function cleanText(value, name, max = 200, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new HttpError(400, `${name} must be text of at most ${max} characters.`);
  const text = value.trim();
  if (!allowEmpty && !text) throw new HttpError(400, `${name} is required.`);
  return text;
}

function emailAddress(value) {
  const email = cleanText(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw new HttpError(400, 'Password must contain 12 to 256 characters.');
  return value;
}

async function passwordHash(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(value, salt, 64, SCRYPT);
  return `scrypt:32768:8:3:${salt}:${hash.toString('hex')}`;
}

// A dummy derivation keeps nonexistent-user authentication on the same slow path.
const DUMMY = `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`;
async function checkPassword(value, stored = DUMMY) {
  const [kind, n, r, p, salt, expected] = stored.split(':');
  if (kind !== 'scrypt' || n !== '32768' || r !== '8' || p !== '3' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const actual = await scrypt(value, salt, 64, SCRYPT);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

const publicUser = row => ({ id: row.id, email: row.email, name: row.name });

function issueSession(db, userId, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(digest(token), userId, now + SESSION_TTL, now);
  return token;
}

function authenticated(db, req, now) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
  if (!match) throw new HttpError(401, 'Sign in to continue.', 'UNAUTHENTICATED');
  const row = db.prepare('SELECT u.*,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(digest(match[1]));
  if (!row || row.expires_at <= now) {
    if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(match[1]));
    throw new HttpError(401, 'Your session has expired. Sign in again.', 'UNAUTHENTICATED');
  }
  return publicUser(row);
}

module.exports = { HttpError, cleanText, emailAddress, password, passwordHash, checkPassword, publicUser, issueSession, authenticated, digest, SESSION_TTL };
