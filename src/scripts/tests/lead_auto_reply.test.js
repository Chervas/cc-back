'use strict';

const assert = require('assert');
const db = require('../../../models');
const {
  computeNextClinicOpening,
} = require('../../services/clinicOpeningHours.service');
const {
  evaluatePendingLeadContact,
} = require('../../services/leadContactState.service');
const {
  buildManagedNodes,
  getUnsupportedLeadTemplateVariables,
  isLeadAutoReplyTemplate,
  normalizeConfig,
} = require('../../services/leadAutoReply.service');

function madridDate(value) {
  return new Date(value);
}

async function evaluateWith({ lead, attempts = [], outboundMessage = null, capture = null }) {
  return evaluatePendingLeadContact({
    leadId: 10,
    triggeredAt: '2026-07-21T10:00:00.000Z',
    models: {
      LeadIntake: { findByPk: async () => lead },
      LeadContactAttempt: { findAll: async () => attempts },
      Conversation: { findAll: async (options) => {
        if (capture) capture.conversation = options;
        return outboundMessage ? [{ id: 5 }] : [];
      } },
      Message: { findOne: async (options) => {
        if (capture) capture.message = options;
        return outboundMessage;
      } },
    },
  });
}

async function run() {
  const mondayRows = [
    { dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '13:00' },
    { dia_semana: 1, activo: true, hora_inicio: '15:00', hora_fin: '19:00' },
    { dia_semana: 2, activo: true, hora_inicio: '10:00', hora_fin: '18:00' },
  ];
  const duringMorning = computeNextClinicOpening({
    now: madridDate('2026-07-20T10:00:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: mondayRows,
  });
  assert.equal(duringMorning.reason, 'clinic_open_now');
  assert.equal(duringMorning.waitUntil.toISOString(), '2026-07-20T10:00:00.000Z');

  const lunchBreak = computeNextClinicOpening({
    now: madridDate('2026-07-20T11:30:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: mondayRows,
  });
  assert.equal(lunchBreak.reason, 'next_clinic_opening');
  assert.equal(lunchBreak.waitUntil.toISOString(), '2026-07-20T13:00:00.000Z');

  const nextDay = computeNextClinicOpening({
    now: madridDate('2026-07-20T08:00:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: mondayRows,
    nextDay: true,
  });
  assert.equal(nextDay.waitUntil.toISOString(), '2026-07-21T08:00:00.000Z');

  const missingHours = computeNextClinicOpening({ rows: [] });
  assert.equal(missingHours.available, false);
  assert.equal(missingHours.reason, 'clinic_hours_not_configured');

  const noContact = await evaluateWith({
    lead: { id: 10, status_lead: 'contactado', call_outcome: 'no_contactado', archived_at: null },
  });
  assert.equal(noContact.decision, true);
  assert.equal(noContact.reason, 'call_not_contacted');

  const failedCallAttempt = await evaluateWith({
    lead: { id: 10, status_lead: 'contactado', call_outcome: null, archived_at: null },
    attempts: [{ id: 1, canal: 'llamada', motivo: 'no_contesta' }],
  });
  assert.equal(failedCallAttempt.decision, true);

  const manualWhatsapp = await evaluateWith({
    lead: { id: 10, status_lead: 'contactado', call_outcome: null, archived_at: null },
    attempts: [{ id: 2, canal: 'whatsapp', motivo: 'whatsapp_message_sent' }],
  });
  assert.equal(manualWhatsapp.decision, false);
  assert.equal(manualWhatsapp.reason, 'manual_contact_registered');

  const mobileReply = await evaluateWith({
    lead: { id: 10, clinica_id: 19, telefono: '+34 600 123 123', status_lead: 'contactado', call_outcome: null, archived_at: null },
    outboundMessage: { id: 99, direction: 'outbound', status: 'sent' },
  });
  assert.equal(mobileReply.decision, false);
  assert.equal(mobileReply.reason, 'outbound_message_registered');

  const historicalCapture = {};
  const historicalReply = await evaluateWith({
    lead: {
      id: 10,
      clinica_id: 19,
      telefono: '+34 600 123 123',
      status_lead: 'contactado',
      call_outcome: null,
      archived_at: null,
      created_at: '2026-07-21T09:00:00.000Z',
    },
    outboundMessage: { id: 100, direction: 'outbound', status: 'read', created_at: '2026-06-01T09:00:00.000Z' },
    capture: historicalCapture,
  });
  assert.equal(historicalReply.decision, false);
  assert.equal(historicalCapture.conversation.where.clinic_id, 19);
  assert.equal(historicalCapture.conversation.where[db.Sequelize.Op.or].length, 2);
  assert.equal(historicalCapture.message.where.created_at, undefined);

  const scheduled = await evaluateWith({
    lead: { id: 10, status_lead: 'citado', call_outcome: 'citado', archived_at: null },
  });
  assert.equal(scheduled.decision, false);

  const informationOnly = await evaluateWith({
    lead: { id: 10, status_lead: 'descartado', call_outcome: 'informacion', archived_at: null },
  });
  assert.equal(informationOnly.decision, false);

  const config = normalizeConfig({
    configured: true,
    sources: ['write', 'call'],
    timing: 'immediate',
    schedule_scope: 'clinic_hours',
    whatsapp_template_id: 1849,
    whatsapp_template_name: 'clinicaclick_lead_primera_visita_programar_v2',
    whatsapp_template_language: 'es',
  });
  const nodes = buildManagedNodes(config);
  assert.equal(nodes.find((node) => node.id === 'N4').config.duration, 1);
  assert.equal(nodes.find((node) => node.id === 'N5').config.mode, 'clinic_schedule');
  assert.equal(nodes.find((node) => node.id === 'N6').config.mode, 'lead_contact_state');
  assert.equal(nodes.find((node) => node.id === 'N7').config.recipient_mode, 'context_lead');
  assert.equal(nodes.find((node) => node.id === 'N7').config.language_code, 'es');
  assert.deepEqual(getUnsupportedLeadTemplateVariables({
    variables: [{ name: 'nombre_paciente' }, { name: 'nombre_clinica' }],
  }), []);
  assert.deepEqual(getUnsupportedLeadTemplateVariables({
    variables: [{ name: 'hora_cita' }],
  }), ['hora_cita']);
  assert.equal(isLeadAutoReplyTemplate({
    name: 'mi_plantilla',
    variables: [{ name: 'nombre_paciente', template_usage: 'lead_auto_reply' }],
  }), true);
  assert.equal(isLeadAutoReplyTemplate({
    name: 'recordatorio_cita',
    variables: [{ name: 'nombre_paciente' }],
  }), false);

  console.log('lead_auto_reply.test: ok');
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
