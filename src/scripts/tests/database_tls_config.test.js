'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDatabaseTlsOptions } = require('../../lib/databaseTlsConfig');
test('unconfigured legacy deployment stays unchanged without reading any CA or secrets', () => {
  for (const value of [undefined, '', 'false']) assert.deepEqual(buildDatabaseTlsOptions({ DB_TLS_REQUIRED: value }, () => assert.fail('No file read')), {});
});
test('required TLS fails closed on typo, relative CA, missing CA or private key input', () => {
  assert.throws(() => buildDatabaseTlsOptions({ DB_TLS_REQUIRED: 'TRUE' }), /database_tls_mode_invalid/);
  for (const DB_TLS_CA_FILE of [undefined, './ca.pem']) assert.throws(() => buildDatabaseTlsOptions({ DB_TLS_REQUIRED:'true', DB_TLS_CA_FILE }), /database_tls_ca_required/);
  for (const read of [() => { throw Error('PRIVATE_SENTINEL'); }, () => '-----BEGIN PRIVATE KEY-----PRIVATE_SENTINEL-----END PRIVATE KEY-----', () => Buffer.alloc(1048577)]) {
    assert.throws(() => buildDatabaseTlsOptions({ DB_TLS_REQUIRED:'true', DB_TLS_CA_FILE:'/fixture/ca.pem' },read),
      error => error.message === 'database_tls_ca_invalid' && !error.message.includes('PRIVATE_SENTINEL'));
  }
});
