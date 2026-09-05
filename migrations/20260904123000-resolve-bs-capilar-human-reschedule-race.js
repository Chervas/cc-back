'use strict';

const TECHNICAL_CLEANUP = require('./20260904110000-remove-bs-capilar-technical-notification-nodes')._test;

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'bs_capilar_same_day_human_reschedule_race_v1';
const CHANGE_REQUEST_REPLY = 'Gracias por avisarnos. Revisamos la agenda y te decimos la disponibilidad cuanto antes.';

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

function applyHumanRescheduleContract(inputNodes) {
  const nodes = clone(inputNodes || []);
  const reply = nodes.find((node) => node?.id === 'N51');
  if (!reply || reply.type !== 'action/reply_message') {
    throw new Error('bs_capilar_human_reschedule_reply_node_missing');
  }
  reply.config = {
    ...(reply.config || {}),
    message_text: CHANGE_REQUEST_REPLY,
  };
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

      const previousSnapshots = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: TECHNICAL_CLEANUP.SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const previousSnapshot = parseJson(previousSnapshots[0]?.payload, null);
      const targetId = Number(previousSnapshot?.target_template_id);
      if (!targetId) throw new Error('bs_capilar_human_reschedule_target_missing');

      const rows = await queryInterface.sequelize.query(
        `SELECT id, is_active, nodes FROM AutomationFlowTemplatesV2 WHERE id = :targetId FOR UPDATE`,
        {
          replacements: { targetId },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (!target) throw new Error('bs_capilar_human_reschedule_template_missing');
      if (Number(target.is_active) === 1) {
        throw new Error('bs_capilar_human_reschedule_requires_inactive_version');
      }

      const originalNodes = parseJson(target.nodes, []);
      const nodes = applyHumanRescheduleContract(originalNodes);
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
    CHANGE_REQUEST_REPLY,
    SNAPSHOT_KEY,
    applyHumanRescheduleContract,
  },
};
