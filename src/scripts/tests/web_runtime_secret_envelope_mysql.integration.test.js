'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Sequelize = require('sequelize');

const {
  decryptRuntimeSecret,
} = require('../../lib/webRuntimeSecretEnvelope');
const {
  FENCE_MESSAGE,
  FENCE_TRIGGERS,
  migrateWebIntakeRuntimePlaintextSecrets,
} = require('../../lib/webRuntimeSecretMigration');

const SOURCE_SECRET = 'mysql-source-hmac-0123456789abcdef';
const TARGET_SECRET = 'mysql-target-hmac-fedcba9876543210';
const ROW_ID = '11111111-1111-4111-8111-111111111111';

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function sourceConnection(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (cause) {
    const error = new Error('WEB_EDITOR_TEST_MYSQL_URL debe ser una URL MySQL valida');
    error.cause = cause;
    throw error;
  }
  if (!['mysql:', 'mysql2:'].includes(parsed.protocol)) {
    throw new Error('WEB_EDITOR_TEST_MYSQL_URL debe usar el protocolo mysql');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, '')).trim();
  if (!database || /(?:^|_)(?:prod|production)(?:_|$)/iu.test(database)) {
    throw new Error('La integracion MySQL rechaza una conexion de produccion');
  }
  return { parsed, database };
}

function context(slot) {
  return {
    id: ROW_ID,
    scopeType: 'clinic',
    scopeId: 55,
    generation: 2,
    slot,
  };
}

async function triggerRows(sequelize) {
  const [rows] = await sequelize.query(
    `SELECT TRIGGER_NAME AS trigger_name, EVENT_MANIPULATION AS event_manipulation,
            ACTION_TIMING AS action_timing, ACTION_STATEMENT AS action_statement
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME IN (:trigger_names)`,
    { replacements: { trigger_names: FENCE_TRIGGERS.map(({ name }) => name) } }
  );
  return rows;
}

async function assertFenceRejectsEveryMutation(sequelize, table) {
  const tableSql = quoteIdentifier(table);
  const expected = new RegExp(FENCE_MESSAGE, 'u');
  await assert.rejects(
    () => sequelize.query(
      `INSERT INTO ${tableSql}
        (id, scope_type, scope_id, generation, source_hmac_key, target_hmac_key)
       VALUES ('22222222-2222-4222-8222-222222222222', 'clinic', 56, 1, :source, :target)`,
      { replacements: { source: SOURCE_SECRET, target: TARGET_SECRET } }
    ),
    expected
  );
  await assert.rejects(
    () => sequelize.query(
      `UPDATE ${tableSql} SET generation = 3 WHERE id = :id`,
      { replacements: { id: ROW_ID } }
    ),
    expected
  );
  await assert.rejects(
    () => sequelize.query(
      `DELETE FROM ${tableSql} WHERE id = :id`,
      { replacements: { id: ROW_ID } }
    ),
    expected
  );
}

