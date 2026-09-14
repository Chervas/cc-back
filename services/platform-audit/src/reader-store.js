'use strict';
const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs'); const path = require('node:path');
const { createHash } = require('node:crypto'); const { fail } = require('./reader-protocol');
class ReaderStore {
  constructor(filename) {
    if (!path.isAbsolute(filename)) fail();
    const parent = path.dirname(filename); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(parent) !== parent || (fs.statSync(parent).mode & 0o077)) fail();
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    if (fs.realpathSync(filename) !== filename || (fs.statSync(filename).mode & 0o077)) fail();
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; '
      + 'CREATE TABLE IF NOT EXISTS nonces(principal TEXT,nonce TEXT,expires INTEGER,PRIMARY KEY(principal,nonce)); '
      + 'CREATE TABLE IF NOT EXISTS windows(principal TEXT,window INTEGER,count INTEGER,PRIMARY KEY(principal,window)); '
      + 'CREATE TABLE IF NOT EXISTS reads(id TEXT PRIMARY KEY,principal TEXT,mode TEXT,actor TEXT,session TEXT,refs_digest TEXT,count INTEGER,started INTEGER,finished INTEGER,verified INTEGER);');
  }
  accept(principal, input, now) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM nonces WHERE expires<?').run(now);
      if (this.db.prepare('SELECT 1 FROM nonces WHERE principal=? AND nonce=?').get(principal, input.nonce)) fail('audit_reader_replayed');
      if (this.db.prepare('SELECT COUNT(*) AS n FROM reads').get().n >= 100000) fail('audit_reader_limited');
      const window = Math.floor(now / 60000); this.db.prepare('DELETE FROM windows WHERE window<?').run(window - 1);
      this.db.prepare('INSERT INTO windows VALUES(?,?,1) ON CONFLICT(principal,window) DO UPDATE SET count=count+1').run(principal, window);
      if (this.db.prepare('SELECT count FROM windows WHERE principal=? AND window=?').get(principal, window).count > 30) fail('audit_reader_limited');
      this.db.prepare('INSERT INTO nonces VALUES(?,?,?)').run(principal, input.nonce, now + 120000);
      this.db.prepare('INSERT INTO reads VALUES(?,?,?,?,?,?,?,?,NULL,NULL)').run(input.requestId, principal, input.mode, input.actorId,
        input.sessionRef, createHash('sha256').update(JSON.stringify(input.refs)).digest('hex'), input.refs.length, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  complete(input, result, now) {
    const changed = this.db.prepare('UPDATE reads SET finished=?,verified=? WHERE id=? AND finished IS NULL')
      .run(now, result.results.filter(v => v.status === 'verified').length, input.requestId);
    if (changed.changes !== 1) fail('audit_reader_unavailable');
  }
  close() { this.db.close(); }
}
module.exports = { ReaderStore };
