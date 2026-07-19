'use strict';

const crypto = require('node:crypto');

const {
  WebRuntimeSecretEnvelopeError,
  decryptRuntimeSecret,
  encryptRuntimeSecret,
} = require('./webRuntimeSecretEnvelope');

const DEFAULT_TABLE = 'WebIntakeRuntimeReconciliations';
const QUIESCENCE_ENV = 'MARKETING_WEB_RUNTIME_SECRET_MIGRATION_QUIESCED';
const FENCE_MESSAGE = 'clinicaclick_web_runtime_secret_migration_fenced';
const FENCE_TRIGGERS = Object.freeze([
  { name: 'cc_web_runtime_secret_fence_bd', event: 'DELETE' },
  { name: 'cc_web_runtime_secret_fence_bi', event: 'INSERT' },
  { name: 'cc_web_runtime_secret_fence_bu', event: 'UPDATE' },
]);
const SLOT_COLUMNS = Object.freeze({
  source: {
    plaintext: 'source_hmac_key',
    envelope: 'source_hmac_envelope',
  },
  target: {
    plaintext: 'target_hmac_key',
    envelope: 'target_hmac_envelope',
  },
});

function quoteTable(queryInterface, table) {
  return queryInterface.queryGenerator?.quoteTable
    ? queryInterface.queryGenerator.quoteTable(table)
    : `\`${table}\``;
}

function quoteIdentifier(queryInterface, identifier) {
  return queryInterface.queryGenerator?.quoteIdentifier
    ? queryInterface.queryGenerator.quoteIdentifier(identifier)
    : `\`${identifier}\``;
}

function triggerValue(row, key) {
  return row?.[key] ?? row?.[key.toLowerCase()] ?? null;
}

function ownedFenceTrigger(row, expected, table) {
  const action = String(triggerValue(row, 'ACTION_STATEMENT') || '')
    .replace(/\s+/gu, ' ').trim().toLowerCase();
  return String(triggerValue(row, 'TRIGGER_NAME') || '') === expected.name
    && String(triggerValue(row, 'EVENT_MANIPULATION') || '').toUpperCase() === expected.event
    && String(triggerValue(row, 'ACTION_TIMING') || '').toUpperCase() === 'BEFORE'
    && String(triggerValue(row, 'EVENT_OBJECT_TABLE') || '') === String(table)
    && action.includes("signal sqlstate '45000'")
    && action.includes(FENCE_MESSAGE);
}

async function readFenceTriggers(queryInterface, transaction = null) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING, ACTION_STATEMENT, EVENT_OBJECT_TABLE
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME IN (:trigger_names)`,
    {
      replacements: { trigger_names: FENCE_TRIGGERS.map(({ name }) => name) },
      ...(transaction ? { transaction } : {}),
    }
  );
  return rows || [];
}

function assertOwnedFenceTriggers(rows, table) {
  const byName = new Map(rows.map((row) => [String(triggerValue(row, 'TRIGGER_NAME') || ''), row]));
  for (const expected of FENCE_TRIGGERS) {
    const row = byName.get(expected.name);
    if (row && !ownedFenceTrigger(row, expected, table)) {
      throw new WebRuntimeSecretEnvelopeError(
        'web_runtime_envelope_migration_fence_conflict',
        `El trigger ${expected.name} existe pero no pertenece al fence esperado.`
      );
    }
  }
  return byName;
}

async function installFenceTriggers(queryInterface, table, fence) {
  let byName = assertOwnedFenceTriggers(
    await readFenceTriggers(queryInterface, fence.transaction),
    table
  );
  for (const expected of FENCE_TRIGGERS) {
    if (byName.has(expected.name)) continue;
    await fence.lock();
    await queryInterface.sequelize.query(
      `CREATE TRIGGER ${quoteIdentifier(queryInterface, expected.name)} BEFORE ${expected.event}
         ON ${quoteTable(queryInterface, table)} FOR EACH ROW
         SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${FENCE_MESSAGE}'`,
      { transaction: fence.transaction }
    );
    await fence.markImplicitUnlock();
    byName = assertOwnedFenceTriggers(
      await readFenceTriggers(queryInterface, fence.transaction),
      table
    );
  }
  if (byName.size !== FENCE_TRIGGERS.length) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_migration_fence_incomplete',
      'No se han podido instalar todos los triggers del fence de migración.'
    );
  }
}

