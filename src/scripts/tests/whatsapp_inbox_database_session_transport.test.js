'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), tls = require('node:tls');
const { once } = require('node:events');
const { createInboxDatabaseSession } = require('../../lib/whatsappInboxDatabaseSession');

async function child() {
  const [mode, portText, caFile] = process.argv.slice(3);
  assert(['early-end', 'hanging-end', 'peer-half-close'].includes(mode));
  const port = Number(portText); assert(Number.isInteger(port) && port > 0 && port < 65536);
  // Exercise the installed mysql2 close implementation without constructing a
  // MySQL connection, sending SQL or loading application configuration/models.
  const BaseConnection = require(path.join(path.dirname(require.resolve('mysql2')), 'lib/base/connection.js'));
  const raw = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  const secure = tls.connect({ socket: raw, ca: fs.readFileSync(caFile), servername: 'owned-session.fixture.invalid',
    rejectUnauthorized: true, minVersion: 'TLSv1.2', allowHalfOpen: true });
  secure.on('error', () => {}); raw.on('error', () => {});
  await once(secure, 'secureConnect'); assert(secure.authorized);
  let statements = 0, owner = null;
  const core = new (require('node:events').EventEmitter)();
  core.stream = raw; core.close = BaseConnection.prototype.close;
  const connection = { connection: core,
    execute: async sql => {
      statements++;
      if (sql.includes('GET_LOCK')) { owner = 51; return [[{ acquired: 1 }]]; }
      return [[{ connection_id: 51, owner_id: owner, read_only: 0, super_read_only: 0 }]];
    },
    end: () => mode === 'hanging-end' ? new Promise(() => {}) : Promise.resolve(),
    destroy: () => BaseConnection.prototype.destroy.call(core),
  };
  const session = createInboxDatabaseSession({ connect: async () => connection, tables: [], closeTimeoutMs: 40 });
  await session.open();
  if (mode === 'peer-half-close') {
    const ended = once(secure, 'end'); secure.resume(); secure.write('half-close'); await ended;
    assert.equal(raw.destroyed, false);
  }
  core.emit('error', Object.assign(Error('FICTITIOUS_SESSION_LOSS'), { code: 'PROTOCOL_CONNECTION_LOST' }));
  const before = statements;
  await assert.rejects(session.assertOwnership(), { code: 'inbox_database_session_unavailable' });
  assert.equal(statements, before);
  const started = Date.now(); await session.close();
  assert.equal(raw.destroyed, true, 'the session must destroy its own stream before any harness cleanup');
  assert(Date.now() - started < 1000);
  await assert.rejects(session.open(), { code: 'inbox_database_stopped' });
  process.stdout.write(JSON.stringify({ status: 'closed', streamDestroyed: raw.destroyed, mode, statements }) + '\n');
  // No process.exit, unref, transport cleanup or test runner in this child.
  // The parent requires natural process exit while the peer is still owned/open.
}

if (process.argv[2] === '--owned-tls-child') {
  child().catch(error => { process.stderr.write(error.code || error.message); process.exitCode = 1; });
} else {
  const test = require('node:test');
  const { spawn, execFileSync } = require('node:child_process');
  let folder, key, cert;
  test.before(() => {
    folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cc-inbox-session-tls-')); fs.chmodSync(folder, 0o700);
    key = path.join(folder, 'key.pem'); cert = path.join(folder, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-days', '1', '-subj', '/CN=owned-session.fixture.invalid', '-addext', 'subjectAltName=DNS:owned-session.fixture.invalid',
      '-keyout', key, '-out', cert], { stdio: 'ignore' });
  });
  test.after(() => { if (folder) fs.rmSync(folder, { recursive: true, force: true }); });
  for (const mode of ['early-end', 'hanging-end', 'peer-half-close']) {
    test('fatal session with ' + mode + ' TLS peer exits naturally within five seconds', async () => {
      const peers = new Set(), transports = new Set();
      const server = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHalfOpen: true }, socket => {
        peers.add(socket); socket.on('error', () => {}); socket.on('data', () => { if (mode === 'peer-half-close') socket.end(); });
      });
      server.on('connection', socket => { transports.add(socket); socket.on('error', () => {}); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const preloads = [];
      for (let i = 0; i < process.execArgv.length; i++) {
        if (process.execArgv[i] === '--require') preloads.push('--require', process.execArgv[++i]);
      }
      const proc = spawn(process.execPath, [...preloads, __filename, '--owned-tls-child', mode, String(server.address().port), cert],
        { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timer, timedOut = false;
      proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
      try {
        timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 5000); // Failed owned fixture only; never a passing cleanup.
        const [code, signal] = await once(proc, 'exit');
        assert.equal(timedOut, false, 'owned child required forced cleanup'); assert.equal(signal, null); assert.equal(code, 0, stderr);
        const result = JSON.parse(stdout.trim()); assert.equal(result.streamDestroyed, true); assert.equal(result.mode, mode);
        assert.equal(server.listening, true);
      } finally {
        clearTimeout(timer); for (const peer of peers) peer.destroy(); for (const transport of transports) transport.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
}
