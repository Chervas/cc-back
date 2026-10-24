'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Simulate inherited production-like configuration without reading any secret.
Object.assign(process.env, { DB_HOST: 'remote-fixture.invalid', DB_TLS_REQUIRED: 'true',
  DB_TLS_CA_FILE: '/TEST_ONLY_MUST_NOT_READ.pem', DB_SOCKET_PATH: '/TEST_ONLY_MUST_NOT_CONNECT.sock' });
require('./fixtures/security_offline_runtime.cjs');

test('offline preload overrides inherited transport settings before genuine configuration is imported', () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_PORT, '1');
  assert.equal(process.env.DB_TLS_REQUIRED, 'false'); assert.equal(process.env.DB_TLS_CA_FILE, '');
  assert.equal(process.env.DB_SOCKET_PATH, ''); assert.equal(process.env.DB_SOCKET, '');
  assert.deepEqual(require('dotenv').config({ path: '/TEST_ONLY_MUST_NOT_READ.env' }), { parsed: {} });
  const config = require('../../config/config').test;
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.username, 'offline');
  assert.equal(config.database, 'offline'); assert.equal(config.dialectOptions.ssl, undefined);
  const { buildDatabaseTlsOptions } = require('../../lib/databaseTlsConfig');
  assert.throws(() => buildDatabaseTlsOptions({ DB_HOST: 'remote-fixture.invalid', DB_TLS_REQUIRED: 'false' }), /database_remote_tls_required/);
});

test('ordinary TCP, Unix socket, TLS and provider entrypoints fail before any connection', () => {
  const net = require('node:net'); const tls = require('node:tls');
  for (const operation of [() => net.connect({ host: '127.0.0.1', port: 1 }),
    () => net.createConnection({ path: '/TEST_ONLY_MUST_NOT_CONNECT.sock' }),
    () => new net.Socket().connect({ host: 'remote-fixture.invalid', port: 3306 }),
    () => tls.connect({ host: 'remote-fixture.invalid', port: 3306 }),
    () => global.fetch('https://remote-fixture.invalid')]) {
    assert.throws(operation, /NETWORK_FORBIDDEN_IN_OFFLINE_(?:SECURITY|CAMPAIGN)_TEST/);
  }
});
