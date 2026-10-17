'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDatabase(location) {
  if (location !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(location);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
      finance INTEGER NOT NULL DEFAULT 0, resourcing INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL, PRIMARY KEY(team_id,user_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      email TEXT NOT NULL, role TEXT NOT NULL, inviter_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL, used_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS records (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
      data TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY(team_id,kind,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL,
      kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL,
      data TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS events_team_cursor ON events(team_id,cursor);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS kv (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(team_id,namespace,key)
    ) STRICT;
  `);
  if (location !== ':memory:') {
    // The database contains accounts and potentially encrypted provider secrets.
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(location + suffix, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

module.exports = { openDatabase, transaction };
