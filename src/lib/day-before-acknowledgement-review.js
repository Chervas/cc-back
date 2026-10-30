'use strict';

const { templateFamilyKey } = require('./appointment-template-scope');
const FAMILY_KEY = 'recordatorio_y_confirmacion_bed4b6';
const NODE_ID = 'N38';
const FLAG = 'appointment_confirmation_pending_only';

function inScope(row) {
  // Retain the published Nou Barris copy's established family identity too.
  return row?.trigger_type === 'appointment_reminder_window'
    && (templateFamilyKey(row) === FAMILY_KEY
      || /^recordatorio_y_confirmacion_bed4b6_clinic_\d+_copy_\d+$/.test(row.template_key || ''));
}

function adapt(source) {
  if (!inScope(source)) throw Error('ack_review_family_out_of_scope');
  const nodes = structuredClone(source.nodes);
  const ai = nodes.find(n => n.id === 'N3');
  const router = nodes.find(n => n.id === 'N16');
  const reception = nodes.find(n => n.id === 'N33');
  if (ai?.config?.preset_key !== 'classify_intent' || ai.outputs?.on_success !== 'N16'
    || router?.config?.mode !== 'multi_branch'
    || !router.config.branch_rules?.some(r => r.id === 'branch_ack')
    || reception?.type !== 'action/send_system_notification') throw Error('ack_review_graph_incompatible');
  if (router.outputs.branch_ack === NODE_ID
    && nodes.find(n => n.id === NODE_ID)?.config?.[FLAG] === true) return nodes;
  if (router.outputs.branch_ack != null || nodes.some(n => n.id === NODE_ID)) throw Error('ack_review_custom_branch_requires_review');
  router.outputs.branch_ack = NODE_ID;
  router.config.branch_rules.find(r => r.id === 'branch_ack').label = 'Agradece sin confirmar: revisar cita pendiente';
  router.output_schema = { ...router.output_schema,
    branch_ack: { label: 'Agradece sin confirmar: revisar cita pendiente' } };
  nodes.push({ id: NODE_ID, type: 'action/send_system_notification',
    config: { ...structuredClone(reception.config),
      display_label: 'Revisar confirmación pendiente',
      title: 'Confirmación pendiente de {{paciente.nombre}}',
      message: 'El paciente ha respondido, pero no se ha podido confirmar la cita. Revisa su respuesta.',
      display_mode: 'persistent_alert', alert_level: 'warning', [FLAG]: true },
    outputs: { on_success: null },
    position: { x: Number(router.position?.x || 0) - 360, y: Number(router.position?.y || 0) + 180 } });
  return nodes;
}

// All inputs are fresh, scoped database records; a saved AI result never
// establishes that a reminder still needs a clinical decision.
function pendingReason({ appointment, state, execution, context, now = new Date() }) {
  const expected = context?.trigger?.data?.inicio || context?.appointment?.inicio;
  const start = new Date(appointment?.inicio || 'invalid').getTime();
  if (!appointment || Number(appointment.clinica_id) !== Number(execution.clinic_id)
    || Number(appointment.paciente_id) !== Number(context?.appointment?.paciente_id || context?.patient?.id)
    || Number(appointment.id_cita) !== Number(context?.appointment?.id_cita || context?.appointment?.id)) return 'appointment_scope_changed';
  // Appointment DATETIME columns store seconds, not JavaScript milliseconds.
  if (!Number.isFinite(start) || !expected
    || Math.trunc(start / 1000) !== Math.trunc(new Date(expected).getTime() / 1000)) return 'appointment_rescheduled';
  if (start <= now.getTime() || appointment.arrived_at || appointment.care_started_at || appointment.care_completed_at
    || appointment.estado !== 'recordatorio_enviado') return 'appointment_no_longer_pending';
  if (!state || Number(state.clinic_id) !== Number(execution.clinic_id)
    || Number(state.execution_id) !== Number(execution.id)
    || Number(state.appointment_id) !== Number(appointment.id_cita)
    || !['active', 'review'].includes(state.status)) return 'review_owner_changed_or_resolved';
  const responseId = context?.last_response_context?.response_message_id;
  if (!responseId || Number(state.source_message_id) !== Number(responseId)) return 'response_owner_changed';
  return null;
}

function runtimeNodes(template, latest, nodes) {
  if (!inScope(template) || latest?.public_id !== template.public_id
    || Number(latest.clinic_id || 0) !== Number(template.clinic_id || 0)
    || !latest.nodes?.some(n => n.id === NODE_ID && n.config?.[FLAG] === true)) return nodes;
  // Waiting executions retain their inference, correlation and timers. Only
  // their formerly silent exit adopts this family's newly published review.
  try { return adapt({ ...template, nodes }); }
  catch (error) {
    if (['ack_review_graph_incompatible', 'ack_review_custom_branch_requires_review'].includes(error.message)) return nodes;
    throw error;
  }
}

module.exports = { FAMILY_KEY, NODE_ID, FLAG, inScope, adapt, pendingReason, runtimeNodes };
