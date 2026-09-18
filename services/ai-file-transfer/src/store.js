'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const C = require('./contract');

// Exactly one daemon owns a state directory. Bind its fixed local download
// port before open(), so a duplicate instance cannot clean another's uploads.
class TransferStore {
  constructor({ directory, origin, environment, maxTransfers = 8, maxStoredBytes = 128 * 1024 * 1024, ttlMs = C.MAX_TTL_MS, now = Date.now }) {
    if (!path.isAbsolute(directory) || !['dev', 'staging'].includes(environment) || !Number.isInteger(maxTransfers) || maxTransfers < 1 || maxTransfers > 32
      || !Number.isInteger(maxStoredBytes) || maxStoredBytes < 1 || maxStoredBytes > 512 * 1024 * 1024
      || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > C.MAX_TTL_MS) C.fail('invalid_config');
    this.directory = directory; this.origin = C.origin(origin); this.environment = environment;
    this.maxTransfers = maxTransfers; this.maxStoredBytes = maxStoredBytes; this.ttlMs = ttlMs; this.now = now;
    this.rows = new Map(); this.reservedBytes = 0;
  }
  filename(id, extension) { if (!/^[a-f0-9]{64}$/.test(id) || !['data', 'json', 'part'].includes(extension)) C.fail('invalid_request'); return path.join(this.directory, `${id}.${extension}`); }
  async privateStat(filename) {
    const info = await fsp.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 || info.nlink !== 1) C.fail('storage_invalid');
    return info;
  }
  async open() {
    const info = await fsp.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 || await fsp.realpath(this.directory) !== this.directory) C.fail('storage_invalid');
    const names = await fsp.readdir(this.directory);
    if (names.length > 128 || names.some(name => !/^[a-f0-9]{64}\.(data|json|part)$/.test(name))) C.fail('storage_invalid');
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const id = name.slice(0, -5); const file = this.filename(id, 'json');
      const stat = await this.privateStat(file); if (stat.size > 4096) C.fail('storage_invalid');
      const value = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!C.exact(value, ['version', 'environment', 'expiresAt', 'input']) || value.version !== 1 || value.environment !== this.environment
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt > this.now() + this.ttlMs) C.fail('storage_invalid');
      C.upload(value.input);
      const data = await this.privateStat(this.filename(id, 'data'));
      if (data.size !== value.input.sizeBytes) C.fail('storage_invalid');
      this.rows.set(id, { ...value, ready: true, consumers: new Set(), requestCount: 0, bytesReserved: 0 }); this.reservedBytes += data.size;
    }
    await this.cleanup();
    // An incomplete upload has never issued a capability; remove only owned
    // files in this dedicated directory, after the singleton listener is held.
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!this.rows.has(id)) { const filename = path.join(this.directory, name); try { await this.privateStat(filename); await fsp.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    if (this.rows.size > this.maxTransfers || this.reservedBytes > this.maxStoredBytes) C.fail('storage_capacity_exceeded');
  }
  async create(input, source) {
    C.upload(input);
    await this.cleanup();
    if (this.rows.size >= this.maxTransfers || this.reservedBytes + input.sizeBytes > this.maxStoredBytes) C.fail('rate_limited');
    const token = crypto.randomBytes(32).toString('base64url'); const id = C.tokenHash(token);
    const row = { version: 1, environment: this.environment, expiresAt: this.now() + this.ttlMs, input,
      ready: false, consumers: new Set(), requestCount: 0, bytesReserved: 0 };
    // Reservation is synchronous and precedes all file/body I/O.
    this.rows.set(id, row); this.reservedBytes += input.sizeBytes;
    let size = 0; const hash = crypto.createHash('sha256');
    const meter = new Transform({ transform(chunk, encoding, next) {
      size += chunk.length;
      if (size > input.sizeBytes) return next(Object.assign(Error('invalid_request'), { code: 'invalid_request' }));
      hash.update(chunk); next(null, chunk);
    } });
    const destination = fs.createWriteStream(this.filename(id, 'data'), { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
    row.uploadClosed = new Promise(resolve => destination.once('close', resolve));
    const cancel = () => { source.destroy(); destination.destroy(); }; row.consumers.add(cancel);
    try {
      await pipeline(source, meter, destination);
      if (size !== input.sizeBytes || hash.digest('hex') !== input.sha256 || row.expiresAt <= this.now() || this.rows.get(id) !== row || row.removing) C.fail('invalid_request');
      const serialized = JSON.stringify({ version: row.version, environment: row.environment, expiresAt: row.expiresAt, input });
      row.publishing = (async () => {
        await fsp.writeFile(this.filename(id, 'part'), serialized, { flag: 'wx', mode: 0o600 });
        if (this.rows.get(id) !== row || row.removing || row.expiresAt <= this.now()) C.fail('invalid_request');
        await fsp.rename(this.filename(id, 'part'), this.filename(id, 'json'));
      })();
      await row.publishing;
      if (this.rows.get(id) !== row || row.removing || row.expiresAt <= this.now()) C.fail('invalid_request');
      row.ready = true;
      return { version: 1, environment: this.environment, ...input, url: this.origin + C.PREFIX + token, expiresAt: row.expiresAt };
    } catch (error) { await this.remove(id); throw error; }
    finally { row.consumers.delete(cancel); }
  }
  lookup(token) {
    const id = C.tokenHash(token); const row = this.rows.get(id);
    if (!row?.ready || row.expiresAt <= this.now()) C.fail('not_found');
    return { id, row };
  }
  async remove(id) {
    const erase = async () => {
      for (const extension of ['json', 'part', 'data']) await fsp.unlink(this.filename(id, extension)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    };
    const row = this.rows.get(id); if (!row) return erase();
    if (row.removing) return row.removing;
    row.ready = false;
    for (const cancel of row.consumers) cancel();
    // Retain capacity until deletion has finished, even when several cleanup
    // triggers race with a new upload.
    row.removing = (async () => {
      await row.uploadClosed;
      await row.publishing?.catch(() => {});
      await erase();
      if (this.rows.get(id) === row) { this.rows.delete(id); this.reservedBytes -= row.input.sizeBytes; }
    })();
    return row.removing;
  }
  async revoke(token) { await this.remove(C.tokenHash(token)); }
  async cleanup() { await Promise.all([...this.rows].filter(([, row]) => row.expiresAt <= this.now()).map(([id]) => this.remove(id))); }
  status() { return { transfers: this.rows.size, reservedBytes: this.reservedBytes }; }
  async verifiedFile(id, row) {
    const file = await fsp.open(this.filename(id, 'data'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size !== row.input.sizeBytes) C.fail('not_found');
      const hash = crypto.createHash('sha256'); const buffer = Buffer.alloc(65536); let position = 0;
      while (position < stat.size) {
        if (!row.ready || row.expiresAt <= this.now()) C.fail('not_found');
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytesRead) C.fail('not_found'); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      buffer.fill(0); if (hash.digest('hex') !== row.input.sha256) C.fail('not_found');
      return file;
    } catch (error) { await file.close(); throw error; }
  }
}
module.exports = { TransferStore };
