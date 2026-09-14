#!/usr/bin/env node
'use strict';
// Explicit local metadata audit. Never import app models or initialize schema.
const fs = require('node:fs');
const path = require('node:path');
const { collectMetadata } = require('../lib/databaseEncryptionMetadata');
function configuration(env) {
  if (!['localhost', '127.0.0.1', '::1'].includes(env.DB_HOST) || env.DB_PORT && env.DB_PORT !== '3306'
    || !env.DB_USERNAME || !env.DB_PASSWORD || !env.DB_NAME) throw Error('metadata_local_configuration_required');
  return { socketPath: '/var/run/mysqld/mysqld.sock', user: env.DB_USERNAME, password: env.DB_PASSWORD,
    database: env.DB_NAME, connectTimeout: 5000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true };
}
async function run(argv) {
  if (argv.length !== 5 || argv[0] !== '--local-metadata-only' || argv[1] !== '--env-file' || argv[3] !== '--out') throw Error('metadata_arguments_invalid');
  const envFile = argv[2]; const out = argv[4];
  if (!['back-dev', 'back-staging', 'gateway'].some(name => envFile === '/home/ubuntu/wt/' + name + '/.env')
    || !path.isAbsolute(out) || !fs.realpathSync(path.dirname(out)).startsWith('/home/ubuntu/qa-evidence/')) throw Error('metadata_path_invalid');
  // Reserve a private evidence file first; no accidental overwrite or public output.
  const output = fs.openSync(out, 'wx', 0o600);
  let connection;
  try {
    const env = require('dotenv').parse(fs.readFileSync(envFile));
    const config = configuration(env);
    if (!fs.statSync(config.socketPath).isSocket()) throw Error('metadata_local_socket_required');
    connection = await require('mysql2/promise').createConnection(config);
    const report = await collectMetadata({ query: async sql => (await connection.query({ sql, timeout: 5000 }))[0] });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    return { evidence: out, checks: Object.keys(report.checks).length, findings: report.findings, completeEncryptionAssessment: false };
  } catch {
    fs.writeFileSync(output, JSON.stringify({ mode: 'metadata_only', status: 'unavailable', code: 'metadata_audit_unavailable' }) + '\n');
    throw Error('metadata_audit_unavailable');
  } finally {
    try { if (connection) await connection.end(); } finally { fs.closeSync(output); }
  }
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
  process.stderr.write('metadata_audit_unavailable; no details or credentials emitted\n'); process.exitCode = 1;
});
module.exports = { run, configuration };
