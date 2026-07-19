'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260719091500-encrypt-web-intake-runtime-secrets');
const {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
} = require('../../lib/webRuntimeSecretEnvelope');
const {
  FENCE_MESSAGE,
  FENCE_TRIGGERS,
} = require('../../lib/webRuntimeSecretMigration');

const SOURCE_SECRET = 'legacy-source-hmac-0123456789abcdef';
const TARGET_SECRET = 'legacy-target-hmac-fedcba9876543210';
const TEST_ENV = {
  MARKETING_WEB_RUNTIME_ENVELOPE_KEY: Buffer.alloc(32, 17).toString('base64url'),
  MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID: 'runtime-migration-test-v1',
  MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED: 'true',
};

function withTestEnv(callback) {
  const names = [
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY',
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID',
    'MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY',
    'MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, TEST_ENV);
  delete process.env.MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    });
}

function context(row, slot) {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    generation: row.generation,
    slot,
  };
}

function queryInterfaceStub({
  rows,
  columns,
  onAfterUpdate = null,
  onTriggerCreated = null,
  triggers = [],
  failAlterCount = 0,
}) {
  const table = { ...columns };
  const triggerRows = new Map(triggers.map((trigger) => [trigger.TRIGGER_NAME, { ...trigger }]));
  const calls = [];
  const qi = {
    calls,
    rows,
    queryGenerator: {
      quoteTable: (name) => `\`${name}\``,
      quoteIdentifier: (name) => `\`${name}\``,
    },
    async describeTable() { return { ...table }; },
    async addColumn(_table, column) {
      calls.push(['addColumn', column]);
      table[column] = {};
      for (const row of rows) row[column] = null;
    },
    async removeColumn(_table, column) {
      calls.push(['removeColumn', column]);
      delete table[column];
      for (const row of rows) delete row[column];
    },
  };
  qi.sequelize = {
    connectionManager: {
      async getConnection() { calls.push(['getConnection']); return { id: 'migration-fence' }; },
      releaseConnection() { calls.push(['releaseConnection']); },
    },
    async query(sql, options = {}) {
      calls.push(['query', sql, options.replacements || null]);
      if (/^(LOCK|UNLOCK) TABLES/u.test(sql)) return [[], {}];
      if (/FROM information_schema\.TRIGGERS/u.test(sql)) {
        return [[...triggerRows.values()].map((trigger) => ({ ...trigger })), {}];
      }
      if (/^CREATE TRIGGER /u.test(sql)) {
        const match = sql.match(/^CREATE TRIGGER `([^`]+)` BEFORE (UPDATE|INSERT|DELETE)/u);
        if (!match) throw new Error(`invalid trigger SQL: ${sql}`);
        triggerRows.set(match[1], {
          TRIGGER_NAME: match[1],
          EVENT_MANIPULATION: match[2],
          ACTION_TIMING: 'BEFORE',
          ACTION_STATEMENT: `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${FENCE_MESSAGE}'`,
          EVENT_OBJECT_TABLE: 'WebIntakeRuntimeReconciliations',
        });
        if (onTriggerCreated) onTriggerCreated({ name: match[1], event: match[2], rows });
        return [[], {}];
      }
      if (/^DROP TRIGGER /u.test(sql)) {
        const match = sql.match(/^DROP TRIGGER `([^`]+)`/u);
        triggerRows.delete(match[1]);
        return [[], {}];
      }
      if (/^SELECT /u.test(sql)) return [rows.map((row) => ({ ...row }))];
      if (/^UPDATE /u.test(sql)) {
        const row = rows.find((candidate) => candidate.id === options.replacements.id);
        if (!row) throw new Error('missing fixture row');
        for (const match of sql.matchAll(/(source_hmac_envelope|target_hmac_envelope) = :(value_\d+)/gu)) {
          row[match[1]] = options.replacements[match[2]];
        }
        if (onAfterUpdate) onAfterUpdate(row);
        return [[], {}];
      }
      if (/^ALTER TABLE /u.test(sql)) {
        if (failAlterCount > 0) {
          failAlterCount -= 1;
          throw new Error('simulated atomic ALTER failure');
        }
        for (const match of sql.matchAll(/DROP COLUMN `([^`]+)`/gu)) {
          delete table[match[1]];
          for (const row of rows) delete row[match[1]];
        }
        return [[], {}];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return qi;
}

