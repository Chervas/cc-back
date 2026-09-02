'use strict';

const { Op } = require('sequelize');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const CLEANUP_PREFIX = 'inactive_automation_catalog_v1';
const TARGET_CATALOG_NAMES = [
  'auto_recordatorio_cita',
  'auto_reactivar_paciente',
  'auto_recordatorio_ortodoncia',
  'qa_reactivation_patient_followup',
];

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

async function saveSnapshot(queryInterface, key, payload, now, transaction) {
  const existing = await queryInterface.sequelize.query(
    `SELECT id FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :key LIMIT 1 FOR UPDATE`,
    {
      replacements: { key },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  if (existing[0]) return;
  await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
    snapshot_key: key,
    payload: JSON.stringify(payload),
    created_at: now,
    updated_at: now,
  }], { transaction });
}

async function loadSnapshot(queryInterface, key, transaction) {
  const rows = await queryInterface.sequelize.query(
    `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :key LIMIT 1`,
    {
      replacements: { key },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  return parseJson(rows[0]?.payload, []);
}

async function assertIdsAvailable(queryInterface, table, ids, transaction) {
  const normalizedIds = (Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter(Number.isInteger);
  if (!normalizedIds.length) return;
  const rows = await queryInterface.sequelize.query(
    `SELECT id FROM ${table} WHERE id IN (:ids) LIMIT 1`,
    {
      replacements: { ids: normalizedIds },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  if (rows.length) throw new Error(`inactive_automation_catalog_restore_id_conflict:${table}:${rows[0].id}`);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.describeTable(SNAPSHOT_TABLE);
    await queryInterface.sequelize.transaction(async (transaction) => {
      const now = new Date();
      const catalogRows = await queryInterface.sequelize.query(
        `
          SELECT *
          FROM AutomationFlowCatalog
          WHERE name IN (:names)
          FOR UPDATE
        `,
        {
          replacements: { names: TARGET_CATALOG_NAMES },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const active = catalogRows.find((row) => Number(row.is_active) !== 0);
      if (active) throw new Error(`inactive_automation_catalog_is_active:${active.name}`);

      const catalogIds = catalogRows.map((row) => Number(row.id)).filter(Number.isInteger);
      let flowRows = [];
      let disciplineRows = [];
      if (catalogIds.length) {
        flowRows = await queryInterface.sequelize.query(
          'SELECT * FROM AutomationFlows WHERE catalog_flow_id IN (:catalogIds) FOR UPDATE',
          {
            replacements: { catalogIds },
            type: queryInterface.sequelize.QueryTypes.SELECT,
            transaction,
          },
        );
        disciplineRows = await queryInterface.sequelize.query(
          'SELECT * FROM AutomationFlowCatalogDisciplines WHERE flow_catalog_id IN (:catalogIds) FOR UPDATE',
          {
            replacements: { catalogIds },
            type: queryInterface.sequelize.QueryTypes.SELECT,
            transaction,
          },
        );
      }

      const unsafeFlow = flowRows.find((row) => row.estado !== 'borrador' || Number(row.activo) !== 0);
      if (unsafeFlow) throw new Error(`inactive_automation_flow_is_in_use:${unsafeFlow.id}`);
      const flowIds = flowRows.map((row) => Number(row.id)).filter(Number.isInteger);
      if (flowIds.length) {
        const references = await queryInterface.sequelize.query(
          `
            SELECT
              (SELECT COUNT(*) FROM MessageLogs WHERE flow_id IN (:flowIds)) AS message_logs,
              (SELECT COUNT(*) FROM LeadFlowInstances WHERE flow_id IN (:flowIds)) AS lead_instances
          `,
          {
            replacements: { flowIds },
            type: queryInterface.sequelize.QueryTypes.SELECT,
            transaction,
          },
        );
        if (Number(references[0]?.message_logs) || Number(references[0]?.lead_instances)) {
          throw new Error('inactive_automation_flow_has_runtime_history');
        }
      }

      await saveSnapshot(queryInterface, `${CLEANUP_PREFIX}:catalog`, catalogRows, now, transaction);
      await saveSnapshot(queryInterface, `${CLEANUP_PREFIX}:disciplines`, disciplineRows, now, transaction);
      await saveSnapshot(queryInterface, `${CLEANUP_PREFIX}:flows`, flowRows, now, transaction);

      if (catalogIds.length) {
        await queryInterface.bulkDelete(
          'AutomationFlowCatalogDisciplines',
          { flow_catalog_id: { [Op.in]: catalogIds } },
          { transaction },
        );
        await queryInterface.bulkDelete(
          'AutomationFlows',
          { catalog_flow_id: { [Op.in]: catalogIds } },
          { transaction },
        );
        await queryInterface.bulkDelete(
          'AutomationFlowCatalog',
          { id: { [Op.in]: catalogIds } },
          { transaction },
        );
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const catalogRows = await loadSnapshot(queryInterface, `${CLEANUP_PREFIX}:catalog`, transaction);
      const disciplineRows = await loadSnapshot(queryInterface, `${CLEANUP_PREFIX}:disciplines`, transaction);
      const flowRows = await loadSnapshot(queryInterface, `${CLEANUP_PREFIX}:flows`, transaction);

      await assertIdsAvailable(queryInterface, 'AutomationFlowCatalog', catalogRows.map((row) => row.id), transaction);
      await assertIdsAvailable(queryInterface, 'AutomationFlowCatalogDisciplines', disciplineRows.map((row) => row.id), transaction);
      await assertIdsAvailable(queryInterface, 'AutomationFlows', flowRows.map((row) => row.id), transaction);

      if (catalogRows.length) await queryInterface.bulkInsert('AutomationFlowCatalog', catalogRows, { transaction });
      if (disciplineRows.length) {
        await queryInterface.bulkInsert('AutomationFlowCatalogDisciplines', disciplineRows, { transaction });
      }
      if (flowRows.length) await queryInterface.bulkInsert('AutomationFlows', flowRows, { transaction });

      await queryInterface.bulkDelete(
        SNAPSHOT_TABLE,
        { snapshot_key: { [Op.in]: [
          `${CLEANUP_PREFIX}:catalog`,
          `${CLEANUP_PREFIX}:disciplines`,
          `${CLEANUP_PREFIX}:flows`,
        ] } },
        { transaction },
      );
    });
  },

  __test: {
    CLEANUP_PREFIX,
    SNAPSHOT_TABLE,
    TARGET_CATALOG_NAMES,
  },
};
