'use strict';

const {
  cloneClassifyIntentPresetConfig,
} = require('../src/lib/automation-intent-contract');
const BASE_MIGRATION = require('./20260903132000-publish-bs-capilar-same-day-intent-routing')._test;

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'bs_capilar_uncertain_confirmation_contract_v1';

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function applyUncertainConfirmationContract(inputNodes) {
  const canonical = cloneClassifyIntentPresetConfig();
  let changed = 0;
  const nodes = clone(inputNodes || []).map((node) => {
    if (node?.type !== 'condition/ai_analysis' || node?.config?.preset_key !== 'classify_intent') {
      return node;
    }
    changed += 1;
    return {
      ...node,
      config: {
        ...node.config,
        instruction: canonical.instruction,
        context_sources: canonical.context_sources,
        output_fields: canonical.output_fields,
      },
    };
  });
  if (!changed) throw new Error('bs_capilar_classify_intent_node_missing');
  return nodes;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existing = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existing.length) return;

      const baseSnapshots = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: BASE_MIGRATION.SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const baseSnapshot = parseJson(baseSnapshots[0]?.payload, null);
      const targetId = Number(baseSnapshot?.inserted_template_id);
      if (!targetId) throw new Error('bs_capilar_uncertain_confirmation_target_missing');

      const rows = await queryInterface.sequelize.query(
        'SELECT id, is_active, nodes FROM AutomationFlowTemplatesV2 WHERE id = :targetId FOR UPDATE',
        {
          replacements: { targetId },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (!target) throw new Error('bs_capilar_uncertain_confirmation_template_missing');
      if (Number(target.is_active) === 1) throw new Error('bs_capilar_uncertain_confirmation_requires_inactive_version');

      const originalNodes = parseJson(target.nodes, []);
      const hardenedNodes = applyUncertainConfirmationContract(originalNodes);
      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ target_template_id: targetId, original_nodes: originalNodes }),
        created_at: now,
        updated_at: now,
      }], { transaction });
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(hardenedNodes), updated_at: now },
        { id: targetId },
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const rows = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(rows[0]?.payload, null);
      if (!snapshot?.target_template_id || !Array.isArray(snapshot.original_nodes)) return;
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(snapshot.original_nodes), updated_at: new Date() },
        { id: Number(snapshot.target_template_id), is_active: false },
        { transaction },
      );
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    SNAPSHOT_KEY,
    applyUncertainConfirmationContract,
  },
};
