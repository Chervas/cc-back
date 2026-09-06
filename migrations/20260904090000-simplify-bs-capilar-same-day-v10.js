'use strict';

const BASE_MIGRATION = require('./20260903132000-publish-bs-capilar-same-day-intent-routing')._test;

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'bs_capilar_same_day_v10_simplification_v1';
const FOLLOWUP_DECLINED_REPLY = 'De acuerdo. Si más adelante necesitas una nueva cita, estaremos encantados de ayudarte.';

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

function withoutUrgencyInstruction(rawInstruction) {
  return String(rawInstruction || '')
    .replace(/\s*Marca posible urgencia solo como senal operativa para revision humana; no diagnostiques\./i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function applySameDayV10Simplification(inputNodes) {
  const nodes = clone(inputNodes || []).filter((node) => !['N29', 'N30'].includes(node?.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ai = byId.get('N3');
  const router = byId.get('N10');
  const followupRouter = byId.get('N45');
  if (!ai || !router || !followupRouter) {
    throw new Error('bs_capilar_same_day_v10_simplification_required_node_missing');
  }
  if (byId.has('N74')) {
    throw new Error('bs_capilar_same_day_v10_simplification_node_id_conflict');
  }

  ai.outputs = { ...(ai.outputs || {}), on_success: 'N10' };
  ai.config = {
    ...(ai.config || {}),
    instruction: withoutUrgencyInstruction(ai.config?.instruction),
    output_fields: (ai.config?.output_fields || [])
      .filter((field) => field?.name !== 'posible_urgencia')
      .map((field) => ({
        ...field,
        ...(Array.isArray(field?.allowed_values)
          ? { allowed_values: field.allowed_values.filter((value) => value !== 'urgencia_posible') }
          : {}),
      })),
  };

  const removedBranchIds = new Set(['branch_urgent', 'branch_urgent_handled']);
  router.config = {
    ...(router.config || {}),
    branch_rules: (router.config?.branch_rules || []).filter((rule) => !removedBranchIds.has(rule?.id)),
  };
  router.outputs = { ...(router.outputs || {}) };
  router.output_schema = { ...(router.output_schema || {}) };
  for (const branchId of removedBranchIds) {
    delete router.outputs[branchId];
    delete router.output_schema[branchId];
  }

  followupRouter.outputs = {
    ...(followupRouter.outputs || {}),
    branch_no: 'N74',
  };

  for (const node of nodes) {
    if (node?.type !== 'action/send_system_notification') continue;
    node.outputs = { ...(node.outputs || {}) };
    delete node.outputs.on_fail;
  }

  nodes.push({
    id: 'N74',
    type: 'action/reply_message',
    config: {
      message_text: FOLLOWUP_DECLINED_REPLY,
      suppress_if_human_replied: true,
      suppress_if_response_needed: false,
      migration_key: SNAPSHOT_KEY,
    },
    outputs: { on_success: null, on_fail: 'N72' },
    position: { x: -100, y: 2520 },
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
      if (!targetId) throw new Error('bs_capilar_same_day_v10_simplification_target_missing');

      const rows = await queryInterface.sequelize.query(
        `SELECT id, is_active, nodes FROM AutomationFlowTemplatesV2 WHERE id = :targetId FOR UPDATE`,
        {
          replacements: { targetId },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const target = rows[0];
      if (!target) throw new Error('bs_capilar_same_day_v10_simplification_template_missing');
      if (Number(target.is_active) === 1) {
        throw new Error('bs_capilar_same_day_v10_simplification_requires_inactive_version');
      }

      const originalNodes = parseJson(target.nodes, []);
      const simplifiedNodes = applySameDayV10Simplification(originalNodes);
      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ target_template_id: targetId, original_nodes: originalNodes }),
        created_at: now,
        updated_at: now,
      }], { transaction });
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(simplifiedNodes), updated_at: now },
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
    FOLLOWUP_DECLINED_REPLY,
    SNAPSHOT_KEY,
    applySameDayV10Simplification,
  },
};
