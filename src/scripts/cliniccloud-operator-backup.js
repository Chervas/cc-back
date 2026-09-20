#!/usr/bin/env node
'use strict';

// Operator runbook utility. Credentials remain in an inherited anonymous pipe;
// no app bootstrap, secret in argv/environment, or public-media output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createGzip, createGunzip } = require('node:zlib');
const { Writable, Transform } = require('node:stream');
const { databaseOptions, connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, writePrivateJson, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');

function optionValue(value) { return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`; }
function clientOptions(config) {
  return `[client]\nhost=${optionValue(config.host)}\nport=${Number(config.port)}\nuser=${optionValue(config.user)}\npassword=${optionValue(config.password)}\n`;
}
function validateDirectory(directory) {
  const real = fs.realpathSync(directory), stat = fs.lstatSync(directory);
  if (!real.startsWith(`${fs.realpathSync(PRIVATE_ROOT)}/`) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || (stat.mode & 0o077) || fs.readdirSync(real).length) throw Error('NEW_EMPTY_PRIVATE_BACKUP_DIRECTORY_REQUIRED');
  return real;
}
async function backup({ target, directory }) {
  const options = databaseOptions(target);
  if (!['127.0.0.1', 'localhost', '::1'].includes(options.host)) throw Error('LOCAL_OPERATOR_DATABASE_REQUIRED');
  const root = validateDirectory(directory);
  const connection = await connectOperatorDatabase(target);
  let identity, tables;
  try {
    [[identity]] = await connection.query('SELECT DATABASE() AS database_name, CURRENT_USER() AS database_user, @@hostname AS server_name');
    [tables] = await connection.query('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME');
    if (identity.database_name !== options.database || !tables.length || tables.some(row => row.ENGINE !== 'InnoDB')) throw Error('BACKUP_DATABASE_OR_ENGINE_MISMATCH');
  } finally { await connection.end(); }
  const filename = path.join(root, 'database-before.sql.gz');
  const output = fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 });
  const diagnosticFd = fs.openSync(path.join(root, 'mysqldump-private.log'), 'wx', 0o600);
  const child = spawn('/usr/bin/python3', [path.join(__dirname, 'cliniccloud-private-dump.py'), '--single-transaction', '--quick', '--hex-blob',
    '--no-tablespaces', '--set-gtid-purged=OFF', '--routines', '--triggers', '--events', '--databases', options.database],
  { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes < 1024 * 1024) fs.writeSync(diagnosticFd, chunk); });
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => {
    if (code === 0 && !signal) resolve(); else reject(Error('MYSQLDUMP_FAILED_PRIVATE_PARTIAL_FILE_RETAINED'));
  }); });
  child.stdio[3].on('error', () => {});
  child.stdio[3].end(clientOptions(options));
  const sha = crypto.createHash('sha256'); let bytes = 0;
  const count = new Transform({ transform(chunk, encoding, next) { sha.update(chunk); bytes += chunk.length; next(null, chunk); } });
  try { await Promise.all([completed, pipeline(child.stdout, createGzip({ level: 6 }), count, output)]); }
  catch (error) { child.kill('SIGTERM'); throw error; }
  finally { fs.closeSync(diagnosticFd); }
  // Full gzip integrity check; require the successful mysqldump completion footer.
  let tail = '', createStatements = 0, scan = '';
  await pipeline(fs.createReadStream(filename), createGunzip(), new Writable({ write(chunk, encoding, next) {
    // SQL INSERTs may contain very large private blobs on a single line. Never
    // retain that whole line (quadratic copying and unbounded memory).
    const text = scan + chunk.toString('utf8');
    for (const match of text.matchAll(/(?:^|\n)CREATE TABLE /g)) if (match.index + match[0].length > scan.length) createStatements++;
    scan = text.slice(-32);
    tail = (tail + chunk.toString('utf8')).slice(-4096); next();
  } }));
  if (!/-- Dump completed on /.test(tail) || createStatements < tables.length) throw Error('BACKUP_COMPLETENESS_CHECK_FAILED');
  const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const manifest = { version: 'cliniccloud-operator-backup/1', generated_at: new Date().toISOString(), database_target: target,
    database_name: identity.database_name, server_name: identity.server_name, method: 'mysqldump-single-transaction',
    tables: tables.map(row => row.TABLE_NAME), full_gzip_verified: true, dump_completion_verified: true, stderr_bytes: stderrBytes,
    backup: { file: path.basename(filename), bytes, sha256: sha.digest('hex') } };
  writePrivateJson(path.join(root, 'backup-manifest.json'), manifest);
  return { target, tables: tables.length, bytes, sha256: manifest.backup.sha256, full_gzip_verified: true, directory: root };
}
async function run(args) {
  const options = parseArgs(args, ['--target', '--private-directory']);
  return backup({ target: options['--target'], directory: options['--private-directory'] });
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'OPERATOR_BACKUP_FAILED'); process.exitCode = 1;
});
module.exports = { optionValue, clientOptions, validateDirectory, backup, run };
