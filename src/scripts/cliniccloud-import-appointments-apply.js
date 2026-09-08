#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, readBytes, writePrivateJson, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { prepareAppointments, applyAppointments, verifyPackage } = require('../lib/cliniccloud-import/appointments-apply');
const { createAppointmentStore } = require('../lib/cliniccloud-import/appointments-store');

function privatePath(filename) {
  if (!path.isAbsolute(filename || '')) throw new Error('PRIVATE_PATH_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error('OUTPUT_OUTSIDE_PRIVATE_IMPORT_ROOT');
  for (const dir of [root, parent]) { const stat = fs.statSync(dir); if ((stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('PRIVATE_DIRECTORY_PERMISSIONS_INVALID'); }
  return path.join(parent, path.basename(filename));
}
function privateJson(filename) {
  const resolved = privatePath(filename), stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error('PRIVATE_FILE_PERMISSIONS_INVALID');
  return JSON.parse(readBytes(resolved).toString('utf8'));
}
function openJournal(filename, packageHash) {
  const resolved = privatePath(filename);
  const descriptor = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.nlink !== 1) { fs.closeSync(descriptor); throw new Error('PRIVATE_JOURNAL_PERMISSIONS_INVALID'); }
  let sequence = 0, previousHash = null;
  try {
    // Persist the directory entry as well as the file contents before any DB
    // commit: fsync(file) alone cannot recover a newly-created name after loss.
    const directoryDescriptor = fs.openSync(path.dirname(resolved), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    if (stat.size) {
      const text = readBytes(resolved).toString('utf8');
      if (!text.endsWith('\n')) throw new Error('JOURNAL_TRUNCATED_REQUIRES_REVIEW');
      for (const line of text.trimEnd().split('\n')) {
        const { entry_sha256, ...entry } = JSON.parse(line);
        if (entry.package_sha256 !== packageHash || entry.sequence !== sequence + 1 || entry.previous_entry_sha256 !== previousHash || hash(entry) !== entry_sha256) throw new Error('JOURNAL_INTEGRITY_MISMATCH');
        sequence = entry.sequence; previousHash = entry_sha256;
      }
    }
  } catch (error) { fs.closeSync(descriptor); throw error; }
  return { append: async entry => {
    const body = { ...entry, package_sha256: packageHash, journal_at: new Date().toISOString(), sequence: sequence + 1, previous_entry_sha256: previousHash };
    const entryHash = hash(body);
    fs.writeFileSync(descriptor, `${JSON.stringify({ ...body, entry_sha256: entryHash })}\n`); fs.fsyncSync(descriptor);
    sequence = body.sequence; previousHash = entryHash;
  }, close: () => fs.closeSync(descriptor) };
}
async function acquireExecutorLocks(connection, packageHash, canonicalJournalPath) {
  for (const key of [`cc-hold:${packageHash.slice(0, 48)}`, `cc-journal:${hash(canonicalJournalPath).slice(0, 48)}`]) {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [key]);
    if (Number(rows[0].acquired) !== 1) throw new Error('PACKAGE_OR_JOURNAL_ALREADY_RUNNING');
  }
}
async function connect() {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  return require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, timezone: 'Z', dateStrings: true, multipleStatements: false });
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--plan', '--local-snapshot', '--private-output', '--package', '--approval', '--backup-manifest', '--private-journal', '--max-operations']);
  if (!['prepare', 'apply'].includes(options['--mode'])) throw new Error('MODE_MUST_BE_EXPLICIT_PREPARE_OR_APPLY');
  if (path.resolve(__dirname, '../..') !== '/home/ubuntu/wt/back-dev' || process.cwd() !== '/home/ubuntu/wt/back-dev') throw new Error('DEV_WORKTREE_REQUIRED');
  if (options['--mode'] === 'prepare') {
    if (!options['--plan'] || !options['--local-snapshot'] || !options['--private-output']) throw new Error('PREPARATION_INPUTS_REQUIRED');
    const plan = privateJson(options['--plan']), snapshot = privateJson(options['--local-snapshot']);
    const connection = await connect();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const store = await createAppointmentStore(connection, snapshot.complete_for.clinic_ids, { readOnly: true });
      const pkg = await prepareAppointments({ plan, snapshot, store });
      await connection.rollback();
      writePrivateJson(options['--private-output'], pkg);
      return { mode: 'read_only_preparation', package_sha256: pkg.package_sha256, ...pkg.summary, automation_policy: 'hold' };
    } finally { await connection.end(); }
  }
  if (!options['--package'] || !options['--approval'] || !options['--backup-manifest'] || !options['--private-journal']) throw new Error('APPLICATION_REVIEW_AND_BACKUP_REQUIRED');
  const pkg = privateJson(options['--package']), approval = privateJson(options['--approval']);
  verifyPackage(pkg);
  privateJson(options['--backup-manifest']);
  if (hash(readBytes(options['--backup-manifest'])) !== approval.backup_manifest_sha256) throw new Error('BACKUP_MANIFEST_HASH_MISMATCH');
  const connection = await connect(); let journal;
  try {
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
    // Serialize both package and canonical journal path, even when two different
    // packages race to open the same empty file. Row locks/CAS protect the data.
    await acquireExecutorLocks(connection, pkg.package_sha256, privatePath(options['--private-journal']));
    journal = openJournal(options['--private-journal'], pkg.package_sha256);
    const store = await createAppointmentStore(connection, pkg.clinic_ids, { readOnly: false });
    return await applyAppointments({ pkg, approval, store, journal, maxOperations: options['--max-operations'] == null ? 25 : Number(options['--max-operations']) });
  } finally { journal?.close(); await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(summary => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)).catch(error => {
  process.stderr.write(`${/^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'CLINICCLOUD_APPOINTMENT_APPLY_FAILED'}\n`); process.exitCode = 1;
});
module.exports = { run, privateJson, openJournal, acquireExecutorLocks };
