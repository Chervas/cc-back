'use strict';

const assert = require('node:assert/strict');
const {
  persistGoogleConnection,
  persistMetaConnection,
} = require('../../services/oauthConnectionPersistence.service');

function fakeModel(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  const wrap = (row) => ({
    ...row,
    async update(values) {
      Object.assign(row, values);
      Object.assign(this, values);
      return this;
    },
  });
  return {
    rows,
    async findOne({ where }) {
      const row = rows.find((candidate) => Object.entries(where)
        .every(([key, value]) => candidate[key] === value));
      return row ? wrap(row) : null;
    },
    async create(values) {
      const row = { id: rows.length + 1, ...values };
      rows.push(row);
      return wrap(row);
    },
  };
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
  }, { GoogleConnectionModel: model });
  await persistGoogleConnection({
    ...common,
    googleUserId: 'google-b',
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
  }, { GoogleConnectionModel: model });
  assert.equal(model.rows.length, 2, 'a second provider identity must create a second grant');

  const reconnected = await persistGoogleConnection({
    ...common,
    googleUserId: 'google-a',
    accessToken: 'access-a-2',
    refreshToken: null,
  }, { GoogleConnectionModel: model });
  assert.equal(model.rows.length, 2, 'reconnecting the same identity must update its canonical row');
  assert.equal(reconnected.accessToken, 'access-a-2');
  assert.equal(reconnected.refreshToken, 'refresh-a', 'Google may omit refresh_token on reconnect');
  assert.equal(model.rows.find((row) => row.googleUserId === 'google-b').accessToken, 'access-b');
}

async function testMetaIdentityIsolation() {
  const model = fakeModel();
  const common = {
    userId: 7,
    accessToken: 'meta-token-a',
    expiresAt: new Date('2026-08-01T00:00:00Z'),
  };
  await persistMetaConnection({ ...common, metaUserId: 'meta-a' }, { MetaConnectionModel: model });
  await persistMetaConnection({
    ...common,
    metaUserId: 'meta-b',
    accessToken: 'meta-token-b',
  }, { MetaConnectionModel: model });
  assert.equal(model.rows.length, 2);

  await persistMetaConnection({
    ...common,
    metaUserId: 'meta-a',
    accessToken: 'meta-token-a-2',
  }, { MetaConnectionModel: model });
  assert.equal(model.rows.length, 2);
  assert.equal(model.rows.find((row) => row.metaUserId === 'meta-a').accessToken, 'meta-token-a-2');
  assert.equal(model.rows.find((row) => row.metaUserId === 'meta-b').accessToken, 'meta-token-b');
}

async function testProviderIdentityRequired() {
  const model = fakeModel();
  await assert.rejects(
    persistGoogleConnection({
      userId: 7,
      googleUserId: 'unknown',
      accessToken: 'token',
      expiresAt: new Date(),
    }, { GoogleConnectionModel: model }),
    (error) => error?.code === 'oauth_connection_identity_invalid'
  );
  assert.equal(model.rows.length, 0);
}

async function run() {
  await testGoogleIdentityIsolationAndRefreshPreservation();
  await testMetaIdentityIsolation();
  await testProviderIdentityRequired();
  console.log('oauth connection persistence tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
