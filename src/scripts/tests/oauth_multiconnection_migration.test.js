'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260715151500-enable-multiple-oauth-connections');
const {
  persistGoogleConnection,
} = require('../../services/oauthConnectionPersistence.service');

function field(attribute) {
  return { attribute };
}

function index(name, unique, columns) {
  return {
    name,
    unique,
    fields: columns.map(field),
  };
}

function initialIndexes() {
  return {
    GoogleConnections: [
      index('PRIMARY', true, ['id']),
      index('userId', true, ['userId']),
      index('userId_2', true, ['userId']),
      index('google_connections_user_id', false, ['userId']),
      index('google_connections_google_user_id', false, ['googleUserId']),
    ],
    MetaConnections: [
      index('PRIMARY', true, ['id']),
      index('userId', true, ['userId']),
      index('userId_2', true, ['userId']),
      index('metaUserId', true, ['metaUserId']),
    ],
  };
}

function cloneIndexes(indexes) {
  return Object.fromEntries(Object.entries(indexes).map(([table, tableIndexes]) => [
    table,
    tableIndexes.map((entry) => ({
      ...entry,
      fields: entry.fields.map((column) => ({ ...column })),
    })),
  ]));
}

function duplicateQueryKey(sql) {
  const table = sql.match(/FROM\s+`([^`]+)`/i)?.[1];
  const groupBy = sql.match(/GROUP BY\s+([\s\S]*?)\s+HAVING/i)?.[1] || '';
  const columns = [...groupBy.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  return `${table}:${columns.join(',')}`;
}

function buildQueryInterface({
  indexes: providedIndexes = initialIndexes(),
  duplicates = [],
} = {}) {
  const indexes = cloneIndexes(providedIndexes);
  const duplicateKeys = new Set(duplicates);
  const operations = [];
  const queries = [];
  return {
    indexes,
    operations,
    queries,
    sequelize: {
      async query(sql) {
        const key = duplicateQueryKey(sql);
        queries.push(key);
        return duplicateKeys.has(key)
          ? [[{ duplicate_count: 2 }], {}]
          : [[], {}];
      },
    },
    async showIndex(table) {
      return indexes[table].map((entry) => ({
        ...entry,
        fields: entry.fields.map((column) => ({ ...column })),
      }));
    },
    async addIndex(table, columns, options) {
      operations.push(`add:${table}:${options.name}`);
      indexes[table].push(index(options.name, !!options.unique, columns));
    },
    async removeIndex(table, name) {
      operations.push(`remove:${table}:${name}`);
      indexes[table] = indexes[table].filter((entry) => entry.name !== name);
    },
  };
}

function hasIndex(qi, table, columns, unique) {
  return qi.indexes[table].some((entry) => (
    entry.unique === unique
    && entry.fields.map((column) => column.attribute).join(',') === columns.join(',')
  ));
}

async function testSafeUpAndDownOrdering() {
  const qi = buildQueryInterface();
  await migration.up(qi);
  const addGoogleComposite = qi.operations.indexOf(
    'add:GoogleConnections:uniq_google_connections_user_provider'
  );
  const removeFirstGoogleLegacy = qi.operations.indexOf('remove:GoogleConnections:userId');
  assert.ok(addGoogleComposite >= 0 && addGoogleComposite < removeFirstGoogleLegacy);
  const addMetaComposite = qi.operations.indexOf(
    'add:MetaConnections:uniq_meta_connections_user_provider'
  );
  const removeFirstMetaLegacy = qi.operations.indexOf('remove:MetaConnections:userId');
  assert.ok(addMetaComposite >= 0 && addMetaComposite < removeFirstMetaLegacy);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId', 'googleUserId'], true), true);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId'], true), false);
  assert.equal(hasIndex(qi, 'MetaConnections', ['userId', 'metaUserId'], true), true);
  assert.equal(hasIndex(qi, 'MetaConnections', ['metaUserId'], true), false);

  const downStart = qi.operations.length;
  await migration.down(qi);
  const downOperations = qi.operations.slice(downStart);
  const restoreGoogleLegacy = downOperations.indexOf(
    'add:GoogleConnections:uniq_google_connections_user_id'
  );
  const removeGoogleComposite = downOperations.findIndex((operation) => (
    operation.startsWith('remove:GoogleConnections:uniq_google_connections_user_provider')
  ));
  assert.ok(restoreGoogleLegacy >= 0 && restoreGoogleLegacy < removeGoogleComposite);

  const restoreMetaUserLegacy = downOperations.indexOf(
    'add:MetaConnections:uniq_meta_connections_user_id'
  );
  const restoreMetaProviderLegacy = downOperations.indexOf(
    'add:MetaConnections:uniq_meta_connections_provider_id'
  );
  const removeMetaComposite = downOperations.findIndex((operation) => (
    operation.startsWith('remove:MetaConnections:uniq_meta_connections_user_provider')
  ));
  assert.ok(restoreMetaUserLegacy >= 0 && restoreMetaUserLegacy < removeMetaComposite);
  assert.ok(restoreMetaProviderLegacy >= 0 && restoreMetaProviderLegacy < removeMetaComposite);

  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId'], true), true);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId', 'googleUserId'], true), false);
  assert.equal(hasIndex(qi, 'MetaConnections', ['userId'], true), true);
  assert.equal(hasIndex(qi, 'MetaConnections', ['metaUserId'], true), true);
}

async function testUpDuplicateChecksAbortBeforeAnyDdl() {
  for (const duplicate of [
    'GoogleConnections:userId,googleUserId',
    'MetaConnections:userId,metaUserId',
  ]) {
    const qi = buildQueryInterface({ duplicates: [duplicate] });
    await assert.rejects(
      migration.up(qi),
      /contiene duplicados.*la migración se detiene/i
    );
    assert.deepEqual(
      qi.operations,
      [],
      `up must not execute DDL when ${duplicate} is duplicated`
    );
  }
}

async function testDownDuplicateChecksAbortBeforeAnyDdl() {
  const migratedIndexes = {
    GoogleConnections: [
      index('PRIMARY', true, ['id']),
      index('uniq_google_connections_user_provider', true, ['userId', 'googleUserId']),
      index('idx_google_connections_user_id', false, ['userId']),
    ],
    MetaConnections: [
      index('PRIMARY', true, ['id']),
      index('uniq_meta_connections_user_provider', true, ['userId', 'metaUserId']),
      index('idx_meta_connections_user_id', false, ['userId']),
      index('idx_meta_connections_provider_id', false, ['metaUserId']),
    ],
  };

  for (const duplicate of [
    'GoogleConnections:userId',
    'MetaConnections:userId',
    'MetaConnections:metaUserId',
  ]) {
    const qi = buildQueryInterface({
      indexes: migratedIndexes,
      duplicates: [duplicate],
    });
    await assert.rejects(
      migration.down(qi),
      /contiene duplicados.*la migración se detiene/i
    );
    assert.deepEqual(
      qi.operations,
      [],
      `down must not execute DDL when ${duplicate} is duplicated`
    );
  }
}

async function testUpResumesFromPartialDdlAndIsReentrant() {
  const qi = buildQueryInterface({
    indexes: {
      GoogleConnections: [
        index('PRIMARY', true, ['id']),
        index('userId', true, ['userId']),
        index('userId_2', true, ['userId']),
        index('uniq_google_connections_user_provider', true, ['userId', 'googleUserId']),
      ],
      MetaConnections: [
        index('PRIMARY', true, ['id']),
        index('userId', true, ['userId']),
        index('metaUserId', true, ['metaUserId']),
        index('uniq_meta_connections_user_provider', true, ['userId', 'metaUserId']),
        index('idx_meta_connections_user_id', false, ['userId']),
      ],
    },
  });

  await migration.up(qi);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId', 'googleUserId'], true), true);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId'], false), true);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId'], true), false);
  assert.equal(hasIndex(qi, 'MetaConnections', ['userId', 'metaUserId'], true), true);
  assert.equal(hasIndex(qi, 'MetaConnections', ['userId'], false), true);
  assert.equal(hasIndex(qi, 'MetaConnections', ['metaUserId'], false), true);
  assert.equal(hasIndex(qi, 'MetaConnections', ['userId'], true), false);
  assert.equal(hasIndex(qi, 'MetaConnections', ['metaUserId'], true), false);

  const firstRunDdlCount = qi.operations.length;
  await migration.up(qi);
  assert.equal(
    qi.operations.length,
    firstRunDdlCount,
    're-running up over the completed partial state must be a DDL no-op'
  );
}

async function testDownResumesFromPartialDdlAndIsReentrant() {
  const qi = buildQueryInterface({
    indexes: {
      GoogleConnections: [
        index('PRIMARY', true, ['id']),
        index('uniq_google_connections_user_provider', true, ['userId', 'googleUserId']),
        index('idx_google_connections_user_id', false, ['userId']),
        index('uniq_google_connections_user_id', true, ['userId']),
      ],
      MetaConnections: [
        index('PRIMARY', true, ['id']),
        index('uniq_meta_connections_user_provider', true, ['userId', 'metaUserId']),
        index('idx_meta_connections_user_id', false, ['userId']),
        index('idx_meta_connections_provider_id', false, ['metaUserId']),
        index('uniq_meta_connections_user_id', true, ['userId']),
      ],
    },
  });

  await migration.down(qi);
  const addMetaProvider = qi.operations.indexOf(
    'add:MetaConnections:uniq_meta_connections_provider_id'
  );
  const removeMetaComposite = qi.operations.indexOf(
    'remove:MetaConnections:uniq_meta_connections_user_provider'
  );
  assert.ok(addMetaProvider >= 0 && addMetaProvider < removeMetaComposite);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId'], true), true);
  assert.equal(hasIndex(qi, 'GoogleConnections', ['userId', 'googleUserId'], true), false);
  assert.equal(hasIndex(qi, 'MetaConnections', ['userId'], true), true);
  assert.equal(hasIndex(qi, 'MetaConnections', ['metaUserId'], true), true);
  assert.equal(hasIndex(qi, 'MetaConnections', ['userId', 'metaUserId'], true), false);

  const firstRunDdlCount = qi.operations.length;
  await migration.down(qi);
  assert.equal(
    qi.operations.length,
    firstRunDdlCount,
    're-running down over the completed partial state must be a DDL no-op'
  );
}

function legacyUniqueUserModel(initialRow) {
  const rows = [{ ...initialRow }];
  const snapshot = () => rows.map((row) => ({ ...row }));
  return {
    rows,
    snapshot,
    async findOne({ where }) {
      const row = rows.find((candidate) => Object.entries(where)
        .every(([key, value]) => candidate[key] === value));
      if (!row) return null;
      return {
        ...row,
        async update(values) {
          Object.assign(row, values);
          Object.assign(this, values);
          return this;
        },
      };
    },
    async create(values) {
      if (rows.some((row) => row.userId === values.userId)) {
        const error = new Error('Duplicate entry for legacy UNIQUE(userId)');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      const row = { id: rows.length + 1, ...values };
      rows.push(row);
      return row;
    },
  };
}

async function testSecondIdentityFailsClosedUnderLegacyUniqueness() {
  const model = legacyUniqueUserModel({
    id: 91,
    userId: 7,
    googleUserId: 'google-existing',
    accessToken: 'existing-access-token',
    refreshToken: 'existing-refresh-token',
  });
  const before = model.snapshot();

  await assert.rejects(
    persistGoogleConnection({
      userId: 7,
      googleUserId: 'google-second',
      userEmail: 'owner@example.com',
      accessToken: 'second-access-token',
      refreshToken: 'second-refresh-token',
      expiresAt: new Date('2026-08-01T00:00:00Z'),
    }, { GoogleConnectionModel: model }),
    (error) => error?.code === 'ER_DUP_ENTRY'
  );
  assert.deepEqual(
    model.snapshot(),
    before,
    'legacy uniqueness must reject a second identity without overwriting the existing grant'
  );
}

async function run() {
  await testSafeUpAndDownOrdering();
  await testUpDuplicateChecksAbortBeforeAnyDdl();
  await testDownDuplicateChecksAbortBeforeAnyDdl();
  await testUpResumesFromPartialDdlAndIsReentrant();
  await testDownResumesFromPartialDdlAndIsReentrant();
  await testSecondIdentityFailsClosedUnderLegacyUniqueness();
  console.log('oauth multi-connection migration tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
