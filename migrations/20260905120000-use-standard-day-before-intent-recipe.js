'use strict';

const { cloneClassifyIntentPresetConfig } = require('../src/lib/automation-intent-contract');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'day_before_confirmation_v10_standard_intent_recipe';
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
        `SELECT template.id, template.nodes, template.entry_node_id, template.trigger_type,
                template.trigger_config, template.is_active, template.published_at,
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
      if (aiNode?.type !== 'condition/ai_analysis') {
        throw new Error('day_before_confirmation_v10_ai_node_missing');
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

      aiNode.config = cloneClassifyIntentPresetConfig({
        mode: aiNode.config?.mode || 'auto',
        max_tokens: Number(aiNode.config?.max_tokens) || 700,
        migration_key: aiNode.config?.migration_key || 'day_before_confirmation_review_v10',
      });

      let validateFlowPayloadForInternalUse;
      try {
        ({ validateFlowPayloadForInternalUse } = require('../src/controllers/automationsV2.controller'));
      } catch (error) {
        throw new Error(`day_before_confirmation_v10_validator_unavailable:${error.message}`);
      }
      const validation = await validateFlowPayloadForInternalUse({
        entry_node_id: target.entry_node_id,
        trigger_type: target.trigger_type,
        trigger_config: parseJson(target.trigger_config, {}),
        nodes,
      });
      if (!validation?.ok) {
        throw new Error(`day_before_confirmation_v10_invalid:${JSON.stringify(validation?.errors || [])}`);
      }

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

  _test: {
    SNAPSHOT_KEY,
    TARGET_PUBLIC_ID,
    TARGET_VERSION,
  },
};
