'use strict';

const {
  cloneConfirmAppointmentDecisionConfig,
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE,
} = require('../src/lib/automation-intent-contract');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'appointment_data_confirmation_v16_decision_routing';
const TARGET_PUBLIC_ID = 'flw_fc01d1d9647df069';
const TARGET_VERSION = 16;

const ROUTES = Object.freeze([
  { ai: 'N18', success: 'N19', status: 'N20', review: 'N21', decision: 'N46', mixedStatus: 'N47', mixedNotice: 'N48', fallbackNotice: 'N49' },
  { ai: 'N14', success: 'N15', status: 'N17', review: 'N16', decision: 'N50', mixedStatus: 'N51', mixedNotice: 'N52', fallbackNotice: 'N53' },
  { ai: 'N28', success: 'N29', status: 'N30', review: 'N31', decision: 'N54', mixedStatus: 'N55', mixedNotice: 'N56', fallbackNotice: 'N57' },
  { ai: 'N24', success: 'N25', status: 'N26', review: 'N32', decision: 'N58', mixedStatus: 'N59', mixedNotice: 'N60', fallbackNotice: 'N61' },
  { ai: 'N40', success: 'N41', status: 'N42', review: 'N43', decision: 'N62', mixedStatus: 'N63', mixedNotice: 'N64', fallbackNotice: 'N65' },
  { ai: 'N35', success: 'N36', status: 'N37', review: 'N38', decision: 'N66', mixedStatus: 'N67', mixedNotice: 'N68', fallbackNotice: 'N69' },
]);

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

function buildOutputSchema() {
  return Object.fromEntries([
    ...CONFIRM_APPOINTMENT_DECISION_TEMPLATE.branches.map((branch) => [
      branch.id,
      { label: branch.label },
    ]),
    ['on_else', { label: CONFIRM_APPOINTMENT_DECISION_TEMPLATE.fallback_label }],
  ]);
}

function buildClinicNotification(
  id,
  title,
  message,
  position,
  migrationRole,
  displayMode = 'inbox',
  presentationPreferenceKey = null,
) {
  return {
    id,
    type: 'action/send_system_notification',
    config: {
      title,
      message,
      assignee_type: 'role',
      assignee_id: 'personaldeclinica',
      subrole: 'Recepcion / Comercial ventas',
      display_mode: displayMode,
      alert_level: 'warning',
      migration_role: migrationRole,
      ...(presentationPreferenceKey
        ? { presentation_preference_key: presentationPreferenceKey }
        : {}),
    },
    outputs: { on_success: null },
    position,
  };
}

