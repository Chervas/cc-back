'use strict';

const BASE_MIGRATION = require('./20260903132000-publish-bs-capilar-same-day-intent-routing')._test;

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'bs_capilar_same_day_urgency_routing_v2';

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

function urgencyRule() {
  return {
    id: 'branch_urgent_handled',
    label: 'Urgencia ya notificada',
    comparison_rules: [{
      id: 'rule_1',
      connector: null,
      left_ref: {
        source: 'node_output',
        node_id: 'N3',
        path: 'posible_urgencia',
        value_type: 'boolean',
        label: 'Posible urgencia',
      },
      operator: 'equals',
      right_value: true,
    }],
  };
}

function applyUrgencyRoutingFix(inputNodes) {
  const nodes = clone(inputNodes || []);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ai = byId.get('N3');
  const router = byId.get('N10');
  const notification = byId.get('N30');
  if (!ai || !router || !notification) {
    throw new Error('bs_capilar_urgency_routing_required_node_missing');
  }

  ai.outputs = { ...(ai.outputs || {}), on_success: 'N29' };

  const mainRules = (router.config?.branch_rules || [])
    .filter((rule) => rule?.id !== 'branch_urgent' && rule?.id !== 'branch_urgent_handled');
  const needsReplyIndex = mainRules.findIndex((rule) => rule?.id === 'branch_needs_reply');
  mainRules.splice(needsReplyIndex >= 0 ? needsReplyIndex : mainRules.length, 0, urgencyRule());
  router.config = { ...(router.config || {}), branch_rules: mainRules };
  router.outputs = { ...(router.outputs || {}) };
  delete router.outputs.branch_urgent;
  router.outputs.branch_urgent_handled = null;
  if (router.output_schema && typeof router.output_schema === 'object') {
    delete router.output_schema.branch_urgent;
    router.output_schema.branch_urgent_handled = { label: 'Urgencia ya notificada' };
  }

  notification.outputs = { on_success: 'N10', on_fail: 'N10' };
  notification.position = { x: -260, y: 1020 };
  router.position = { x: 100, y: 1200 };

  for (const node of nodes) {
    if (!['N29', 'N30', 'N10'].includes(node.id) && Number(node.position?.y) >= 1080) {
      node.position = { ...node.position, y: Number(node.position.y) + 360 };
    }
  }

  nodes.push({
    id: 'N29',
    type: 'condition/field_check',
    config: {
      mode: 'simple',
      left_ref: {
        source: 'node_output',
        node_id: 'N3',
        path: 'posible_urgencia',
        value_type: 'boolean',
        label: 'Posible urgencia',
      },
      operator: 'equals',
      right_value: true,
      migration_key: SNAPSHOT_KEY,
    },
    outputs: { on_true: 'N30', on_false: 'N10' },
    position: { x: 100, y: 840 },
  });

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
      if (!targetId) throw new Error('bs_capilar_urgency_routing_target_missing');

      const rows = await queryInterface.sequelize.query(
        `SELECT id, is_active, nodes FROM AutomationFlowTemplatesV2 WHERE id = :targetId FOR UPDATE`,
        {
          replacements: { targetId },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (!target) throw new Error('bs_capilar_urgency_routing_template_missing');
      if (Number(target.is_active) === 1) throw new Error('bs_capilar_urgency_routing_requires_inactive_version');

      const originalNodes = parseJson(target.nodes, []);
      const fixedNodes = applyUrgencyRoutingFix(originalNodes);
      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ target_template_id: targetId, original_nodes: originalNodes }),
        created_at: now,
        updated_at: now,
      }], { transaction });
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(fixedNodes), updated_at: now },
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
    applyUrgencyRoutingFix,
  },
};
