'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'day_before_confirmation_v10_custom_ai_presentation';
const TARGET_PUBLIC_ID = 'flw_c2f0858ca7e4f0ae';
const TARGET_VERSION = 10;

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existingSnapshot = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existingSnapshot.length) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT template.id, template.nodes, template.is_active, template.published_at,
                (SELECT COUNT(*) FROM FlowExecutionsV2 execution WHERE execution.template_version_id = template.id) AS execution_count
           FROM AutomationFlowTemplatesV2 template
          WHERE template.public_id = :publicId AND template.version = :version
          LIMIT 1
          FOR UPDATE`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, version: TARGET_VERSION },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (
        !target
        || Number(target.is_active) !== 0
        || target.published_at !== null
        || Number(target.execution_count) !== 0
      ) {
        throw new Error('day_before_confirmation_v10_not_editable');
      }

      const nodes = parseJson(target.nodes, []);
      const aiNode = nodes.find((node) => node?.id === 'N3');
      const outputFieldNames = Array.isArray(aiNode?.config?.output_fields)
        ? aiNode.config.output_fields.map((field) => field?.name)
        : [];
      if (
        aiNode?.type === 'condition/ai_analysis'
        && aiNode.config?.preset_key === 'classify_intent'
        && outputFieldNames.includes('posible_urgencia')
      ) {
        return;
      }
      if (
        aiNode?.type !== 'condition/ai_analysis'
        || JSON.stringify(aiNode.config || {}).includes('posible_urgencia')
        || JSON.stringify(aiNode.config || {}).includes('urgencia_posible')
      ) {
        throw new Error('day_before_confirmation_v10_ai_contract_mismatch');
      }

      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          template_id: Number(target.id),
          previous_nodes: nodes,
        }),
        created_at: now,
        updated_at: now,
      }], { transaction });

      aiNode.config = {
        ...(aiNode.config || {}),
        preset_key: null,
        ai_label: 'Clasificar intención del paciente',
        ai_summary: 'La IA distingue confirmación, cancelación, solicitud de cambio, pregunta o agradecimiento, e indica si la clínica debe responder. No evalúa urgencias en este flujo.',
      };
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(nodes), updated_at: now },
        { id: Number(target.id) },
        { transaction },
      );
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
      if (!snapshot?.template_id || !Array.isArray(snapshot.previous_nodes)) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT template.is_active, template.published_at,
                (SELECT COUNT(*) FROM FlowExecutionsV2 execution WHERE execution.template_version_id = template.id) AS execution_count
           FROM AutomationFlowTemplatesV2 template
          WHERE template.id = :id
          LIMIT 1
          FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (
        target
        && (
          Number(target.is_active) !== 0
          || target.published_at !== null
          || Number(target.execution_count) !== 0
        )
      ) {
        throw new Error('day_before_confirmation_v10_no_longer_reversible');
      }
      if (target) {
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { nodes: JSON.stringify(snapshot.previous_nodes), updated_at: new Date() },
          { id: Number(snapshot.template_id) },
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
