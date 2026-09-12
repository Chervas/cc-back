'use strict';

const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { audit } = require('./contracts');
const { fail } = require('./errors');

class BrokerStore {
  constructor(filename) {
    if (!path.isAbsolute(filename)) throw Error('Absolute private state path required');
    const parent = path.dirname(filename);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if ((fs.statSync(parent).mode & 0o077) !== 0 || fs.lstatSync(parent).isSymbolicLink()) throw Error('Private state directory required');
    if (fs.existsSync(filename) && (fs.lstatSync(filename).isSymbolicLink() || (fs.statSync(filename).mode & 0o077) !== 0)) throw Error('Private state file required');
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connections (ref TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('active','blocked','revoked','expired')),
        revision INTEGER NOT NULL, expires_at INTEGER, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (principal TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(principal,nonce));
      CREATE TABLE IF NOT EXISTS rate_windows (principal TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(principal,window));
      CREATE TABLE IF NOT EXISTS commands (principal TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(principal,id));
      CREATE TABLE IF NOT EXISTS audit_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        lease TEXT, lease_until INTEGER, receipt TEXT);
      CREATE INDEX IF NOT EXISTS audit_pending ON audit_outbox(delivered_at,next_attempt,lease_until);`);
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  seedConnection(ref, { state = 'blocked', expiresAt = null } = {}) {
    // A restart/config reload must never overwrite a durable block/revocation.
    this.db.prepare('INSERT OR IGNORE INTO connections VALUES (?,?,1,?,?)').run(ref, state, expiresAt, 'initial_policy');
  }
  connection(ref, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM connections WHERE ref=?').get(ref);
    if (!row || row.state !== 'active' || row.expires_at !== null && row.expires_at <= now) fail('connection_blocked');
    return row;
  }
  block(ref, event, state = 'blocked') {
    if (!['blocked', 'revoked', 'expired'].includes(state)) fail('invalid_request');
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE connections SET state=?,revision=revision+1,reason=? WHERE ref=?').run(state, state, ref);
      if (!result.changes) fail('invalid_request');
      this.appendAudit(event);
    });
  }
  acceptNonce(principal, nonce, now, maxPerMinute) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
      if (this.db.prepare('SELECT 1 FROM nonces WHERE principal=? AND nonce=?').get(principal, nonce)) fail('request_replayed');
      const window = Math.floor(now / 60000);
      this.db.prepare('DELETE FROM rate_windows WHERE window < ?').run(window - 1);
      this.db.prepare('INSERT INTO rate_windows VALUES (?,?,1) ON CONFLICT(principal,window) DO UPDATE SET count=count+1').run(principal, window);
      if (this.db.prepare('SELECT count FROM rate_windows WHERE principal=? AND window=?').get(principal, window).count > maxPerMinute) fail('rate_limited');
      this.db.prepare('INSERT INTO nonces VALUES (?,?,?)').run(principal, nonce, now + 120000);
    });
  }
  reserve(principal, id, digest, event, maxBacklog, now) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM commands WHERE principal=? AND id=?').get(principal, id);
      if (existing) {
        if (existing.digest !== digest) fail('idempotency_conflict');
        if (existing.state !== 'completed') fail('outcome_unknown');
        return JSON.parse(existing.result);
      }
      if (this.backlog().pending >= maxBacklog) fail('audit_unavailable');
      this.appendAudit(event);
      this.db.prepare("INSERT INTO commands VALUES (?,?,?,'started',NULL,?)").run(principal, id, digest, now);
      return null;
    });
  }
  complete(principal, id, result, event) {
    this.transaction(() => {
      this.appendAudit(event);
      this.db.prepare("UPDATE commands SET state='completed',result=? WHERE principal=? AND id=? AND state='started'").run(JSON.stringify(result), principal, id);
    });
  }
  uncertain(principal, id, event) {
    this.transaction(() => {
      this.appendAudit(event);
      this.db.prepare("UPDATE commands SET state='unknown' WHERE principal=? AND id=? AND state='started'").run(principal, id);
    });
  }
  appendAudit(event) {
    const text = JSON.stringify(audit(event));
    const digest = createHash('sha256').update(text).digest('hex');
    const existing = this.db.prepare('SELECT digest FROM audit_outbox WHERE id=?').get(event.eventId);
    if (existing && existing.digest !== digest) fail('idempotency_conflict');
    this.db.prepare('INSERT OR IGNORE INTO audit_outbox(id,event,digest,created_at) VALUES (?,?,?,?)')
      .run(event.eventId, text, digest, Date.parse(event.occurredAt));
  }
  backlog() {
    return this.db.prepare('SELECT COUNT(*) AS pending,MIN(created_at) AS oldestAt FROM audit_outbox WHERE delivered_at IS NULL').get();
  }
  claim(now, leaseMs = 30000) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM audit_outbox WHERE delivered_at IS NULL AND next_attempt<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY seq LIMIT 1').get(now, now);
      if (!row) return null;
      const lease = randomUUID();
      this.db.prepare('UPDATE audit_outbox SET lease=?,lease_until=? WHERE id=?').run(lease, now + leaseMs, row.id);
      return { ...row, lease };
    });
  }
  acknowledge(row, receipt, now) {
    if (!receipt || typeof receipt.versionId !== 'string' || !receipt.versionId || receipt.digest !== row.digest) fail('audit_unavailable');
    this.db.prepare('UPDATE audit_outbox SET delivered_at=?,receipt=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?')
      .run(now, JSON.stringify({ versionId: receipt.versionId, digest: receipt.digest }), row.id, row.lease);
  }
  retry(row, now) {
    const wait = Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 12));
    this.db.prepare('UPDATE audit_outbox SET attempts=attempts+1,next_attempt=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?')
      .run(now + wait, row.id, row.lease);
  }
  async backup(filename) {
    if (!path.isAbsolute(filename) || (fs.statSync(path.dirname(filename)).mode & 0o077) !== 0) throw Error('Private backup path required');
    fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    await backup(this.db, filename);
  }
  close() { this.db.close(); }
}
module.exports = { BrokerStore };
