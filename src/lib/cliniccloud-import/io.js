'use strict';

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { spawnSync } = require('child_process');
const { parseCsv } = require('./csv');
const { hash } = require('./adapter');

const PRIVATE_ROOT = '/home/ubuntu/secure-imports';
const MAX_BYTES = 64 * 1024 * 1024;
function readBytes(filename) {
  if (!fs.statSync(filename).isFile() || fs.statSync(filename).size > MAX_BYTES) throw new Error('INPUT_FILE_SIZE_OR_TYPE_INVALID');
  return fs.readFileSync(filename);
}
function readCsv(filename, role, required = []) {
  const bytes = readBytes(filename);
  const rows = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { required });
  return { rows, file: { role, sha256: hash(bytes), bytes: bytes.length, rows: rows.length } };
}
function readAlerts(filename) {
  const bytes = readBytes(filename);
  const result = spawnSync('python3', [path.join(__dirname, 'xlsx_alerts.py'), filename], { encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 30000 });
  if (result.status !== 0) throw new Error('ALERTS_XLSX_ADAPTER_FAILED');
  const rows = JSON.parse(result.stdout);
  return { rows, file: { role: 'alerts', sha256: hash(bytes), bytes: bytes.length, rows: rows.length } };
}
function writePrivateJson(filename, value) {
  if (!path.isAbsolute(filename)) throw new Error('PRIVATE_OUTPUT_MUST_BE_ABSOLUTE');
  const root = fs.realpathSync(PRIVATE_ROOT);
  const rootStat = fs.statSync(root);
  if ((rootStat.mode & 0o077) !== 0 || rootStat.uid !== process.getuid()) throw new Error('PRIVATE_ROOT_PERMISSIONS_INVALID');
  const parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error('OUTPUT_OUTSIDE_PRIVATE_IMPORT_ROOT');
  const destination = path.join(parent, path.basename(filename));
  // Exclusive creation + no symlink traversal: never overwrite an earlier plan.
  const descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function parseArgs(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (!allowed.includes(option) || result[option] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_CLI_ARGUMENTS');
    result[option] = args[++i];
  }
  return result;
}
module.exports = { readBytes, readCsv, readAlerts, writePrivateJson, parseArgs, PRIVATE_ROOT };
