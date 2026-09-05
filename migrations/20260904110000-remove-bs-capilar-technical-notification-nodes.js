'use strict';

const SIMPLIFICATION = require('./20260904090000-simplify-bs-capilar-same-day-v10')._test;

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'bs_capilar_same_day_remove_technical_notifications_v1';
const TECHNICAL_NOTIFICATION_NODE_IDS = new Set(['N70', 'N71', 'N72', 'N73']);

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

function removeTechnicalNotificationNodes(inputNodes) {
  return clone(inputNodes || [])
    .filter((node) => !TECHNICAL_NOTIFICATION_NODE_IDS.has(node?.id))
    .map((node) => {
      const outputs = { ...(node?.outputs || {}) };
      for (const [key, target] of Object.entries(outputs)) {
        if (TECHNICAL_NOTIFICATION_NODE_IDS.has(target)) outputs[key] = null;
      }
      return { ...node, outputs };
    });
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

      const simplificationSnapshots = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SIMPLIFICATION.SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const simplificationSnapshot = parseJson(simplificationSnapshots[0]?.payload, null);
      const targetId = Number(simplificationSnapshot?.target_template_id);
      if (!targetId) throw new Error('bs_capilar_technical_notifications_target_missing');

      const rows = await queryInterface.sequelize.query(
        'SELECT id, is_active, nodes FROM AutomationFlowTemplatesV2 WHERE id = :targetId FOR UPDATE',
        {
          replacements: { targetId },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (!target) throw new Error('bs_capilar_technical_notifications_template_missing');
      if (Number(target.is_active) === 1) {
        throw new Error('bs_capilar_technical_notifications_requires_inactive_version');
      }

      const originalNodes = parseJson(target.nodes, []);
      const nodes = removeTechnicalNotificationNodes(originalNodes);
      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ target_template_id: targetId, original_nodes: originalNodes }),
        created_at: now,
        updated_at: now,
      }], { transaction });
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(nodes), updated_at: now },
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
    TECHNICAL_NOTIFICATION_NODE_IDS,
    removeTechnicalNotificationNodes,
  },
};
