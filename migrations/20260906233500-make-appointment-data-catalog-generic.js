'use strict';

const CATALOG_NAME = 'envio_de_datos_de_la_cita_tras_agendar';
const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'ensure_appointment_data_catalog_generic_20260906_migration';

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return fallback;
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existingSnapshots = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE}
          WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existingSnapshots.length) return;

      const catalogs = await queryInterface.sequelize.query(
        `SELECT id, is_generic
           FROM AutomationFlowCatalog
          WHERE name = :catalogName
          LIMIT 1
          FOR UPDATE`,
        {
          replacements: { catalogName: CATALOG_NAME },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const catalog = catalogs[0];
      if (!catalog?.id) {
        throw new Error(`automation_catalog_missing:${CATALOG_NAME}`);
      }

      const disciplines = await queryInterface.sequelize.query(
        `SELECT disciplina_code
           FROM AutomationFlowCatalogDisciplines
          WHERE flow_catalog_id = :catalogId
          ORDER BY disciplina_code ASC
          FOR UPDATE`,
        {
          replacements: { catalogId: Number(catalog.id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const now = new Date();

      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          catalog_id: Number(catalog.id),
          is_generic: Number(catalog.is_generic) === 1,
          disciplines: disciplines.map((row) => String(row.disciplina_code || '').trim()).filter(Boolean),
        }),
        created_at: now,
        updated_at: now,
      }], { transaction });

      await queryInterface.bulkUpdate(
        'AutomationFlowCatalog',
        { is_generic: true, updated_at: now },
        { id: Number(catalog.id) },
        { transaction },
      );
      await queryInterface.bulkDelete(
        'AutomationFlowCatalogDisciplines',
        { flow_catalog_id: Number(catalog.id) },
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE}
          WHERE snapshot_key = :snapshotKey LIMIT 1
          FOR UPDATE`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(snapshots[0]?.payload, null);
      if (!snapshot?.catalog_id) return;

      const catalogId = Number(snapshot.catalog_id);
      const now = new Date();
      await queryInterface.bulkUpdate(
        'AutomationFlowCatalog',
        { is_generic: snapshot.is_generic === true, updated_at: now },
        { id: catalogId },
        { transaction },
      );
      await queryInterface.bulkDelete(
        'AutomationFlowCatalogDisciplines',
        { flow_catalog_id: catalogId },
        { transaction },
      );

      const disciplineRows = (snapshot.disciplines || []).map((code) => ({
        flow_catalog_id: catalogId,
        disciplina_code: String(code),
        created_at: now,
        updated_at: now,
      }));
      if (disciplineRows.length) {
        await queryInterface.bulkInsert(
          'AutomationFlowCatalogDisciplines',
          disciplineRows,
          { transaction },
        );
      }

      await queryInterface.bulkDelete(
        SNAPSHOT_TABLE,
        { snapshot_key: SNAPSHOT_KEY },
        { transaction },
      );
    });
  },
};
