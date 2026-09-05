'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'appointment_data_after_booking_review_v15';
const TARGET_PUBLIC_ID = 'flw_fc01d1d9647df069';
const SOURCE_VERSION = 10;
const REVIEW_VERSION = 15;

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function validateSource(source) {
  if (
    !source
    || source.public_id !== TARGET_PUBLIC_ID
    || Number(source.version) !== SOURCE_VERSION
    || source.template_key !== 'env_o_de_datos_de_la_cita_tras_agendar'
    || source.trigger_type !== 'appointment_created'
  ) {
    throw new Error('appointment_data_after_booking_source_mismatch');
  }

  const nodes = parseJson(source.nodes, []);
  if (nodes.length !== 41) {
    throw new Error('appointment_data_after_booking_source_node_count_mismatch');
  }
  const byId = new Map(nodes.map((node) => [node?.id, node]));
  if (
    byId.get('N2')?.type !== 'condition/field_check'
    || byId.get('N2')?.outputs?.branch_1 !== 'N3'
    || byId.get('N2')?.outputs?.branch_2 !== 'N4'
    || byId.get('N2')?.outputs?.branch_3 !== 'N5'
  ) {
    throw new Error('appointment_data_after_booking_source_n2_mismatch');
  }
  for (const nodeId of ['N18', 'N14', 'N28', 'N24', 'N40', 'N35']) {
    if (byId.get(nodeId)?.type !== 'condition/ai_analysis') {
      throw new Error(`appointment_data_after_booking_source_ai_node_mismatch:${nodeId}`);
    }
  }
  return true;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existingSnapshot = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existingSnapshot.length) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT *
           FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId
            AND version IN (:sourceVersion, :activeVersion, :reviewVersion)
          FOR UPDATE`,
        {
          replacements: {
            publicId: TARGET_PUBLIC_ID,
            sourceVersion: SOURCE_VERSION,
            activeVersion: 14,
            reviewVersion: REVIEW_VERSION,
          },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const source = rows.find((row) => Number(row.version) === SOURCE_VERSION);
      const active = rows.find((row) => Number(row.version) === 14);
      const existingReview = rows.find((row) => Number(row.version) === REVIEW_VERSION);
      validateSource(source);
      if (!active || Number(active.is_active) !== 1) {
        throw new Error('appointment_data_after_booking_active_v14_mismatch');
      }
      if (existingReview) {
        throw new Error('appointment_data_after_booking_review_v15_already_exists');
      }

      const now = new Date();
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [{
        public_id: source.public_id,
        template_key: source.template_key,
        version: REVIEW_VERSION,
        engine_version: source.engine_version,
        name: source.name,
        description: source.description,
        trigger_type: source.trigger_type,
        trigger_config: source.trigger_config == null
          ? null
          : JSON.stringify(parseJson(source.trigger_config, {})),
        is_active: false,
        is_system: source.is_system,
        clinic_id: source.clinic_id,
        group_id: source.group_id,
        entry_node_id: source.entry_node_id,
        nodes: JSON.stringify(parseJson(source.nodes, [])),
        published_at: now,
        published_by: source.published_by,
        created_by: source.created_by,
        created_at: now,
        updated_at: now,
      }], { transaction });

      const insertedRows = await queryInterface.sequelize.query(
        `SELECT id, version, is_active
           FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId AND version = :reviewVersion
          LIMIT 1`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, reviewVersion: REVIEW_VERSION },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const inserted = insertedRows[0];
      if (!inserted || Number(inserted.is_active) !== 0) {
        throw new Error('appointment_data_after_booking_review_v15_insert_failed');
      }

      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          inserted_template_id: Number(inserted.id),
          source_template_id: Number(source.id),
          active_template_id: Number(active.id),
        }),
        created_at: now,
        updated_at: now,
      }], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(snapshots[0]?.payload, null);
      if (!snapshot?.inserted_template_id) return;

      const rows = await queryInterface.sequelize.query(
        'SELECT id, is_active FROM AutomationFlowTemplatesV2 WHERE id = :id FOR UPDATE',
        {
          replacements: { id: Number(snapshot.inserted_template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (rows[0] && Number(rows[0].is_active) !== 0) {
        throw new Error('appointment_data_after_booking_review_v15_is_active');
      }
      await queryInterface.bulkDelete(
        'AutomationFlowTemplatesV2',
        { id: Number(snapshot.inserted_template_id) },
        { transaction },
      );
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    SNAPSHOT_KEY,
    TARGET_PUBLIC_ID,
    SOURCE_VERSION,
    REVIEW_VERSION,
    validateSource,
  },
};