function applyDecisionRouting(inputNodes) {
  const nodes = clone(inputNodes);
  if (!Array.isArray(nodes) || nodes.length !== 41) {
    throw new Error('appointment_data_confirmation_v16_node_count_mismatch');
  }
  const byId = new Map(nodes.map((node) => [node?.id, node]));
  const additions = [];

  for (const route of ROUTES) {
    for (const id of [route.decision, route.mixedStatus, route.mixedNotice, route.fallbackNotice]) {
      if (byId.has(id)) throw new Error(`appointment_data_confirmation_v16_node_id_conflict:${id}`);
    }
    const ai = byId.get(route.ai);
    const success = byId.get(route.success);
    const status = byId.get(route.status);
    const review = byId.get(route.review);
    if (
      ai?.type !== 'condition/ai_analysis'
      || ai?.config?.preset_key !== 'confirm_appointment'
      || Number(ai?.config?.preset_contract_version) !== 2
      || ai?.outputs?.on_success !== route.success
      || ai?.outputs?.on_fail !== route.review
      || success?.type !== 'action/send_whatsapp'
      || status?.type !== 'action/change_status'
      || review?.type !== 'action/send_system_notification'
    ) {
      throw new Error(`appointment_data_confirmation_v16_route_mismatch:${route.ai}`);
    }

    const aiPosition = ai.position || { x: 100, y: 0 };
    ai.config = {
      ...(ai.config || {}),
      decision_template_key: CONFIRM_APPOINTMENT_DECISION_TEMPLATE.key,
    };
    delete ai.config.routing_pending_review;
    ai.outputs = { on_success: route.decision, on_fail: null };
    success.config = {
      ...(success.config || {}),
      suppress_if_human_replied: true,
    };
    review.outputs = { on_success: null };
    review.config = {
      ...(review.config || {}),
      display_mode: 'persistent_alert',
      alert_level: 'warning',
      presentation_preference_key: 'automation.appointment_data.response_needs_human',
    };

    const decisionConfig = cloneConfirmAppointmentDecisionConfig(route.ai, {
      migration_key: SNAPSHOT_KEY,
    });
    additions.push(
      {
        id: route.decision,
        type: 'condition/field_check',
        config: decisionConfig,
        outputs: {
          branch_confirm_without_reply: route.success,
          branch_confirm_needs_reply: route.mixedStatus,
          branch_not_confirmed: route.review,
          on_else: route.fallbackNotice,
        },
        output_schema: buildOutputSchema(),
        position: { x: Number(aiPosition.x || 100), y: Number(aiPosition.y || 0) + 120 },
      },
      {
        id: route.mixedStatus,
        type: 'action/change_status',
        config: {
          ...(status.config || {}),
          migration_role: 'confirmed_with_pending_reply_status',
        },
        outputs: { on_success: route.mixedNotice, on_fail: null },
        position: { x: Number(aiPosition.x || 100) + 140, y: Number(aiPosition.y || 0) + 240 },
      },
      buildClinicNotification(
        route.mixedNotice,
        'Confirmación con respuesta pendiente',
        'El paciente {{paciente.nombre}} ha confirmado su asistencia y ha añadido una pregunta o comentario. Responde desde la conversación.',
        { x: Number(aiPosition.x || 100) + 140, y: Number(aiPosition.y || 0) + 360 },
        'confirmed_with_pending_reply_notice',
        'persistent_alert',
        'automation.appointment_data.confirmed_with_reply',
      ),
      buildClinicNotification(
        route.fallbackNotice,
        'Revisión necesaria',
        'No hay confianza suficiente para aplicar automáticamente la respuesta de {{paciente.nombre}}. Revisa la conversación y la cita.',
        { x: Number(aiPosition.x || 100) + 420, y: Number(aiPosition.y || 0) + 240 },
        'confirmation_low_confidence_review',
      ),
    );
  }

  return [...nodes, ...additions];
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
        `SELECT t.id, t.public_id, t.version, t.is_active, t.published_at,
                t.entry_node_id, t.trigger_type, t.nodes,
                (SELECT COUNT(*) FROM FlowExecutionsV2 e WHERE e.template_version_id = t.id) AS execution_count
           FROM AutomationFlowTemplatesV2 t
          WHERE t.public_id = :publicId AND t.version = :version
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
        throw new Error('appointment_data_confirmation_v16_requires_unused_draft');
      }

      const originalNodes = parseJson(target.nodes, []);
      const routedNodes = applyDecisionRouting(originalNodes);
      const { validateFlowPayloadForInternalUse } = require('../src/controllers/automationsV2.controller');
      const validation = await validateFlowPayloadForInternalUse({
        entry_node_id: target.entry_node_id,
        trigger_type: target.trigger_type,
        nodes: routedNodes,
      });
      if (!validation.ok) {
        throw new Error(`appointment_data_confirmation_v16_invalid:${JSON.stringify(validation.errors)}`);
      }

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
        { nodes: JSON.stringify(routedNodes), updated_at: now },
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
        `SELECT t.id, t.is_active, t.published_at,
                (SELECT COUNT(*) FROM FlowExecutionsV2 e WHERE e.template_version_id = t.id) AS execution_count
           FROM AutomationFlowTemplatesV2 t
          WHERE t.id = :id
          FOR UPDATE`,
        {
          replacements: { id: Number(snapshot.target_template_id) },
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
        throw new Error('appointment_data_confirmation_v16_no_longer_reversible');
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
    ROUTES,
    SNAPSHOT_KEY,
    TARGET_PUBLIC_ID,
    TARGET_VERSION,
    applyDecisionRouting,
    buildOutputSchema,
  },
};
