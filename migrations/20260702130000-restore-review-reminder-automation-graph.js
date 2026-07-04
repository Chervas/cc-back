'use strict';

const { QueryTypes } = require('sequelize');

function normalizeNodes(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildNodes(previousNodes = []) {
  const byId = new Map(previousNodes.map((node) => [String(node?.id || ''), node]));
  const request = byId.get('N3') || {};
  const condition = byId.get('N5') || {};
  const positive = byId.get('N6') || {};
  const negative = byId.get('N7') || {};
  const threshold = Number(request?.config?.review_threshold || condition?.config?.right_value || 5) || 5;
  return [
    byId.get('N1') || {
      id: 'N1',
      type: 'trigger/appointment_completed',
      config: { event_name: 'appointment_completed' },
      outputs: { on_success: 'N2' },
      position: { x: 120, y: 120 },
    },
    byId.get('N2') || {
      id: 'N2',
      type: 'delay/fixed',
      config: { duration: 24, unit: 'hours' },
      outputs: { on_complete: 'N3' },
      position: { x: 120, y: 280 },
    },
    {
      id: 'N3',
      type: 'action/request_review',
      config: {
        ...(request.config || {}),
        review_threshold: threshold,
        require_message_anchor_for_wait: true,
        wait_for_message_ms: Number(request?.config?.wait_for_message_ms || 6000) || 6000,
      },
      outputs: { on_success: 'N4', on_fail: null },
      position: request.position || { x: 120, y: 440 },
    },
    {
      id: 'N4',
      type: 'delay/wait_response',
      config: {
        ...(byId.get('N4')?.config || {}),
        timeout_duration: 24,
        timeout_unit: 'hours',
        listens_to_node_id: 'N3',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N5', on_timeout: 'N9' },
      position: byId.get('N4')?.position || { x: 120, y: 600 },
    },
    {
      id: 'N5',
      type: 'condition/field_check',
      config: {
        ...(condition.config || {}),
        mode: 'simple',
        left_ref: condition?.config?.left_ref || {
          source: 'context',
          path: 'last_response_context.response_rating',
          value_type: 'number',
          label: 'Valoración del paciente',
        },
        operator: 'greater_than_or_equals',
        right_value: threshold,
      },
      outputs: { on_true: 'N6', on_false: 'N7' },
      position: condition.position || { x: 430, y: 600 },
    },
    {
      id: 'N6',
      type: 'action/review_followup',
      config: {
        ...(positive.config || {}),
        followup_kind: 'google_review',
        review_threshold: threshold,
      },
      outputs: { on_success: null },
      position: positive.position || { x: 720, y: 500 },
    },
    {
      id: 'N7',
      type: 'action/review_followup',
      config: {
        ...(negative.config || {}),
        followup_kind: 'private_feedback',
        review_threshold: threshold,
      },
      outputs: { on_success: null },
      position: negative.position || { x: 720, y: 700 },
    },
    {
      id: 'N9',
      type: 'action/request_review_reminder',
      config: {
        list_id: '{{outputs.N3.list_id}}',
        item_id: '{{outputs.N3.item_id}}',
        previous_message_id: '{{outputs.N3.message_id}}',
        template_name: 'clinicaclick_recordatorio_resena_sin_respuesta',
        reminder_policy: 'after_24h',
      },
      outputs: { on_success: 'N10', on_fail: 'N12' },
      position: { x: 120, y: 760 },
    },
    {
      id: 'N10',
      type: 'delay/wait_response',
      config: {
        timeout_duration: 24,
        timeout_unit: 'hours',
        listens_to_node_id: 'N9',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N5', on_timeout: 'N12' },
      position: { x: 120, y: 920 },
    },
    {
      id: 'N12',
      type: 'action/review_no_response',
      config: {
        list_id: '{{outputs.N3.list_id}}',
        item_id: '{{outputs.N3.item_id}}',
        reason: 'sin_respuesta_tras_recordatorio',
      },
      outputs: { on_success: null },
      position: { x: 120, y: 1080 },
    },
  ];
}

module.exports = {
  async up(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      `
      SELECT id, nodes, description
      FROM AutomationFlowTemplatesV2
      WHERE trigger_type = 'appointment_completed'
        AND (
          template_key LIKE 'review_request_after_completed__clinic_%'
          OR public_id LIKE 'flw_review_req_clinic_%'
          OR CAST(nodes AS CHAR) LIKE '%"action/request_review"%'
        )
      `,
      { type: QueryTypes.SELECT }
    );

    const now = new Date();
    for (const row of rows) {
      const nodes = buildNodes(normalizeNodes(row.nodes));
      await queryInterface.sequelize.query(
        `
        UPDATE AutomationFlowTemplatesV2
           SET nodes = :nodes,
               description = :description,
               updated_at = :now
         WHERE id = :id
        `,
        {
          replacements: {
            id: row.id,
            nodes: JSON.stringify(nodes),
            description: 'Espera 24h tras finalizar un tratamiento, pide al paciente una valoración con escala 5 a 1 y deriva a Google solo si responde 5/5. Si no responde, manda un recordatorio 24h después de la primera solicitud y cierra si sigue sin respuesta 24h después.',
            now,
          },
        }
      );
    }
  },

  async down() {
    // No-op: volver al cierre sin recordatorio requiere una migración explícita.
  },
};
