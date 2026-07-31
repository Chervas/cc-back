'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const db = require('../../models');
const { QueryTypes } = require('sequelize');

const GROUP_ID = 5;
const IMPORT_REASON = 'Importación de pacientes para reactivación';
const DEFAULT_BACKUP_DIR = '/home/ubuntu/secure-imports/clinicaclick-cleanups';

function strictWhereSql(allImportedHistory = false) {
  return `
  ${allImportedHistory ? '' : 'c.inicio > NOW() AND'}
  c.estado = 'completada'
  AND c.titulo LIKE 'Histórico:%'
  AND c.motivo = :importReason
  AND cl.grupoClinicaId = :groupId
`;
}

function safeIdentifier(value) {
  const normalized = String(value || '');
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`unsafe_identifier:${normalized}`);
  }
  return `\`${normalized}\``;
}

async function findTargets(transaction = null, lock = false, allImportedHistory = false) {
  return db.sequelize.query(
    `
      SELECT c.*
      FROM CitasPacientes c
      INNER JOIN Clinicas cl ON cl.id_clinica = c.clinica_id
      WHERE ${strictWhereSql(allImportedHistory)}
      ORDER BY c.id_cita
      ${lock ? 'FOR UPDATE' : ''}
    `,
    {
      replacements: { importReason: IMPORT_REASON, groupId: GROUP_ID },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
}

async function findDependencies(ids, transaction = null) {
  if (!ids.length) return [];
  const references = await db.sequelize.query(
    `
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME = 'CitasPacientes'
        AND REFERENCED_COLUMN_NAME = 'id_cita'
      ORDER BY TABLE_NAME, COLUMN_NAME
    `,
    { type: QueryTypes.SELECT, transaction },
  );

  const dependencies = [];
  for (const reference of references) {
    const table = safeIdentifier(reference.table_name);
    const column = safeIdentifier(reference.column_name);
    const [row] = await db.sequelize.query(
      `SELECT COUNT(*) AS total FROM ${table} WHERE ${column} IN (:ids)`,
      { replacements: { ids }, type: QueryTypes.SELECT, transaction },
    );
    const total = Number(row?.total || 0);
    if (total > 0) {
      dependencies.push({
        table: reference.table_name,
        column: reference.column_name,
        total,
      });
    }
  }
  return dependencies;
}

function ensureBackupDirectory() {
  const directory = process.env.CLINICACLICK_CLEANUP_BACKUP_DIR || DEFAULT_BACKUP_DIR;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writeBackup(rows, allImportedHistory = false) {
  const directory = ensureBackupDirectory();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scope = allImportedHistory ? 'all-imported-history' : 'future-historical-appointments';
  const filePath = path.join(directory, `propdental-${scope}-${stamp}.json`);
  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    group_id: GROUP_ID,
    import_reason: IMPORT_REASON,
    cleanup_scope: allImportedHistory ? 'all_imported_history' : 'future_only',
    row_count: rows.length,
    rows,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function validateBackupRow(row) {
  return Number.isInteger(Number(row?.id_cita))
    && Number.isInteger(Number(row?.clinica_id))
    && String(row?.estado || '') === 'completada'
    && String(row?.titulo || '').startsWith('Histórico:')
    && String(row?.motivo || '') === IMPORT_REASON;
}

async function restoreBackup(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!rows.length || !rows.every(validateBackupRow)) {
    throw new Error('invalid_cleanup_backup');
  }

  await db.sequelize.transaction(async (transaction) => {
    const ids = rows.map((row) => Number(row.id_cita));
    const existing = await db.CitaPaciente.count({ where: { id_cita: ids }, transaction });
    if (existing > 0) {
      throw new Error(`restore_conflict:${existing}`);
    }
    await db.CitaPaciente.bulkCreate(rows, { transaction, validate: true });
  });
  console.log(JSON.stringify({ restored: rows.length, backup: filePath }, null, 2));
}

async function applyCleanup(allImportedHistory = false) {
  let backupPath = null;
  await db.sequelize.transaction(async (transaction) => {
    const rows = await findTargets(transaction, true, allImportedHistory);
    const ids = rows.map((row) => Number(row.id_cita));
    const dependencies = await findDependencies(ids, transaction);
    if (dependencies.length) {
      const error = new Error('cleanup_dependencies_found');
      error.dependencies = dependencies;
      throw error;
    }
    if (!rows.length) return;

    backupPath = writeBackup(rows, allImportedHistory);
    const affectedRows = await db.CitaPaciente.destroy({
      where: { id_cita: ids },
      transaction,
      hooks: false,
    });
    if (affectedRows !== rows.length) {
      throw new Error(`cleanup_count_mismatch:${affectedRows}:${rows.length}`);
    }
  });

  const remaining = await findTargets(null, false, allImportedHistory);
  console.log(JSON.stringify({
    deleted: backupPath ? 'applied' : 'nothing_to_delete',
    scope: allImportedHistory ? 'all_imported_history' : 'future_only',
    remaining: remaining.length,
    backup: backupPath,
  }, null, 2));
}

async function dryRun(allImportedHistory = false) {
  const rows = await findTargets(null, false, allImportedHistory);
  const dependencies = await findDependencies(rows.map((row) => Number(row.id_cita)));
  const byClinic = rows.reduce((acc, row) => {
    const key = String(row.clinica_id);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({
    mode: 'dry-run',
    scope: allImportedHistory ? 'all_imported_history' : 'future_only',
    candidates: rows.length,
    by_clinic: byClinic,
    dependencies,
  }, null, 2));
}

async function main() {
  const allImportedHistory = process.argv.includes('--all-imported-history');
  const restoreArg = process.argv.find((arg) => arg.startsWith('--restore='));
  if (restoreArg) {
    await restoreBackup(restoreArg.slice('--restore='.length));
    return;
  }
  if (process.argv.includes('--apply')) {
    await applyCleanup(allImportedHistory);
    return;
  }
  await dryRun(allImportedHistory);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      error: error.message,
      dependencies: error.dependencies || undefined,
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
