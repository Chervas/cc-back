#!/usr/bin/env node
'use strict';
// Explicit one-time, user-authorized incident operation. No DDL, app bootstrap,
// provider transport, reset-token generation, environment or worker changes.
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { observedEnvironment } = require('./security-email-login-metadata');
const { configuration } = require('./security-database-metadata');
const { rotateGlobalAdminPasswords } = require('../lib/rotateGlobalAdminPasswords');
const EVIDENCE = '/home/ubuntu/qa-evidence/security-migration-20260912';

async function run(args) {
  if (args.length !== 1 || args[0] !== '--rotate-observed-global-admins') throw Error('admin_rotation_explicit_scope_required');
  if (fs.realpathSync(EVIDENCE) !== EVIDENCE || (fs.statSync(EVIDENCE).mode & 0o077)) throw Error('admin_rotation_private_directory_required');
  const inventory = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'admin-password-rotation-inventory.json'), 'utf8'));
  if (inventory.mode !== 'read_only' || Date.now() - Date.parse(inventory.at) > 3600000
    || Date.parse(inventory.at) > Date.now()) throw Error('admin_rotation_fresh_inventory_required');
  const expectedUsers = inventory.users.filter(user => user.globalAdmin).map(user => ({ id: Number(user.id_usuario), email: user.email_usuario }));
  // A single fixed receipt prevents accidental reruns, including after an
  // uncertain COMMIT. Reconcile that outcome explicitly instead of deleting it.
  const receiptPath = path.join(EVIDENCE, 'admin-password-rotation-receipt.json');
  const fd = fs.openSync(receiptPath, 'wx', 0o600);
  const operationId = crypto.randomUUID(); let connection;
  const record = value => {
    const content = Buffer.from(JSON.stringify({ operationId, at: new Date().toISOString(), ...value }, null, 2) + '\n');
    fs.writeSync(fd, content, 0, content.length, 0); fs.ftruncateSync(fd, content.length); fs.fsyncSync(fd);
  };
  try {
    record({ status: 'reserved', userIds: expectedUsers.map(user => user.id) });
    const { env } = observedEnvironment('staging'); const config = configuration(env);
    if (!fs.statSync(config.socketPath).isSocket()) throw Error('admin_rotation_local_socket_required');
    connection = await require('mysql2/promise').createConnection(config);
    await connection.query('SET SESSION innodb_lock_wait_timeout=5');
    const result = await rotateGlobalAdminPasswords({ connection, expectedUsers, record });
    return { ...result, receiptPath, operationId };
  } finally {
    try { if (connection) await connection.end(); } finally { fs.closeSync(fd); }
  }
}

if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
  process.stderr.write('admin_rotation_incomplete; inspect private receipt before any retry; no raw errors or credentials emitted\n'); process.exitCode = 1;
});
module.exports = { run };
