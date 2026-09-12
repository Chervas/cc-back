'use strict';

// Own MySQL processes, datadirs, sockets, certificates and GPG keys; never app credentials/models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const { collectMetadata } = require('../../lib/databaseEncryptionMetadata');
const { buildDatabaseTlsOptions } = require('../../lib/databaseTlsConfig');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  if (process.env.SECURITY_ENCRYPTED_MYSQL_TEST !== '1') throw Error('Explicit SECURITY_ENCRYPTED_MYSQL_TEST=1 is required');
  process.umask(0o077);
  const root = fs.mkdtempSync('/tmp/cc-security-encrypted-mysql-'); fs.chmodSync(root, 0o700);
  const report = { root, synthetic: true, success: false, checks: [], processes: [], networkRejected: [] };
  const originalConnect = net.Socket.prototype.connect; const sockets = new Set(); const ports = new Set();
  net.Socket.prototype.connect = function (...args) {
    const value = Array.isArray(args[0]) ? args[0][0] : args[0];
    const socket = typeof value === 'string' ? value : value?.path;
    if (sockets.has(socket) && !value?.port || value?.host === '127.0.0.1' && ports.has(Number(value.port))) return originalConnect.apply(this, args);
    report.networkRejected.push('outside fixture'); throw Error('SECURITY_RESTORE_NETWORK_FORBIDDEN');
  };
  global.fetch = () => { throw Error('SECURITY_RESTORE_NETWORK_FORBIDDEN'); };
  const processes = []; const connections = new Set(); const homes = [];
  const mkdir = name => { const value = path.join(root, name); fs.mkdirSync(value, { mode: 0o700 }); return value; };
  const execute = (binary, args, timeout = 90000) => exec(binary, args, { timeout, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/sbin:/usr/bin:/bin', HOME: root, GNUPGHOME: root, LANG: 'C' } });
  const stop = async state => {
    if (state.child.exitCode === null && !state.child.signalCode) state.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (state.child.exitCode === null && !state.child.signalCode) { state.forced = true; state.child.kill('SIGKILL'); } }, 20000);
    try { state.exit = await state.exited; } finally { clearTimeout(timer); }
    assert.equal(state.forced, undefined, 'Own temporary mysqld must stop gracefully');
  };
  const connect = async options => { const value = await mysql.createConnection({ user: 'root', password: '', connectTimeout: 2000, ...options });
    connections.add(value); return value; };
  const close = async connection => { await connection.end(); connections.delete(connection); };
  let reserved; let source;
  try {
    assert(fs.statSync('/usr/lib/mysql/plugin/keyring_file.so').isFile());
    const tls = mkdir('tls'); const gpgHome = mkdir('gpg-escrow'); homes.push(gpgHome);
    const wrongHome = mkdir('gpg-unrelated'); homes.push(wrongHome);
    const gpgArgs = home => ['--no-options', '--homedir', home, '--batch', '--yes', '--pinentry-mode', 'loopback'];
    const gpg = (home, args) => execute('/usr/bin/gpg', [...gpgArgs(home), ...args]);
    await gpg(gpgHome, ['--passphrase', '', '--quick-generate-key', 'Synthetic database restore <fixture@invalid.test>', 'rsa2048', 'encr', '0']);
    const listing = (await gpg(gpgHome, ['--with-colons', '--list-keys'])).stdout;
    const recipient = listing.split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
    assert(/^[A-F0-9]{40}$/.test(recipient));
    await execute('/usr/bin/openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=Synthetic MySQL CA',
      '-keyout',path.join(tls,'ca.key'),'-out',path.join(tls,'ca.pem')]);
    await execute('/usr/bin/openssl', ['req','-newkey','rsa:2048','-nodes','-subj','/CN=mysql-fixture.invalid',
      '-keyout',path.join(tls,'server.key'),'-out',path.join(tls,'server.csr')]);
    fs.writeFileSync(path.join(tls,'extensions.cnf'), 'subjectAltName=DNS:mysql-fixture.invalid,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
    await execute('/usr/bin/openssl', ['x509','-req','-in',path.join(tls,'server.csr'),'-CA',path.join(tls,'ca.pem'),
      '-CAkey',path.join(tls,'ca.key'),'-CAcreateserial','-days','2','-extfile',path.join(tls,'extensions.cnf'),'-out',path.join(tls,'server.pem')]);
    await execute('/usr/bin/openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=Unrelated fixture CA',
      '-keyout',path.join(tls,'wrong.key'),'-out',path.join(tls,'wrong.pem')]);
    const sourceData = mkdir('source-data'); const sourceKeys = mkdir('source-keys');
    await execute('/usr/sbin/mysqld', ['--no-defaults','--initialize-insecure','--datadir='+sourceData,
      '--log-error='+path.join(root,'initialize.log'),'--innodb-buffer-pool-size=64M']);
    reserved = net.createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
    const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve)); reserved = null;
    const start = async (name, data, keyFile, { expectedFailure = false, tcp = false } = {}) => {
      assert(fs.realpathSync(data).startsWith(root + '/'));
      const socketPath = path.join(root, name + '.sock'); const log = path.join(root, name + '.log');
      const args = ['--no-defaults','--datadir='+data,'--socket='+socketPath,'--pid-file='+path.join(root,name+'.pid'),'--log-error='+log,
        '--mysqlx=0','--innodb-buffer-pool-size=64M','--innodb-redo-log-capacity=32M','--max-connections=16','--skip-name-resolve',
        '--early-plugin-load=keyring_file.so','--keyring-file-data='+keyFile,'--default-table-encryption=ON',
        '--innodb-redo-log-encrypt=ON','--innodb-undo-log-encrypt=ON','--binlog-encryption=ON','--log-bin='+path.join(data,'binary'),
        '--require-secure-transport=ON','--ssl-ca='+path.join(tls,'ca.pem'),'--ssl-cert='+path.join(tls,'server.pem'),'--ssl-key='+path.join(tls,'server.key'),
        ...(tcp ? ['--bind-address=127.0.0.1','--port='+port] : ['--skip-networking'])];
      const child = spawn('/usr/sbin/mysqld', args, { stdio: 'ignore', env: { PATH: '/usr/sbin:/usr/bin:/bin', HOME: root } });
      const state = { name, child, data, socketPath, log }; processes.push(state);
      state.exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: null, signal: 'spawn_error' })); });
      if (expectedFailure) {
        let timer;
        try { state.exit = await Promise.race([state.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Missing-key server did not stop')), 20000); })]); }
        finally { clearTimeout(timer); }
        assert.notEqual(state.exit.code, 0);
        assert.match(fs.readFileSync(log,'utf8'), /\[ERROR\].*\[MY-013066\].*Cannot read the encryption information in log file header/);
        report.checks.push('physical restore without the matching database key cannot start'); return state;
      }
      sockets.add(socketPath); const deadline = Date.now() + 30000;
      for (;;) {
        if (child.exitCode !== null || child.signalCode) throw Error('Temporary MySQL failed to start: ' + name);
        try {
          const db = await connect({ socketPath });
          const [rows] = await db.query('SELECT @@datadir AS datadir, @@port AS port');
          assert.equal(fs.realpathSync(rows[0].datadir), fs.realpathSync(data));
          if (tcp) { assert.equal(Number(rows[0].port), port); ports.add(port); }
          state.db = db; return state;
        } catch (error) { if (Date.now() > deadline || report.networkRejected.length) throw error; await sleep(100); }
      }
    };
    source = await start('source', sourceData, path.join(sourceKeys,'keyring'), { tcp: true });
    await source.db.query("CREATE DATABASE qa_encryption DEFAULT ENCRYPTION='Y'");
    await source.db.query('USE qa_encryption');
    await source.db.query("CREATE TABLE records (id INT PRIMARY KEY, marker VARCHAR(80) NOT NULL) ENGINE=InnoDB ENCRYPTION='Y'");
    await source.db.query("CREATE TABLE receipts (id INT PRIMARY KEY, record_id INT NOT NULL, request_id CHAR(36) NOT NULL UNIQUE, FOREIGN KEY(record_id) REFERENCES records(id)) ENGINE=InnoDB ENCRYPTION='Y'");
    await source.db.query("INSERT INTO records VALUES (1,'SYNTHETIC_ONLY_A'),(2,'SYNTHETIC_ONLY_B')");
    await source.db.query("INSERT INTO receipts VALUES (1,1,'00000000-0000-4000-8000-000000000001')");
    await source.db.query("CREATE USER 'fixture_tls'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY 'synthetic-only-password'");
    await source.db.query("GRANT SELECT ON qa_encryption.* TO 'fixture_tls'@'127.0.0.1'");
    await source.db.query("ALTER TABLESPACE mysql ENCRYPTION='Y'");
    await source.db.query('ALTER INSTANCE ROTATE INNODB MASTER KEY');
    const metadata = await collectMetadata({ query: async sql => (await source.db.query(sql))[0] });
    assert.equal(metadata.checks.schemaDefault.data.encryptedByDefault, true);
    for (const name of ['default_table_encryption','innodb_redo_log_encrypt','innodb_undo_log_encrypt','binlog_encryption','require_secure_transport']) {
      assert.equal(metadata.checks.variables.data[name], true);
    }
    assert(metadata.checks.tablespaces.data.some(row => row.encrypted && row.kind === 'Single'));
    report.checks.push('synthetic tables and dictionary encrypted with redo/undo/binlog flags', 'database master key rotated only in the synthetic instance');
    const { ssl } = buildDatabaseTlsOptions({ DB_TLS_REQUIRED: 'true', DB_TLS_CA_FILE: path.join(tls,'ca.pem') });
    const tcpAccount = { host: 'mysql-fixture.invalid', port, user: 'fixture_tls', password: 'synthetic-only-password',
      stream: () => net.connect({ host: '127.0.0.1', port }) };
    const tlsClient = await connect({ ...tcpAccount, ssl, database: 'qa_encryption' });
    const [tlsStatus] = await tlsClient.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'"); assert(tlsStatus[0].Value);
    await close(tlsClient);
    await assert.rejects(connect(tcpAccount), error => error.code === 'ER_SECURE_TRANSPORT_REQUIRED');
    await assert.rejects(connect({ socketPath: source.socketPath, host: 'wrong-fixture.invalid', ssl }),
      error => /altname|Hostname|does not match/i.test(error.message));
    await assert.rejects(connect({ ...tcpAccount, ssl: { ...ssl, ca: fs.readFileSync(path.join(tls,'wrong.pem')) } }));
    report.checks.push('verified TLS succeeds; plaintext TCP, wrong hostname and untrusted CA fail');
    const expected = (await source.db.query('SELECT r.id,r.marker,c.request_id FROM records r LEFT JOIN receipts c ON c.record_id=r.id ORDER BY r.id'))[0];
    await close(source.db); await stop(source); assert.equal(source.exit.code, 0); ports.delete(port); sockets.delete(source.socketPath);
    const backup = mkdir('backup'); const archive = path.join(backup,'data.tar.gz');
    await execute('/bin/tar', ['--sparse','-czf',archive,'-C',sourceData,'.']);
    const dataCipher = path.join(backup,'data.tar.gz.gpg'); const keyCipher = path.join(backup,'keyring.gpg');
    for (const [input, output] of [[archive,dataCipher],[path.join(sourceKeys,'keyring'),keyCipher]]) {
      await gpg(gpgHome, ['--trust-model','always','--recipient',recipient,'--output',output,'--encrypt',input]); fs.chmodSync(output,0o600);
    }
    fs.unlinkSync(archive); report.backupHashes = { data: sha(dataCipher), keys: sha(keyCipher) };
    await assert.rejects(gpg(wrongHome, ['--output',path.join(root,'wrong.tar.gz'),'--decrypt',dataCipher]),
      error => /No secret key/i.test(error.stderr || ''));
    report.checks.push('separate data/keyring backups encrypted; unrelated GPG identity cannot decrypt');
    const damaged = fs.readFileSync(dataCipher); damaged[damaged.length - 1] ^= 0xff;
    const damagedFile = path.join(root,'damaged.gpg'); fs.writeFileSync(damagedFile,damaged,{mode:0o600});
    await assert.rejects(gpg(gpgHome, ['--output',path.join(root,'damaged.tar.gz'),'--decrypt',damagedFile]),
      error => /manipulated|BADMDC|decryption failed|invalid packet|CRC error/i.test(error.stderr || ''));
    report.checks.push('damaged encrypted backup rejected before any restore is attempted');
    const restoredArchive = path.join(root,'restored.tar.gz');
    await gpg(gpgHome, ['--output',restoredArchive,'--decrypt',dataCipher]); fs.chmodSync(restoredArchive,0o600);
    const noKeyData = mkdir('restore-without-key-data'); const noKeys = mkdir('restore-without-key-keys');
    await execute('/bin/tar', ['-xzf',restoredArchive,'-C',noKeyData,'--no-same-owner']);
    await start('without-key', noKeyData, path.join(noKeys,'keyring'), { expectedFailure: true });
    const restoredData = mkdir('restored-data'); const restoredKeys = mkdir('restored-keys');
    await execute('/bin/tar', ['-xzf',restoredArchive,'-C',restoredData,'--no-same-owner']);
    await gpg(gpgHome, ['--output',path.join(restoredKeys,'keyring'),'--decrypt',keyCipher]);
    fs.chmodSync(path.join(restoredKeys,'keyring'),0o600);
    const started = Date.now(); const restored = await start('restored', restoredData, path.join(restoredKeys,'keyring'));
    await restored.db.query('USE qa_encryption');
    const actual = (await restored.db.query('SELECT r.id,r.marker,c.request_id FROM records r LEFT JOIN receipts c ON c.record_id=r.id ORDER BY r.id'))[0];
    assert.deepEqual(actual, expected);
    await assert.rejects(restored.db.query("INSERT INTO receipts VALUES(2,1,'00000000-0000-4000-8000-000000000001')"), error => error.code === 'ER_DUP_ENTRY');
    const restoredMetadata = await collectMetadata({ query: async sql => (await restored.db.query(sql))[0] });
    assert.equal(restoredMetadata.checks.schemaDefault.data.encryptedByDefault,true);
    assert(restoredMetadata.checks.tablespaces.data.some(row => row.encrypted && row.kind === 'Single'));
    report.restoreMilliseconds = Date.now() - started;
    report.checks.push('correct data plus key restore preserves rows, relations, uniqueness and encryption after restart');
    assert.equal(sha(dataCipher),report.backupHashes.data); assert.equal(sha(keyCipher),report.backupHashes.keys);
    report.checks.push('backup artifacts unchanged through failed and successful restore');
    report.sourceMetadata = metadata; report.restoredMetadata = restoredMetadata;
    await close(restored.db); await stop(restored); assert.equal(restored.exit.code,0);
    assert.equal(report.networkRejected.length,0); report.success = true;
  } catch (error) { report.failure = { code: error.code || null, message: String(error.message).slice(0,300) }; throw error; }
  finally {
    if (reserved) await new Promise(resolve => reserved.close(resolve));
    for (const connection of connections) { try { connection.destroy(); } catch {} }
    for (const state of processes) {
      try { await stop(state); } catch { report.success = false; }
      report.processes.push({ name: state.name, pid: state.child.pid, exit: state.exit, forced: state.forced === true });
    }
    for (const home of homes) { try { await execute('/usr/bin/gpgconf',['--homedir',home,'--kill','gpg-agent']); } catch { report.success = false; } }
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({ root, success: report.success, checks: report.checks, processes: report.processes, failure: report.failure }));
  }
}
main().catch(() => { process.exitCode = 1; });
