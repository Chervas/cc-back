'use strict';

const REQUEST = 'patient.mobile_verification_requested';
const RESOLVED = 'patient.mobile_verification_resolved';
const TRANSITION = 'patient.mobile_verification_transition';
const FAMILY = 'patient_mobile_verification_v1';
const SCHEMA = 'patient-mobile-verification/v1';
const TEMPLATE = 'clinicaclick_verificar_cambio_movil';
const BODY = 'Hola, somos {{1}}. Hemos actualizado tu teléfono con el número que nos has facilitado. ¿Nos confirmas que este número es correcto?';
const BUTTONS = ['Sí, es correcto', 'No, revisar'];
const id = value => ['number', 'string'].includes(typeof value) && /^[1-9]\d*$/.test(String(value))
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const phone = value => require('./phone').normalizePhoneE164(value)?.replace(/^\+/, '') || null;
const timeout = value => id(value) && Number(value) <= 10080 ? Number(value) : null;
const reasons = {
  patient_rejected: 'El paciente indica que el número no es correcto',
  no_response: 'Sin respuesta',
  delivery_failed: 'El mensaje no se ha podido enviar',
  delivery_unknown: 'El resultado del envío no se ha podido confirmar',
  communication_blocked: 'El envío está bloqueado por los permisos o restricciones vigentes',
  template_unavailable: 'Falta una plantilla Utility aprobada para el WhatsApp emisor',
  conversation_conflict: 'Es necesario revisar la conversación del nuevo teléfono',
  source_changed: 'La solicitud o el documento de origen ya no están vigentes',
  response_unclear: 'La respuesta no permite verificar el número',
};

function definition(clinicId = null) {
  const node = (n, type, config, outputs, x, y) => ({ id: n, type, config, outputs, position: { x, y } });
  return {
    public_id: clinicId ? `flw_mobile_verify_${clinicId}` : 'flw_mobile_verify_system',
    template_key: clinicId ? `${FAMILY}__clinic_${clinicId}` : FAMILY,
    name: 'Verificación de cambio de móvil', version: 1, engine_version: 'v2',
    description: 'Verifica el móvil aceptado por recepción. Las respuestas no confirman citas ni autorizan publicidad. Preparada y desactivada.',
    trigger_type: REQUEST, trigger_config: { managed_feature: 'patient_mobile_verification', configured: false,
      response_timeout_minutes: null, enabled_after: null },
    clinic_id: clinicId, group_id: null, is_system: !clinicId, is_active: false, entry_node_id: 'N1',
    nodes: [
      node('N1', `trigger/${REQUEST}`, { response_timeout_minutes: null, enabled_after: null }, { on_success: 'N2' }, 0, 0),
      node('N2', 'action/request_mobile_verification', {}, { on_success: 'N3', on_review: 'N4', on_superseded: 'N5' }, 0, 300),
      node('N3', 'delay/wait_mobile_verification', {}, { on_confirmed: 'N5', on_review: 'N4', on_timeout: 'N4', on_delivery_failed: 'N4', on_superseded: 'N5' }, 0, 650),
      node('N4', 'action/review_mobile_verification', {}, { on_success: 'N5' }, 450, 1100),
      node('N5', 'control/end', {}, {}, 0, 1500),
    ], published_at: null, created_by: 1,
  };
}

function configValid(config) {
  return config?.configured === true && !!timeout(config.response_timeout_minutes)
    && typeof config.enabled_after === 'string' && Number.isFinite(Date.parse(config.enabled_after));
}

function graphValid(nodes) {
  if (!Array.isArray(nodes)) return false;
  const types = [`trigger/${REQUEST}`, 'action/request_mobile_verification', 'delay/wait_mobile_verification',
    'action/review_mobile_verification', 'control/end'];
  if (nodes.length !== types.length || !types.every(type => nodes.filter(n => n?.type === type).length === 1)
    || new Set(nodes.map(n => n.id)).size !== nodes.length || nodes.some(n => typeof n.id !== 'string' || !n.id)) return false;
  const [trigger, send, wait, review, end] = types.map(type => nodes.find(n => n.type === type));
  const edges = [
    [trigger, { on_success: send.id }],
    [send, { on_success: wait.id, on_review: review.id, on_superseded: end.id }],
    [wait, { on_confirmed: end.id, on_review: review.id, on_timeout: review.id, on_delivery_failed: review.id, on_superseded: end.id }],
    [review, { on_success: end.id }], [end, {}],
  ];
  return edges.every(([node, outputs]) => Object.keys(node.outputs || {}).length === Object.keys(outputs).length
    && Object.entries(outputs).every(([key, target]) => node.outputs?.[key] === target));
}

function templateValid(template) {
  if (!template || template.status !== 'APPROVED' || template.is_active === false
    || template.category !== 'UTILITY') return false;
  const components = template.components;
  if (!Array.isArray(components)) return false;
  const body = components.find(c => c.type?.toUpperCase() === 'BODY');
  const buttons = components.find(c => c.type?.toUpperCase() === 'BUTTONS')?.buttons;
  return body?.text === BODY && components.length === 2 && Array.isArray(buttons) && buttons.length === 2
    && buttons.every((b, i) => b.type?.toUpperCase() === 'QUICK_REPLY' && b.text === BUTTONS[i]);
}

function stateFrom(request, events = []) {
  const transitions = events.filter(e => id(e.metadata?.request_event_id) === id(request.id))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const last = transitions.at(-1)?.metadata || {};
  return { request_event_id: Number(request.id), patient_id: Number(request.patient_id), clinic_id: Number(request.clinic_id),
    phone: phone(request.metadata?.phone), state: last.state || 'pending', reason: last.reason || null,
    reason_text: reasons[last.reason] || null, current: last.current !== false,
    delivery_enabled: request.metadata?.delivery_enabled === true, delivery_status: last.delivery_status || 'not_started',
    accepted_at: last.accepted_at || null, resolved_at: last.resolved_at || null,
    provenance: last.provenance || null, actor_user_id: last.actor_user_id || null,
    manually_resolved: last.manually_resolved === true, revision: Number(transitions.at(-1)?.id || request.id),
    history: transitions.map(e => ({ id: Number(e.id), event_type: e.event_type, at: e.occurred_at,
      state: e.metadata?.state, reason: e.metadata?.reason || null, current: e.metadata?.current !== false,
      provenance: e.metadata?.provenance || null, actor_user_id: e.actor_user_id || null,
      inbound_message_id: e.metadata?.inbound_message_id || null })),
  };
}

module.exports = { REQUEST, RESOLVED, TRANSITION, FAMILY, SCHEMA, TEMPLATE, BODY, BUTTONS,
  id, phone, timeout, reasons, definition, configValid, graphValid, templateValid, stateFrom };
