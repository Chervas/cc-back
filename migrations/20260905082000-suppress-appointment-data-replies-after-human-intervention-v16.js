'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'appointment_data_confirmation_v16_human_reply_suppression';
const TARGET_PUBLIC_ID = 'flw_fc01d1d9647df069';
const TARGET_VERSION = 16;
const REPLY_NODE_IDS = Object.freeze(['N15', 'N19', 'N25', 'N29', 'N36', 'N41']);

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function enableHumanReplySuppression(inputNodes) {
  const nodes = JSON.parse(JSON.stringify(inputNodes ?? null));
  if (!Array.isArray(nodes) || nodes.length !== 65) {
    throw new Error('appointment_data_confirmation_v16_reply_suppression_node_count_mismatch');
  }
  const byId = new Map(nodes.map((node) => [node?.id, node]));
  for (const id of REPLY_NODE_IDS) {
    const node = byId.get(id);
    if (node?.type !== 'action/send_whatsapp' || node?.config?.message_mode !== 'manual') {
      throw new Error(`appointment_data_confirmation_v16_reply_suppression_mismatch:${id}`);
    }
    node.config = {
      ...(node.config || {}),
      suppress_if_human_replied: true,
    };
  }
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
      const rows = await queryInterface.sequelize.query(
        `SELECT id, nodes, is_active, published_at
           FROM AutomationFlowTemplatesV2
          WHERE public_id = :publicId AND version = :version
          FOR UPDATE`,
        {
          replacements: { publicId: TARGET_PUBLIC_ID, version: TARGET_VERSION },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (!target || Number(target.is_active) !== 0 || target.published_at !== null) {
        throw new Error('appointment_data_confirmation_v16_reply_suppression_requires_draft');
      }
      const originalNodes = parseJson(target.nodes, []);
      const updatedNodes = enableHumanReplySuppression(originalNodes);
      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ target_template_id: Number(target.id), original_nodes: originalNodes }),
        created_at: now,
        updated_at: now,
      }], { transaction });
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(updatedNodes), updated_at: now },
        { id: Number(target.id), is_active: false, published_at: null },
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
      if (!snapshot?.target_template_id || !Array.isArray(snapshot.original_nodes)) return;
      const targets = await queryInterface.sequelize.query(
        `SELECT id, is_active, published_at FROM AutomationFlowTemplatesV2 WHERE id = :id FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.target_template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (targets[0] && (Number(targets[0].is_active) !== 0 || targets[0].published_at !== null)) {
        throw new Error('appointment_data_confirmation_v16_reply_suppression_no_longer_reversible');
      }
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(snapshot.original_nodes), updated_at: new Date() },
        { id: Number(snapshot.target_template_id), is_active: false, published_at: null },
        { transaction },
      );
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    REPLY_NODE_IDS,
    enableHumanReplySuppression,
  },
};