function droppedColumns(qi) {
  return qi.calls
    .filter(([kind, sql]) => kind === 'query' && /^ALTER TABLE /u.test(sql))
    .flatMap(([, sql]) => [...sql.matchAll(/DROP COLUMN `([^`]+)`/gu)].map((match) => match[1]));
}

function baseRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    scope_type: 'clinic',
    scope_id: 55,
    generation: 2,
    source_hmac_key: SOURCE_SECRET,
    target_hmac_key: TARGET_SECRET,
    ...overrides,
  };
}

async function testMigratesBothLegacyColumnsWithoutPersistingPlaintext() {
  await withTestEnv(async () => {
    const row = baseRow();
    const qi = queryInterfaceStub({
      rows: [row],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_key: {}, target_hmac_key: {},
      },
    });
    await migration.up(qi, Sequelize);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'source_hmac_key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'target_hmac_key'), false);
    assert.equal(JSON.stringify(row).includes(SOURCE_SECRET), false);
    assert.equal(JSON.stringify(row).includes(TARGET_SECRET), false);
    assert.equal(
      decryptRuntimeSecret(row.source_hmac_envelope, context(row, 'source'), { env: TEST_ENV }),
      SOURCE_SECRET
    );
    assert.equal(
      decryptRuntimeSecret(row.target_hmac_envelope, context(row, 'target'), { env: TEST_ENV }),
      TARGET_SECRET
    );
    const updates = qi.calls.filter(([kind, sql]) => kind === 'query' && /^UPDATE /u.test(sql));
    assert.equal(JSON.stringify(updates).includes(SOURCE_SECRET), false);
    assert.equal(JSON.stringify(updates).includes(TARGET_SECRET), false);
    assert.deepEqual(
      droppedColumns(qi),
      ['source_hmac_key', 'target_hmac_key']
    );
  });
}

async function testMigratesOnlyExistingLegacyColumnAndResumesAfterPartialRemoval() {
  await withTestEnv(async () => {
    const onlySource = baseRow({ target_hmac_key: undefined });
    delete onlySource.target_hmac_key;
    const sourceOnlyQi = queryInterfaceStub({
      rows: [onlySource],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {}, source_hmac_key: {},
      },
    });
    await migration.up(sourceOnlyQi, Sequelize);
    assert.equal(
      decryptRuntimeSecret(onlySource.source_hmac_envelope, context(onlySource, 'source'), { env: TEST_ENV }),
      SOURCE_SECRET
    );
    assert.equal(onlySource.target_hmac_envelope, null);
    assert.deepEqual(
      droppedColumns(sourceOnlyQi),
      ['source_hmac_key']
    );

    // Simula una ejecución previa que ya cifró ambas ranuras y retiró source,
    // pero cayó antes de retirar target. El rerun valida el envelope existente.
    const partial = baseRow({
      source_hmac_envelope: encryptRuntimeSecret(SOURCE_SECRET, context(baseRow(), 'source'), { env: TEST_ENV }),
      target_hmac_envelope: encryptRuntimeSecret(TARGET_SECRET, context(baseRow(), 'target'), { env: TEST_ENV }),
    });
    delete partial.source_hmac_key;
    const partialQi = queryInterfaceStub({
      rows: [partial],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_envelope: {}, target_hmac_envelope: {}, target_hmac_key: {},
      },
    });
    await migration.up(partialQi, Sequelize);
    assert.equal(partialQi.calls.filter(([kind, sql]) => kind === 'query' && /^UPDATE /u.test(sql)).length, 0);
    assert.deepEqual(
      droppedColumns(partialQi),
      ['target_hmac_key']
    );
    assert.equal(
      decryptRuntimeSecret(partial.target_hmac_envelope, context(partial, 'target'), { env: TEST_ENV }),
      TARGET_SECRET
    );
  });
}

async function testMissingKeyOrTamperedEnvelopeNeverRemovesPlaintext() {
  const missingKeyRow = baseRow();
  const missingKeyQi = queryInterfaceStub({
    rows: [missingKeyRow],
    columns: {
      id: {}, scope_type: {}, scope_id: {}, generation: {},
      source_hmac_key: {}, target_hmac_key: {},
    },
  });
  const names = [
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY',
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID',
    'MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY',
    'MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED = 'true';
  try {
    await assert.rejects(
      migration.up(missingKeyQi, Sequelize),
      (error) => error.code === 'web_runtime_envelope_key_missing'
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
  assert.equal(droppedColumns(missingKeyQi).length, 0);
  assert.equal(missingKeyRow.source_hmac_key, SOURCE_SECRET);

  await withTestEnv(async () => {
    const tamperedRow = baseRow();
    const sealed = JSON.parse(encryptRuntimeSecret(
      SOURCE_SECRET,
      context(tamperedRow, 'source'),
      { env: TEST_ENV }
    ));
    sealed.tag = `${sealed.tag[0] === 'A' ? 'B' : 'A'}${sealed.tag.slice(1)}`;
    tamperedRow.source_hmac_envelope = JSON.stringify(sealed);
    const tamperedQi = queryInterfaceStub({
      rows: [tamperedRow],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_key: {}, target_hmac_key: {},
        source_hmac_envelope: {}, target_hmac_envelope: {},
      },
    });
    await assert.rejects(
      migration.up(tamperedQi, Sequelize),
      (error) => error.code === 'web_runtime_envelope_decrypt_failed'
    );
    assert.equal(droppedColumns(tamperedQi).length, 0);
    assert.equal(tamperedRow.source_hmac_key, SOURCE_SECRET);
    assert.equal(tamperedRow.target_hmac_key, TARGET_SECRET);
  });
}

async function testRequiresQuiescenceAndDetectsDriftBeforeDrop() {
  const names = [
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY',
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID',
    'MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, TEST_ENV);
  delete process.env.MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED;
  const unquiesced = queryInterfaceStub({
    rows: [baseRow()],
    columns: {
      id: {}, scope_type: {}, scope_id: {}, generation: {},
      source_hmac_key: {}, target_hmac_key: {},
    },
  });
  try {
    await assert.rejects(
      migration.up(unquiesced, Sequelize),
      (error) => error.code === 'web_runtime_envelope_migration_not_quiesced'
    );
    assert.equal(droppedColumns(unquiesced).length, 0);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }

  await withTestEnv(async () => {
    let drifted = false;
    const row = baseRow();
    const qi = queryInterfaceStub({
      rows: [row],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_key: {}, target_hmac_key: {},
      },
      onAfterUpdate(current) {
        if (!drifted) {
          drifted = true;
          current.source_hmac_key = 'concurrent-legacy-write';
        }
      },
    });
    await assert.rejects(
      migration.up(qi, Sequelize),
      (error) => error.code === 'web_runtime_envelope_migration_mismatch'
    );
    assert.equal(droppedColumns(qi).length, 0);
  });

  await withTestEnv(async () => {
    const row = baseRow({ source_hmac_key: null });
    const sealed = JSON.parse(encryptRuntimeSecret(
      SOURCE_SECRET,
      context(row, 'source'),
      { env: TEST_ENV }
    ));
    sealed.tag = `${sealed.tag[0] === 'A' ? 'B' : 'A'}${sealed.tag.slice(1)}`;
    row.source_hmac_envelope = JSON.stringify(sealed);
    const qi = queryInterfaceStub({
      rows: [row],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_key: {}, target_hmac_key: {},
        source_hmac_envelope: {}, target_hmac_envelope: {},
      },
    });
    await assert.rejects(
      migration.up(qi, Sequelize),
      (error) => error.code === 'web_runtime_envelope_decrypt_failed'
    );
    assert.equal(droppedColumns(qi).length, 0);
  });
}

async function testCleansOwnedFenceAfterCrashEvenWithoutLegacyColumns() {
  await withTestEnv(async () => {
    const triggers = FENCE_TRIGGERS.map(({ name, event }) => ({
      TRIGGER_NAME: name,
      EVENT_MANIPULATION: event,
      ACTION_TIMING: 'BEFORE',
      ACTION_STATEMENT: `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${FENCE_MESSAGE}'`,
      EVENT_OBJECT_TABLE: 'WebIntakeRuntimeReconciliations',
    }));
    const qi = queryInterfaceStub({
      rows: [baseRow({
        source_hmac_key: undefined,
        target_hmac_key: undefined,
        source_hmac_envelope: null,
        target_hmac_envelope: null,
      })],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_envelope: {}, target_hmac_envelope: {},
      },
      triggers,
    });
    delete qi.rows[0].source_hmac_key;
    delete qi.rows[0].target_hmac_key;
    await migration.up(qi, Sequelize);
    assert.equal(droppedColumns(qi).length, 0);
    assert.equal(
      qi.calls.filter(([kind, sql]) => kind === 'query' && /^DROP TRIGGER /u.test(sql)).length,
      FENCE_TRIGGERS.length
    );
  });
}

