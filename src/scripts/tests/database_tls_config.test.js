'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDatabaseTlsOptions } = require('../../lib/databaseTlsConfig');
test('unconfigured legacy deployment stays unchanged without reading any CA or secrets', () => {
  for (const value of [undefined, '', 'false']) assert.deepEqual(buildDatabaseTlsOptions({ DB_TLS_REQUIRED: value }, () => assert.fail('No file read')), {});
});
test('remote destinations cannot silently disable verified TLS', () => {
  for (const DB_HOST of ['database.example.invalid', '172.31.64.10', '2001:db8::1']) {
    for (const DB_TLS_REQUIRED of [undefined, '', 'false']) {
      assert.throws(() => buildDatabaseTlsOptions({ DB_HOST, DB_TLS_REQUIRED }), /database_remote_tls_required/);
    }
  }
  for (const DB_HOST of ['localhost', 'LOCALHOST', '127.0.0.1', '::1']) {
    assert.deepEqual(buildDatabaseTlsOptions({ DB_HOST }), {});
  }
});
test('required TLS fails closed on typo, relative CA, missing CA or private key input', () => {
  assert.throws(() => buildDatabaseTlsOptions({ DB_TLS_REQUIRED: 'TRUE' }), /database_tls_mode_invalid/);
  for (const DB_TLS_CA_FILE of [undefined, './ca.pem']) assert.throws(() => buildDatabaseTlsOptions({ DB_TLS_REQUIRED:'true', DB_TLS_CA_FILE }), /database_tls_ca_required/);
  for (const read of [() => { throw Error('PRIVATE_SENTINEL'); }, () => '-----BEGIN PRIVATE KEY-----PRIVATE_SENTINEL-----END PRIVATE KEY-----', () => Buffer.alloc(1048577)]) {
    assert.throws(() => buildDatabaseTlsOptions({ DB_TLS_REQUIRED:'true', DB_TLS_CA_FILE:'/fixture/ca.pem' },read),
      error => error.message === 'database_tls_ca_invalid' && !error.message.includes('PRIVATE_SENTINEL'));
  }
});