async function main() {
  const sourceUrl = String(process.env.WEB_EDITOR_TEST_MYSQL_URL || '').trim();
  if (!sourceUrl) {
    console.log('web runtime secret envelope mysql integration: SKIP (WEB_EDITOR_TEST_MYSQL_URL no configurada)');
    return;
  }

  const source = sourceConnection(sourceUrl);
  const useExistingDatabase = String(
    process.env.WEB_RUNTIME_TEST_MYSQL_USE_EXISTING_DATABASE || ''
  ).trim().toLowerCase() === 'true';
  const database = useExistingDatabase
    ? source.database
    : `clinicaclick_runtime_envelope_${process.pid}_${Date.now()}_test`;
  const suffix = `${process.pid}_${Date.now()}`;
  const runtimeTable = `cc_runtime_envelope_${suffix}`;
  const intakeTable = `cc_intake_config_${suffix}`;
  const runtimeTableSql = quoteIdentifier(runtimeTable);
  const intakeTableSql = quoteIdentifier(intakeTable);
  const envelopeKey = crypto.randomBytes(32).toString('base64url');
  const envNames = [
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY',
    'MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID',
    'MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED',
  ];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY = envelopeKey;
  process.env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID = 'mysql-envelope-contract-v1';
  process.env.MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED = 'true';

  const admin = useExistingDatabase ? null : new Sequelize.Sequelize(sourceUrl, {
    logging: false,
    pool: { max: 1, min: 0 },
  });
  let isolated = null;
  let writer = null;
  let writerTransaction = null;
  try {
    if (admin) {
      await admin.authenticate();
      await admin.query(
        `CREATE DATABASE ${quoteIdentifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    }
    source.parsed.pathname = `/${database}`;
    isolated = new Sequelize.Sequelize(source.parsed.toString(), {
      logging: false,
      pool: { max: 3, min: 0 },
    });
    writer = new Sequelize.Sequelize(source.parsed.toString(), {
      logging: false,
      pool: { max: 1, min: 0 },
    });
    await isolated.authenticate();
    await writer.authenticate();
    if ((await triggerRows(isolated)).length) {
      throw new Error('El preflight no se ejecuta mientras exista otro fence de runtime');
    }
    await isolated.query(`DROP TABLE IF EXISTS ${runtimeTableSql}`);
    await isolated.query(`DROP TABLE IF EXISTS ${intakeTableSql}`);
    await isolated.query(`CREATE TABLE ${intakeTableSql} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`);
    await isolated.query(`
      CREATE TABLE ${runtimeTableSql} (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        scope_type ENUM('clinic', 'group') NOT NULL,
        scope_id INT NOT NULL,
        generation INT UNSIGNED NOT NULL,
        source_hmac_key TEXT NULL,
        target_hmac_key TEXT NULL,
        source_hmac_envelope TEXT NULL,
        target_hmac_envelope TEXT NULL,
        source_guard CHAR(64) GENERATED ALWAYS AS (SHA2(source_hmac_key, 256)) STORED
      ) ENGINE=InnoDB
    `);
    await isolated.query(`
      INSERT INTO ${runtimeTableSql}
        (id, scope_type, scope_id, generation, source_hmac_key, target_hmac_key)
      VALUES (:id, 'clinic', 55, 2, :source, :target)
    `, { replacements: { id: ROW_ID, source: SOURCE_SECRET, target: TARGET_SECRET } });

    const queryInterface = isolated.getQueryInterface();
    let description = await queryInterface.describeTable(runtimeTable);
    writerTransaction = await writer.transaction();
    await writer.query(
      `UPDATE ${runtimeTableSql} SET generation = generation WHERE id = :id`,
      { replacements: { id: ROW_ID }, transaction: writerTransaction }
    );
    let migrationSettled = false;
    const blockedMigration = migrateWebIntakeRuntimePlaintextSecrets(
      queryInterface,
      description,
      {
        table: runtimeTable,
        intakeTable,
      }
    ).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    ).finally(() => {
      migrationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      migrationSettled,
      false,
      'LOCK TABLES debe esperar a un writer que ya tocó la tabla'
    );
    await writerTransaction.rollback();
    writerTransaction = null;
    const blockedOutcome = await blockedMigration;
    assert.equal(blockedOutcome.ok, false);
    assert.match(
      String(blockedOutcome.error?.message || blockedOutcome.error),
      /generated column|dependent|source_guard|cannot drop/iu
    );

    const afterFailure = await queryInterface.describeTable(runtimeTable);
    assert.ok(afterFailure.source_hmac_key);
    assert.ok(afterFailure.target_hmac_key);
    assert.ok(afterFailure.source_hmac_envelope);
    assert.ok(afterFailure.target_hmac_envelope);
    const installed = await triggerRows(isolated);
    assert.equal(installed.length, FENCE_TRIGGERS.length);
    assert.deepEqual(
      installed.map(({ trigger_name }) => trigger_name).sort(),
      FENCE_TRIGGERS.map(({ name }) => name).sort()
    );
    assert.ok(installed.every(({ action_timing }) => action_timing === 'BEFORE'));
    assert.ok(installed.every(({ action_statement }) => action_statement.includes(FENCE_MESSAGE)));
    await assertFenceRejectsEveryMutation(isolated, runtimeTable);

    await isolated.query(`ALTER TABLE ${runtimeTableSql} DROP COLUMN source_guard`);
    description = await queryInterface.describeTable(runtimeTable);
    await migrateWebIntakeRuntimePlaintextSecrets(queryInterface, description, {
      table: runtimeTable,
      intakeTable,
    });

    const afterRecovery = await queryInterface.describeTable(runtimeTable);
    assert.equal(Boolean(afterRecovery.source_hmac_key), false);
    assert.equal(Boolean(afterRecovery.target_hmac_key), false);
    assert.ok(afterRecovery.source_hmac_envelope);
    assert.ok(afterRecovery.target_hmac_envelope);
    assert.equal((await triggerRows(isolated)).length, 0);

    const [[row]] = await isolated.query(`
      SELECT id, scope_type, scope_id, generation,
             source_hmac_envelope, target_hmac_envelope
        FROM ${runtimeTableSql}
       WHERE id = :id
    `, { replacements: { id: ROW_ID } });
    assert.equal(
      decryptRuntimeSecret(row.source_hmac_envelope, context('source')),
      SOURCE_SECRET
    );
    assert.equal(
      decryptRuntimeSecret(row.target_hmac_envelope, context('target')),
      TARGET_SECRET
    );
    console.log('web runtime secret envelope mysql integration: ok');
  } finally {
    const cleanupErrors = [];
    if (writerTransaction) {
      await writerTransaction.rollback().catch((error) => cleanupErrors.push(error));
      writerTransaction = null;
    }
    if (writer) {
      await writer.close().catch((error) => cleanupErrors.push(error));
      writer = null;
    }
    if (isolated) {
      await isolated.query(`DROP TABLE IF EXISTS ${runtimeTableSql}`)
        .catch((error) => cleanupErrors.push(error));
      await isolated.query(`DROP TABLE IF EXISTS ${intakeTableSql}`)
        .catch((error) => cleanupErrors.push(error));
      await isolated.close().catch((error) => cleanupErrors.push(error));
      isolated = null;
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
        .catch((error) => cleanupErrors.push(error));
      await admin.close().catch((error) => cleanupErrors.push(error));
    }
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'web runtime envelope mysql scratch cleanup failed');
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