async function removeFenceTriggers(queryInterface, table, transaction = null) {
  const rows = await readFenceTriggers(queryInterface, transaction);
  const byName = assertOwnedFenceTriggers(rows, table);
  for (const expected of FENCE_TRIGGERS) {
    if (!byName.has(expected.name)) continue;
    await queryInterface.sequelize.query(
      `DROP TRIGGER ${quoteIdentifier(queryInterface, expected.name)}`,
      transaction ? { transaction } : undefined
    );
  }
  return byName.size;
}

function migrationMismatch() {
  return new WebRuntimeSecretEnvelopeError(
    'web_runtime_envelope_migration_mismatch',
    'La migración detectó un envelope incompatible con el secreto heredado.'
  );
}

function migrationNotQuiesced() {
  return new WebRuntimeSecretEnvelopeError(
    'web_runtime_envelope_migration_not_quiesced',
    `La migración irreversible requiere ${QUIESCENCE_ENV}=true y los writers de IntakeConfig/reconciliación detenidos.`
  );
}

function selectColumns(description) {
  return [
    'id',
    'scope_type',
    'scope_id',
    'generation',
    ...Object.values(SLOT_COLUMNS).flatMap((columns) => [
      description[columns.plaintext]
        ? columns.plaintext
        : `NULL AS ${columns.plaintext}`,
      description[columns.envelope]
        ? columns.envelope
        : `NULL AS ${columns.envelope}`,
    ]),
  ];
}

