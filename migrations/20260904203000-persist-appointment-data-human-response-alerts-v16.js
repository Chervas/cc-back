'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'appointment_data_confirmation_v16_persistent_human_response_alerts';
const TARGET_PUBLIC_ID = 'flw_fc01d1d9647df069';
const TARGET_VERSION = 16;
const REVIEW_NODE_IDS = Object.freeze(['N21', 'N16', 'N31', 'N32', 'N43', 'N38']);
const CONFIRMED_REPLY_NODE_IDS = Object.freeze(['N48', 'N52', 'N56', 'N60', 'N64', 'N68']);
const LOW_CONFIDENCE_NODE_IDS = Object.freeze(['N49', 'N53', 'N57', 'N61', 'N65', 'N69']);

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

function applyPersistentHumanResponseAlerts(inputNodes) {
  const nodes = clone(inputNodes);
  if (!Array.isArray(nodes) || nodes.length !== 65) {
    throw new Error('appointment_data_confirmation_v16_alert_node_count_mismatch');
  }
  const byId = new Map(nodes.map((node) => [node?.id, node]));

  for (const id of [...REVIEW_NODE_IDS, ...CONFIRMED_REPLY_NODE_IDS]) {
    const node = byId.get(id);
    if (node?.type !== 'action/send_system_notification') {
      throw new Error(`appointment_data_confirmation_v16_alert_node_mismatch:${id}`);
    }
    node.config = {
      ...(node.config || {}),
      display_mode: 'persistent_alert',
      alert_level: 'warning',
      presentation_preference_key: REVIEW_NODE_IDS.includes(id)
        ? 'automation.appointment_data.response_needs_human'
        : 'automation.appointment_data.confirmed_with_reply',
    };
  }

  for (const id of LOW_CONFIDENCE_NODE_IDS) {
    const node = byId.get(id);
    if (
      node?.type !== 'action/send_system_notification'
      || node?.config?.display_mode !== 'inbox'
    ) {
      throw new Error(`appointment_data_confirmation_v16_low_confidence_node_mismatch:${id}`);
    }
  }

  return nodes;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (snapshots.length) return;

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
        throw new Error('appointment_data_confirmation_v16_alert_requires_draft');
      }

      const originalNodes = parseJson(target.nodes, []);
      const updatedNodes = applyPersistentHumanResponseAlerts(originalNodes);
      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          target_template_id: Number(target.id),
          original_nodes: originalNodes,
        }),
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

      const rows = await queryInterface.sequelize.query(
        `SELECT id, is_active, published_at
           FROM AutomationFlowTemplatesV2
          WHERE id = :id
          FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.target_template_id) },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (target && (Number(target.is_active) !== 0 || target.published_at !== null)) {
        throw new Error('appointment_data_confirmation_v16_alert_no_longer_reversible');
      }
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(snapshot.original_nodes), updated_at: new Date() },
        { id: Number(snapshot.target_template_id), is_active: false, published_at: null },
        { transaction },
      );
      await queryInterface.bulkDelete(
        SNAPSHOT_TABLE,
        { snapshot_key: SNAPSHOT_KEY },
        { transaction },
      );
    });
  },

  _test: {
    CONFIRMED_REPLY_NODE_IDS,
    LOW_CONFIDENCE_NODE_IDS,
    REVIEW_NODE_IDS,
    SNAPSHOT_KEY,
    TARGET_PUBLIC_ID,
    TARGET_VERSION,
    applyPersistentHumanResponseAlerts,
  },
};
