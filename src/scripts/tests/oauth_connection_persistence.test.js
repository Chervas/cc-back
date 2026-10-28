'use strict';

const assert = require('node:assert/strict');
// Test-only injection: execute the actual persistence source without loading
// models/index, a Sequelize connection, .env or application bootstrap.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { REGISTRIES, createGoogleLegacyOAuthGuard } = require('../../services/googleLegacyOAuthGuard.service');
const metaQuarantine = require('../../lib/metaQuarantineHttp');
const filename = path.resolve(__dirname, '../../services/oauthConnectionPersistence.service.js');
const loaded = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: loaded, exports: loaded.exports,
  require: name => {
    if (name === '../../models') return Object.freeze({});
    if (name === './googleLegacyOAuthGuard.service') return { createGoogleLegacyOAuthGuard };
    if (name === '../lib/metaQuarantineHttp') return metaQuarantine;
    throw Error('UNEXPECTED_DEPENDENCY_IN_PERSISTENCE_TEST');
  },
}, { filename, timeout: 1000 });
const { persistGoogleConnection, persistMetaConnection } = loaded.exports;

function fakeModel(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  let activeTransaction = null;
  const wrap = (row) => ({
    ...row,
    async update(values, options) {
      assert.equal(options?.transaction, activeTransaction);
      assert(activeTransaction);
      Object.assign(row, values);
      Object.assign(this, values);
      return this;
    },
  });
  const model = {
    rows,
    async findOne({ where, transaction, lock }) {
      assert.equal(transaction, activeTransaction);
      assert.equal(lock, transaction.LOCK.UPDATE);
      const row = rows.find((candidate) => Object.entries(where)
        .every(([key, value]) => candidate[key] === value));
      return row ? wrap(row) : null;
    },
    async create(values, options) {
      assert.equal(options?.transaction, activeTransaction);
      assert(activeTransaction);
      const row = { id: rows.length + 1, ...values };
      rows.push(row);
      return wrap(row);
    },
  };
  model.sequelize = { async transaction(options, work) {
    assert.equal(options.isolationLevel, 'SERIALIZABLE');
    assert.equal(activeTransaction, null);
    const before = rows.map(row => ({ ...row }));
    const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
    activeTransaction = transaction;
    try { return await work(transaction); }
    catch (error) { rows.splice(0, rows.length, ...before); throw error; }
    finally { activeTransaction = null; }
  } };
  model.registryModels = Object.fromEntries(REGISTRIES.map(([name, attribute]) => [name, {
    async findOne(options) {
      assert.equal(options.transaction, activeTransaction);
      assert.equal(options.lock, activeTransaction.LOCK.SHARE);
      assert.deepEqual(Array.from(options.attributes), [attribute]);
      assert.equal(options.raw, true);
      assert.equal(options.logging, false);
      return null;
    },
  }]));
  return model;
}
function googleOptions(model) {
  return { GoogleConnectionModel: model, models: model.registryModels, sequelize: model.sequelize };
}

async function testGoogleIdentityIsolationAndRefreshPreservation() {
  const model = fakeModel();
  const common = {
    userId: 7,
    userEmail: 'owner@example.com',
    accessToken: 'access-a',
    expiresAt: new Date('2026-08-01T00:00:00Z'),
  };
  await persistGoogleConnection({
    ...common,
    googleUserId: 'google-a',
    refreshToken: 'refresh-a',
  }, googleOptions(model));
  await persistGoogleConnection({
    ...common,
    googleUserId: 'google-b',
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
  }, googleOptions(model));
  assert.equal(model.rows.length, 2, 'a second provider identity must create a second grant');

  const reconnected = await persistGoogleConnection({
    ...common,
    googleUserId: 'google-a',
    accessToken: 'access-a-2',
    refreshToken: null,
  }, googleOptions(model));
  assert.equal(model.rows.length, 2, 'reconnecting the same identity must update its canonical row');
  assert.equal(reconnected.accessToken, 'access-a-2');
  assert.equal(reconnected.refreshToken, 'refresh-a', 'Google may omit refresh_token on reconnect');
  assert.equal(model.rows.find((row) => row.googleUserId === 'google-b').accessToken, 'access-b');
}

async function testMetaIdentityIsolation() {
  const model = fakeModel();
  for (const metaUserId of ['meta-a', 'meta-b']) {
    await assert.rejects(persistMetaConnection({ userId: 7, metaUserId, accessToken: 'FICTITIOUS_TOKEN' },
      { MetaConnectionModel: model }), { code: 'meta_security_quarantine' });
  }
  assert.equal(model.rows.length, 0, 'Neither the original subject nor an alternative can store credentials during quarantine');
}

async function testProviderIdentityRequired() {
  const model = fakeModel();
  await assert.rejects(
    persistGoogleConnection({
      userId: 7,
      googleUserId: 'unknown',
      accessToken: 'token',
      expiresAt: new Date(),
    }, googleOptions(model)),
    (error) => error?.code === 'oauth_connection_identity_invalid'
  );
  assert.equal(model.rows.length, 0);
}

async function run() {
  const noBootstrap = () => assert(!Object.keys(require.cache).some(name => /[\\/]models[\\/]index\.js$/.test(name)), 'The unit must not bootstrap application models');
  noBootstrap();
  await testGoogleIdentityIsolationAndRefreshPreservation();
  await testMetaIdentityIsolation();
  await testProviderIdentityRequired();
  noBootstrap();
  console.log('oauth connection persistence tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