async function readRows(queryInterface, tableSql, description, transaction = null) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT ${selectColumns(description).join(', ')} FROM ${tableSql}`,
    transaction ? { transaction } : undefined
  );
  return rows || [];
}

async function acquireWriterFence(
  queryInterface,
  tableSql,
  intakeTable = 'IntakeConfigs'
) {
  const sequelize = queryInterface.sequelize;
  const manager = sequelize?.connectionManager;
  if (!manager?.getConnection || !manager?.releaseConnection) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_migration_fence_unavailable',
      'No se puede adquirir una conexión dedicada para bloquear writers durante la migración.'
    );
  }
  const connection = await manager.getConnection({ type: 'WRITE', useMaster: true });
  const transaction = { connection };
  let locked = false;
  const lock = async () => {
    if (locked) return;
    // MySQL waits until every transaction that was already touching either
    // table has ended. Once this returns, old and new binaries are fenced even
    // if they know nothing about this migration.
    await sequelize.query(
      `LOCK TABLES ${tableSql} WRITE, ${quoteTable(queryInterface, intakeTable)} READ`,
      { transaction }
    );
    locked = true;
  };
  const unlock = async () => {
    if (!locked) return;
    try {
      await sequelize.query('UNLOCK TABLES', { transaction });
    } finally {
      locked = false;
    }
  };
  await lock();
  return {
    transaction,
    lock,
    // MySQL's DDL/LOCK TABLES interaction varies by statement and connection
    // state. UNLOCK TABLES is harmless when the DDL already released the lock,
    // and mandatory when it did not. Never return a connection to Sequelize's
    // pool with an intake READ lock still attached to the session.
    async markImplicitUnlock() {
      try {
        await sequelize.query('UNLOCK TABLES', { transaction });
      } finally {
        locked = false;
      }
    },
    unlock,
    async release() {
      try {
        await unlock();
      } finally {
        await manager.releaseConnection(connection);
      }
    },
  };
}

function secretContext(row, slot) {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    generation: row.generation,
    slot,
  };
}

function validateRows(rows, legacySlots, { env }) {
  for (const row of rows) {
    for (const slot of legacySlots) {
      const columns = SLOT_COLUMNS[slot];
      const plaintext = row[columns.plaintext];
      const envelope = row[columns.envelope];
      if (envelope) {
        // Authenticate every envelope, including rows whose legacy plaintext
        // is NULL/empty after a partial migration.
        const decrypted = decryptRuntimeSecret(envelope, secretContext(row, slot), { env });
        if (plaintext !== null && plaintext !== undefined && plaintext !== ''
          && decrypted !== String(plaintext)) {
          throw migrationMismatch();
        }
      } else if (plaintext !== null && plaintext !== undefined && plaintext !== '') {
        throw migrationMismatch();
      }
    }
  }
}

function rowsFingerprint(rows) {
  const normalized = (rows || []).map((row) => ({
    id: String(row.id || ''),
    scope_type: String(row.scope_type || ''),
    scope_id: row.scope_id === null || row.scope_id === undefined ? null : Number(row.scope_id),
    generation: row.generation === null || row.generation === undefined ? null : Number(row.generation),
    source_hmac_key: row.source_hmac_key ?? null,
    source_hmac_envelope: row.source_hmac_envelope ?? null,
    target_hmac_key: row.target_hmac_key ?? null,
    target_hmac_envelope: row.target_hmac_envelope ?? null,
  })).sort((left, right) => (
    left.id.localeCompare(right.id)
    || String(left.scope_type).localeCompare(String(right.scope_type))
    || Number(left.scope_id || 0) - Number(right.scope_id || 0)
    || Number(left.generation || 0) - Number(right.generation || 0)
  ));
  return crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

async function migrateWebIntakeRuntimePlaintextSecrets(
  queryInterface,
  description,
  { table = DEFAULT_TABLE, intakeTable = 'IntakeConfigs', env = process.env } = {}
) {
  const legacySlots = Object.entries(SLOT_COLUMNS)
    .filter(([, columns]) => description[columns.plaintext])
    .map(([slot]) => slot);
  const envelopeSlots = Object.entries(SLOT_COLUMNS)
    .filter(([, columns]) => description[columns.envelope])
    .map(([slot]) => slot);
  const existingFenceRows = await readFenceTriggers(queryInterface);
  assertOwnedFenceTriggers(existingFenceRows, table);
  if (!legacySlots.length && !existingFenceRows.length) return { migrated: 0, removed: [] };

  // This assertion is deliberately operational and explicit. The migration
  // runner must first stop web/API workers that can write either legacy field;
  // CAS plus the final reread below detect accidental drift, but cannot make a
  // DROP COLUMN safe while an old binary is still writing plaintext.
  if (String(env[QUIESCENCE_ENV] || '').trim().toLowerCase() !== 'true') {
    throw migrationNotQuiesced();
  }

  const tableSql = quoteTable(queryInterface, table);
  const fence = await acquireWriterFence(queryInterface, tableSql, intakeTable);
  let migrated = 0;
  const removed = [];
  let operationError = null;
  try {
    if (!legacySlots.length) {
      // Recovery after a process crash between atomic DROP and trigger cleanup.
      return { migrated: 0, removed: [] };
    }
    const rows = await readRows(queryInterface, tableSql, description, fence.transaction);
    for (const row of rows || []) {
      const updates = {};
      for (const slot of legacySlots) {
        const columns = SLOT_COLUMNS[slot];
        const plaintext = row[columns.plaintext];
        const existingEnvelope = row[columns.envelope];
        if (existingEnvelope) {
          const decrypted = decryptRuntimeSecret(
            existingEnvelope,
            secretContext(row, slot),
            { env }
          );
          if (plaintext !== null && plaintext !== undefined && plaintext !== ''
            && decrypted !== String(plaintext)) {
            throw migrationMismatch();
          }
        }
        if (plaintext === null || plaintext === undefined || plaintext === '') {
          continue;
        }
        if (existingEnvelope) continue;
        updates[columns.envelope] = encryptRuntimeSecret(
          plaintext,
          secretContext(row, slot),
          { env }
        );
      }
      const entries = Object.entries(updates);
      if (entries.length) {
        const replacements = { id: row.id };
        const predicates = [];
        const assignments = entries.map(([column, value], index) => {
          const replacement = `value_${index}`;
          replacements[replacement] = value;
          const slot = Object.keys(SLOT_COLUMNS).find((name) => SLOT_COLUMNS[name].envelope === column);
          const plaintextColumn = SLOT_COLUMNS[slot].plaintext;
          const plaintext = String(row[plaintextColumn]);
          replacements[`digest_${index}`] = crypto
            .createHash('sha256').update(plaintext, 'utf8').digest('hex');
          replacements[`length_${index}`] = Buffer.byteLength(plaintext, 'utf8');
          predicates.push(
            `${column} IS NULL`,
            `SHA2(CAST(${plaintextColumn} AS BINARY), 256) = :digest_${index}`,
            `OCTET_LENGTH(${plaintextColumn}) = :length_${index}`
          );
          return `${column} = :${replacement}`;
        });
        await queryInterface.sequelize.query(
          `UPDATE ${tableSql} SET ${assignments.join(', ')} WHERE id = :id AND ${predicates.join(' AND ')}`,
          { replacements, transaction: fence.transaction }
        );
        migrated += 1;
      }
    }

    // Re-read while the DB-level table lock is held. This authenticates every
    // envelope and catches a failed CAS before any irreversible DDL.
    const beforeTriggerRows = await readRows(
      queryInterface, tableSql, description, fence.transaction
    );
    validateRows(
      beforeTriggerRows,
      [...new Set([...legacySlots, ...envelopeSlots])],
      { env }
    );
    const beforeTriggerFingerprint = rowsFingerprint(beforeTriggerRows);

    // DELETE -> INSERT -> UPDATE minimizes row-set exposure while installing.
    // Triggers do not reference legacy columns, survive ALTER's implicit
    // commit, and fail closed for every DML connection.
    await installFenceTriggers(queryInterface, table, fence);
    const afterTriggerRows = await readRows(
      queryInterface, tableSql, description, fence.transaction
    );
    if (rowsFingerprint(afterTriggerRows) !== beforeTriggerFingerprint) {
      throw new WebRuntimeSecretEnvelopeError(
        'web_runtime_envelope_migration_fence_drift',
        'El conjunto de reconciliaciones cambió durante la instalación del fence.'
      );
    }
    validateRows(
      afterTriggerRows,
      [...new Set([...legacySlots, ...envelopeSlots])],
      { env }
    );

    // MySQL releases LOCK TABLES for ALTER TABLE. The three persistent triggers
    // now fence every DML writer while ALTER's exclusive metadata lock performs
    // one atomic schema change. There is no unlock window between slots.
    const columns = legacySlots.map((slot) => SLOT_COLUMNS[slot].plaintext);
    await queryInterface.sequelize.query(
      `ALTER TABLE ${tableSql} ${columns.map((column) => (
        `DROP COLUMN ${quoteIdentifier(queryInterface, column)}`
      )).join(', ')}`,
      { transaction: fence.transaction }
    );
    await fence.markImplicitUnlock();
    removed.push(...columns);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let finalizationError = null;
    try {
      await fence.release();
    } catch (releaseError) {
      finalizationError = releaseError;
    }
    if (!finalizationError) {
      try {
        const finalDescription = await queryInterface.describeTable(table);
        const legacyAbsent = Object.values(SLOT_COLUMNS)
          .every(({ plaintext }) => !finalDescription?.[plaintext]);
        if (legacyAbsent) await removeFenceTriggers(queryInterface, table);
      } catch (cleanupError) {
        finalizationError = cleanupError;
      }
    }
    if (finalizationError) {
      if (!operationError) throw finalizationError;
      operationError.fence_cleanup_error = finalizationError;
    }
  }
  return { migrated, removed };
}

module.exports = {
  DEFAULT_TABLE,
  FENCE_MESSAGE,
  FENCE_TRIGGERS,
  QUIESCENCE_ENV,
  SLOT_COLUMNS,
  migrateWebIntakeRuntimePlaintextSecrets,
};
