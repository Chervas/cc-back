'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const { QUERIES, collectMetadata, project } = require('../../lib/databaseEncryptionMetadata');
const { configuration } = require('../security-database-metadata');
test('metadata queries are fixed, read only and never project clinical or error payloads', async () => {
  const calls = [];
  const result = await collectMetadata({ query: async sql => { calls.push(sql); throw Object.assign(Error('PRIVATE_SENTINEL'), { sql: 'PRIVATE_SENTINEL' }); } });
  assert.equal(calls.length, 10); assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  assert(calls.every(sql => /^(SELECT|SHOW) /.test(sql) && !sql.includes(';') && !/SELECT\s+\*/i.test(sql)));
  assert.equal(result.completeEncryptionAssessment, false);
  assert(Object.values(result.checks).every(check => check.status === 'unavailable'));
});
test('unknown and denied metadata never become claims of encryption or zero resources', async () => {
  const result = await collectMetadata({ query: async sql => {
    throw Object.assign(Error('PRIVATE_SENTINEL'), { code: sql === QUERIES.tablespaces ? 'ER_SPECIFIC_ACCESS_DENIED_ERROR' : 'ER_NO_SUCH_TABLE' });
  } });
  assert.equal(result.checks.tablespaces.code, 'metadata_permission_denied');
  assert.equal(result.checks.keyringComponent.code, 'metadata_capability_unavailable');
  assert.equal(result.providerVolumeEncryption, 'unverified'); assert.equal(result.backupEncryption, 'unverified');
  assert.deepEqual(result.findings, []);
});
test('findings distinguish defaults, tablespaces, logs and unattributed non-TLS sessions', async () => {
  const result = await collectMetadata({ query: async sql => {
    if (sql === QUERIES.variables) return ['default_table_encryption','innodb_redo_log_encrypt','innodb_undo_log_encrypt','require_secure_transport','binlog_encryption']
      .map(Variable_name => ({ Variable_name, Value: 'OFF' })).concat([{ Variable_name: 'log_bin', Value: 'ON' }]);
    if (sql === QUERIES.tablespaces) return [{ kind: 'Single', encrypted: 'N', count: 3 }];
    if (sql === QUERIES.observedTls) return [{ observedConnections: '3', tlsConnections: '1' }];
    throw Error('unavailable');
  } });
  assert.equal(result.findings.length, 7); assert(result.findings.includes('binary_log_encryption_disabled'));
  assert.equal(result.applicationCertificateValidation, 'unverified');
});
test('closed projections reject strange values and strip extra data', () => {
  assert.deepEqual(project('tablespaces', [{ kind: 'Single', encrypted: 'Y', count: 2, token: 'PRIVATE_SENTINEL' }]),
    [{ kind: 'Single', encrypted: true, count: '2' }]);
  for (const [name, rows] of [['variables', [{ Variable_name: 'password', Value: 'PRIVATE_SENTINEL' }]],
    ['tablespaces', [{ kind: 'PRIVATE_SENTINEL', encrypted: 'Y', count: 0 }]], ['engine', [{ version: 'PRIVATE_SENTINEL' }]]]) {
    assert.throws(() => project(name, rows), /metadata_response_invalid/);
  }
});
test('live entry requires loopback config and uses only a UNIX socket without app bootstrap or TCP fallback', () => {
  const env = { DB_HOST: 'localhost', DB_USERNAME: 'fixture', DB_PASSWORD: 'fixture', DB_NAME: 'fixture' };
  const value = configuration(env); assert.equal(value.multipleStatements, false);
  assert.equal(value.socketPath, '/var/run/mysqld/mysqld.sock'); assert.equal(value.host, undefined); assert.equal(value.port, undefined);
  assert.throws(() => configuration({ ...env, DB_HOST: 'remote.invalid' }), /metadata_local_configuration_required/);
});