async function testAlterFailureKeepsFenceAndRerunCompletes() {
  await withTestEnv(async () => {
    const row = baseRow();
    const qi = queryInterfaceStub({
      rows: [row],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_key: {}, target_hmac_key: {},
      },
      failAlterCount: 1,
    });
    await assert.rejects(migration.up(qi, Sequelize), /simulated atomic ALTER failure/);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'source_hmac_key'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'target_hmac_key'), true);
    assert.equal(
      qi.calls.filter(([kind, sql]) => kind === 'query' && /^CREATE TRIGGER /u.test(sql)).length,
      FENCE_TRIGGERS.length
    );
    assert.equal(
      qi.calls.filter(([kind, sql]) => kind === 'query' && /^DROP TRIGGER /u.test(sql)).length,
      0,
      'si el DROP no queda confirmado, el fence debe permanecer fail-closed'
    );

    await migration.up(qi, Sequelize);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'source_hmac_key'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'target_hmac_key'), false);
    assert.equal(
      qi.calls.filter(([kind, sql]) => kind === 'query' && /^CREATE TRIGGER /u.test(sql)).length,
      FENCE_TRIGGERS.length,
      'el rerun reconoce sus triggers y no crea duplicados'
    );
    assert.equal(
      qi.calls.filter(([kind, sql]) => kind === 'query' && /^DROP TRIGGER /u.test(sql)).length,
      FENCE_TRIGGERS.length
    );
  });
}

