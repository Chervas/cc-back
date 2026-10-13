'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectClassifyIntentReferenceOutput: project } = require('../../lib/automation-intent-contract');
const { isSameDayDirectionsTemplate, FAMILY_KEY } = require('../../lib/same-day-no-action-branch');
const valid = { intencion_principal: 'confirmar_cita', intencion_secundaria: '',
  confianza_intencion_principal: .99, lectura_respuesta: 'compromiso_asistencia', confianza_lectura_respuesta: .99,
  asunto_preguntado: 'indicaciones', evidencia_decision_actual: 'Alli estare',
  decision_pospuesta: false, confianza_decision_pospuesta: .99,
  requiere_verificar_gestion_o_condicion: false, confianza_requiere_verificar_gestion_o_condicion: .99,
  hay_asunto_por_resolver: false, confianza_hay_asunto_por_resolver: .99, necesita_respuesta: false };
const options = { patientText: 'Alli estare, conozco el camino', allowIndependentWrittenAction: true };

test('only the canonical same-day family opts in, never copies or other reminder families', () => {
  const template = { trigger_type: 'appointment_reminder_window', template_key: FAMILY_KEY };
  assert.equal(isSameDayDirectionsTemplate(template), true);
  assert.equal(isSameDayDirectionsTemplate({ ...template, template_key: FAMILY_KEY + '__clinic_35' }), true);
  for (const value of [undefined, {}, { ...template, trigger_type: 'appointment_created' },
    { ...template, template_key: FAMILY_KEY + '__clinic_35_copy_123' },
    { ...template, template_key: 'recordatorio_dia_anterior' }]) assert.equal(isSameDayDirectionsTemplate(value), false);
});

test('independent written commitment keeps all evidence controls and is opt-in', () => {
  assert.equal(project(valid, options).intencion_principal, 'confirmar_cita');
  assert.equal(project(valid, { patientText: options.patientText }).intencion_principal, 'otra');
  for (const patch of [{ evidencia_decision_actual: 'Invented' }, { decision_pospuesta: true },
    { requiere_verificar_gestion_o_condicion: true }, { confianza_lectura_respuesta: .7 },
    { posible_urgencia: true }, { intencion_secundaria: 'cancelar_cita' }, { asunto_preguntado: undefined },
    { lectura_respuesta: 'consulta_gestion_previa' }, { lectura_respuesta: 'solo_indicaciones' }]) {
    const held = project({ ...valid, ...patch }, options);
    assert.equal(held.intencion_principal, 'otra');
    assert.equal(held.necesita_respuesta, true);
  }
});

test('contextual acknowledgements and reactions about directions are still held', () => {
  const written = { ...valid, evidencia_decision_actual: 'Si', lectura_respuesta: 'acuse_confirmacion_solicitada' };
  assert.equal(project(written, { ...options, patientText: 'Si' }).intencion_principal, 'otra');
  const reaction = { ...written, evidencia_decision_actual: '', id_confirmacion_por_reaccion: 47,
    confianza_id_confirmacion_por_reaccion: .99 };
  assert.equal(project(reaction, { ...options, patientText: '', responseItems: [
    { message_id: 47, content_type: 'reaction', emoji: 'heart', target_message_preview: 'Do you know how to get here?' },
  ] }).intencion_principal, 'otra');
});

test('explicit written refusal still requires an independently established cancellation', () => {
  const cancellation = { ...valid, intencion_principal: 'cancelar_cita', lectura_respuesta: 'rechazo_asistencia',
    evidencia_decision_actual: 'No puedo ir, cancela mi cita', rechazo_asistencia_explicito: true,
    confianza_rechazo_asistencia_explicito: .99 };
  const input = { ...options, patientText: cancellation.evidencia_decision_actual };
  assert.equal(project(cancellation, input).intencion_principal, 'cancelar_cita');
  for (const patch of [{ rechazo_asistencia_explicito: false }, { confianza_rechazo_asistencia_explicito: .5 },
    { evidencia_decision_actual: 'No', lectura_respuesta: 'ambigua' }, { hay_asunto_por_resolver: true }]) {
    assert.equal(project({ ...cancellation, ...patch }, input).intencion_principal, 'otra');
  }
});
