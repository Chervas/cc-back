'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'); const path = require('node:path'); const { createHash } = require('node:crypto');
const { fail } = require('./writer-protocol');
// Transport replay/rate journal only. Event bodies remain in the durable outbox and S3.
class WriterStore {
  constructor(filename) {
    if (!path.isAbsolute(filename)) fail();
    const parent = path.dirname(filename); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(parent) !== parent || (fs.statSync(parent).mode & 0o077)) fail();
    if (!fs.existsSync(filename)) fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    if (fs.realpathSync(filename) !== filename || !fs.statSync(filename).isFile() || (fs.statSync(filename).mode & 0o077)) fail();
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; '
      + 'CREATE TABLE IF NOT EXISTS nonces(principal TEXT,nonce TEXT,expires INTEGER,PRIMARY KEY(principal,nonce)); '
      + 'CREATE TABLE IF NOT EXISTS windows(principal TEXT,window INTEGER,count INTEGER,PRIMARY KEY(principal,window)); '
      + 'CREATE TABLE IF NOT EXISTS writes(id TEXT PRIMARY KEY,principal TEXT,batch_digest TEXT,count INTEGER,started INTEGER,finished INTEGER,delivered INTEGER);');
  }
  accept(principal, input, now) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM nonces WHERE expires<?').run(now);
      this.db.prepare('DELETE FROM writes WHERE finished<?').run(now - 86400000);
      if (this.db.prepare('SELECT 1 FROM nonces WHERE principal=? AND nonce=?').get(principal, input.nonce)
        || this.db.prepare('SELECT 1 FROM writes WHERE id=?').get(input.requestId)) fail('audit_writer_replayed');
      if (this.db.prepare('SELECT COUNT(*) AS n FROM writes').get().n >= 100000) fail('audit_writer_limited');
      const window = Math.floor(now / 60000); this.db.prepare('DELETE FROM windows WHERE window<?').run(window - 1);
      this.db.prepare('INSERT INTO windows VALUES(?,?,1) ON CONFLICT(principal,window) DO UPDATE SET count=count+1').run(principal, window);
      if (this.db.prepare('SELECT count FROM windows WHERE principal=? AND window=?').get(principal, window).count > 30) fail('audit_writer_limited');
      this.db.prepare('INSERT INTO nonces VALUES(?,?,?)').run(principal, input.nonce, now + 120000);
      this.db.prepare('INSERT INTO writes VALUES(?,?,?,?,?,NULL,NULL)').run(input.requestId, principal,
        createHash('sha256').update(JSON.stringify(input.batch)).digest('hex'), input.batch.records.length, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(input, result, now) {
    const delivered = result ? result.results.filter(value => value.status === 'delivered').length : null;
    if (this.db.prepare('UPDATE writes SET finished=?,delivered=? WHERE id=? AND finished IS NULL')
      .run(now, delivered, input.requestId).changes !== 1) fail('audit_writer_unavailable');
  }
  close() { this.db.close(); }
}
module.exports = { WriterStore };