async function testCanonicalFingerprintDetectsRowsetDriftDuringSequentialTriggerInstall() {
  await withTestEnv(async () => {
    let inserted = false;
    const row = baseRow();
    const qi = queryInterfaceStub({
      rows: [row],
      columns: {
        id: {}, scope_type: {}, scope_id: {}, generation: {},
        source_hmac_key: {}, target_hmac_key: {},
      },
      onTriggerCreated({ event, rows }) {
        if (!inserted && event === 'DELETE') {
          inserted = true;
          rows.push({ ...rows[0], id: '22222222-2222-4222-8222-222222222222' });
        }
      },
    });
    await assert.rejects(
      migration.up(qi, Sequelize),
      (error) => error.code === 'web_runtime_envelope_migration_fence_drift'
    );
    assert.equal(
      qi.calls.filter(([kind, sql]) => kind === 'query' && /^DROP TRIGGER /u.test(sql)).length,
      0
    );
  });
}

async function run() {
  const tests = [
    testMigratesBothLegacyColumnsWithoutPersistingPlaintext,
    testMigratesOnlyExistingLegacyColumnAndResumesAfterPartialRemoval,
    testMissingKeyOrTamperedEnvelopeNeverRemovesPlaintext,
    testRequiresQuiescenceAndDetectsDriftBeforeDrop,
    testCleansOwnedFenceAfterCrashEvenWithoutLegacyColumns,
    testAlterFailureKeepsFenceAndRerunCompletes,
    testCanonicalFingerprintDetectsRowsetDriftDuringSequentialTriggerInstall,
  ];
  for (const current of tests) {
    await current();
    console.log(`✓ ${current.name}`);
  }
  console.log(`\n${tests.length} web intake runtime envelope migration tests passed`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
