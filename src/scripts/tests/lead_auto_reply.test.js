'use strict';

const assert = require('assert');
const db = require('../../../models');
const {
  computeNextClinicOpening,
  localDateTimeToUtc,
} = require('../../services/clinicOpeningHours.service');
const {
  evaluatePendingLeadContact,
} = require('../../services/leadContactState.service');
const {
  buildManagedNodes,
  getUnsupportedLeadTemplateVariables,
  isLeadAutoReplyTemplate,
  normalizeConfig,
  resolvePendingBatchSources,
  resolveLeadEventKind,
} = require('../../services/leadAutoReply.service');
const flowEngine = require('../../services/flowEngineV2.service');
const templateAutomationSync = require('../../services/whatsappTemplateAutomationSync.service');
const commercialMigration = require('../../../migrations/20260906220000-mark-lead-outreach-commercial');
const copyMigration = require('../../../migrations/20260908150000-update-lead-first-contact-copy');

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
  assert.equal(
    localDateTimeToUtc('2026-07-22', '00:00:00', 'Europe/Madrid').toISOString(),
    '2026-07-21T22:00:00.000Z'
  );

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

  assert.equal(resolveLeadEventKind({ source: 'web', call_initiated: true }), 'call');
  assert.equal(resolveLeadEventKind({ source: 'web', call_initiated: 1 }), 'call');
  assert.equal(resolveLeadEventKind({ source: 'web', call_initiated: '1' }), 'call');
  assert.equal(resolveLeadEventKind({ source: 'call_click', call_initiated: false }), 'call');
  assert.equal(resolveLeadEventKind({ source: 'web', call_initiated: 0 }), 'write');

  const writeOnlyConfig = normalizeConfig({ configured: true, sources: ['write'] });
  assert.deepEqual(resolvePendingBatchSources(writeOnlyConfig, false), ['write']);
  assert.deepEqual(resolvePendingBatchSources(writeOnlyConfig, true), ['write', 'call']);
  assert.deepEqual(writeOnlyConfig.sources, ['write']);

  const config = normalizeConfig({
    configured: true,
    sources: ['write', 'call'],
    timing: 'immediate',
    schedule_scope: 'clinic_hours',
    whatsapp_template_id: 1849,
    whatsapp_catalog_template_id: 108,
    whatsapp_template_name: 'clinicaclick_lead_primera_visita_programar_v2',
    whatsapp_template_language: 'es',
    sender_display_name: 'Marta',
  });
  const nodes = buildManagedNodes(config);
  assert.equal(nodes.find((node) => node.id === 'N4').config.duration, 1);
  assert.equal(nodes.find((node) => node.id === 'N3').config.mode, 'clinic_schedule');
  assert.equal(nodes.find((node) => node.id === 'N6').config.mode, 'lead_contact_state');
  assert.equal(nodes.find((node) => node.id === 'N7').config.left_ref.path, 'historical_pending');
  assert.equal(nodes.find((node) => node.id === 'N8').type, 'control/rate_limit');
  assert.equal(nodes.find((node) => node.id === 'N8').config.interval_duration, 30);
  assert.equal(nodes.find((node) => node.id === 'N8').outputs.on_complete, 'N9');
  assert.equal(nodes.find((node) => node.id === 'N9').config.recipient_mode, 'context_lead');
  assert.equal(nodes.find((node) => node.id === 'N9').config.catalog_template_id, 108);
  assert.equal(nodes.find((node) => node.id === 'N9').config.language_code, 'es');
  assert.equal(nodes.find((node) => node.id === 'N9').config.communication_scope, 'marketing');
  assert.equal(nodes.find((node) => node.id === 'N9').config.variables_named.nombre_remitente, 'Marta');
  const simulatedRateLimit = await flowEngine._processNode(
    nodes.find((node) => node.id === 'N8'),
    { __simulation: true },
    { simulation: true },
  );
  assert.equal(simulatedRateLimit.kind, 'success');
  assert.equal(simulatedRateLimit.output.simulated, true);
  assert.equal(simulatedRateLimit.next_node_id, 'N9');
  assert.match(copyMigration.__testing.BODY, /Soy \{\{2\}\}\. Te escribo desde \{\{3\}\}/);
  assert.deepEqual(copyMigration.__testing.VARIABLES.map((variable) => variable.name), [
    'nombre_paciente',
    'nombre_remitente',
    'nombre_clinica',
  ]);
  assert.deepEqual(copyMigration.__testing.COMPONENTS[1].buttons.map((button) => button.text), [
    'Sí, dame más información',
    'Ya no estoy interesado',
  ]);
  assert.equal(config.communication_scope, 'marketing');
  assert.equal(flowEngine._resolveAutomationCommunicationScope({
    template_usage: 'lead_auto_reply',
  }, {}), 'marketing');
  assert.equal(flowEngine._resolveAutomationCommunicationScope({
    communication_scope: 'care',
    template_usage: 'lead_primera_visita',
  }, {}), 'marketing');
  assert.equal(flowEngine._resolveAutomationCommunicationScope({
    communication_scope: 'care',
    template_usage: 'recordatorio_cita',
  }, {}), 'care');
  const migratedComponents = commercialMigration.__testing.withLeadButtons([
    { type: 'BODY', text: 'Hola {{1}}' },
  ]);
  assert.deepEqual(migratedComponents[1].buttons.map((button) => button.text), [
    'Quiero una cita',
    'Ya no estoy interesado',
  ]);
  const remigratedComponents = commercialMigration.__testing.withLeadButtons(migratedComponents);
  assert.equal(remigratedComponents.filter((component) => component.type === 'BUTTONS').length, 1);
  const commercialNodes = commercialMigration.__testing.markLeadNodesCommercial([
    { id: 'lead', type: 'action/send_whatsapp', config: { template_usage: 'lead_auto_reply' } },
    { id: 'care', type: 'action/send_whatsapp', config: { template_usage: 'recordatorio_cita' } },
  ]);
  assert.equal(commercialNodes[0].config.communication_scope, 'marketing');
  assert.equal(commercialNodes[1].config.communication_scope, undefined);
  assert.equal(templateAutomationSync.nodeUsesTemplate({
    type: 'action/send_whatsapp',
    config: { template_id: 1945 },
  }, {
    templateId: 1945,
    templateName: 'clinicaclick_lead_primera_visita_con_llamada_v23',
    catalogTemplateId: 109,
  }), true);

  const originalTemplateFindOne = db.WhatsappTemplate.findOne;
  const originalTemplateFindAll = db.WhatsappTemplate.findAll;
  const templateLookupCalls = [];
  try {
    db.WhatsappTemplate.findOne = async ({ where }) => {
      templateLookupCalls.push(where);
      return {
        id: 1945,
        name: 'clinicaclick_lead_primera_visita_con_llamada_v23',
        language: 'es',
        status: 'APPROVED',
        catalog_template_id: 109,
        clinic_id: 19,
        waba_id: null,
        catalog: {
          id: 109,
          family_key: 'clinicaclick_lead_primera_visita_con_llamada',
          locale: 'es',
        },
      };
    };
    db.WhatsappTemplate.findAll = async ({ where }) => {
      templateLookupCalls.push(where);
      return [{
        id: 2945,
        name: 'clinicaclick_lead_primera_visita_con_llamada_v24',
        language: 'es',
        status: 'APPROVED',
        catalog_template_id: 109,
        clinic_id: null,
        waba_id: '1024525056749708',
        catalog: {
          id: 109,
          family_key: 'clinicaclick_lead_primera_visita_con_llamada',
          locale: 'es',
        },
      }];
    };
    const canonicalTemplate = await flowEngine._loadConfiguredWhatsappTemplate({
      template_id: 1945,
      template_name: 'clinicaclick_lead_primera_visita_con_llamada_v2',
    }, {
      clinic_id: 19,
    }, {
      targetWabaId: '1024525056749708',
    });
    assert.equal(canonicalTemplate.id, 2945);
    assert.equal(canonicalTemplate.name, 'clinicaclick_lead_primera_visita_con_llamada_v24');
    assert.deepEqual(templateLookupCalls, [
      { id: 1945 },
      { catalog_template_id: 109, is_active: true },
    ]);
  } finally {
    db.WhatsappTemplate.findOne = originalTemplateFindOne;
    db.WhatsappTemplate.findAll = originalTemplateFindAll;
  }

  const originalFlowTemplateFindAll = db.AutomationFlowTemplateV2.findAll;
  const flowTemplate = {
    id: 1503,
    public_id: 'flw_lead_auto_reply_clinic_19',
    version: 2,
    nodes: [{
      id: 'N7',
      type: 'action/send_whatsapp',
      config: {
        template_id: 1945,
        template_name: 'clinicaclick_lead_primera_visita_con_llamada_v23',
        catalog_template_id: 109,
        variables: { 1: '{{lead.nombre}}', 2: '{{clinic.nombre}}' },
      },
    }],
    async save() {},
  };
  try {
    db.AutomationFlowTemplateV2.findAll = async () => [flowTemplate];
    await templateAutomationSync.recomposeAutomationsUsingTemplate({
      templateInstance: {
        id: 1949,
        name: 'clinicaclick_lead_primera_visita_con_llamada_v24',
        language: 'es',
        catalog_template_id: 109,
        clinic_id: 35,
        catalog: {
          id: 109,
          locale: 'es',
          variables: [
            { name: 'nombre_paciente', position: 1 },
            { name: 'nombre_clinica', position: 2 },
          ],
        },
      },
      logger: { info() {} },
    });
    const preservedConfig = flowTemplate.nodes[0].config;
    assert.equal(preservedConfig.template_id, 1945);
    assert.equal(preservedConfig.template_name, 'clinicaclick_lead_primera_visita_con_llamada_v23');
    assert.equal(preservedConfig.catalog_template_id, 109);
  } finally {
    db.AutomationFlowTemplateV2.findAll = originalFlowTemplateFindAll;
  }

  const semanticFlowTemplate = {
    id: 1505,
    public_id: 'flw_lead_auto_reply_clinic_56',
    version: 2,
    nodes: [{
      id: 'N9',
      type: 'action/send_whatsapp',
      config: {
        template_id: 1858,
        template_name: 'clinicaclick_lead_primera_visita_programar_v20',
        catalog_template_id: 108,
        variables: { 1: '{{lead.nombre}}', 2: '{{clinica.nombre}}' },
        variables_named: {
          nombre_paciente: '{{lead.nombre}}',
          nombre_clinica: '{{clinica.nombre}}',
        },
      },
    }],
    async save() {},
  };
  try {
    db.AutomationFlowTemplateV2.findAll = async () => [semanticFlowTemplate];
    await templateAutomationSync.recomposeAutomationsUsingTemplate({
      templateInstance: {
        id: 1858,
        name: 'clinicaclick_lead_primera_visita_programar_v21',
        language: 'es',
        catalog_template_id: 108,
        clinic_id: 56,
        components: [{
          type: 'BODY',
          text: 'Hola {{1}}. Soy {{2}} y te escribo desde {{3}}.',
        }],
        variables: [
          { name: 'nombre_paciente', position: 1 },
          { name: 'nombre_remitente', position: 2 },
          { name: 'nombre_clinica', position: 3 },
        ],
        catalog: {
          id: 108,
          locale: 'es',
          variables: [
            { name: 'nombre_paciente', position: 1 },
            { name: 'nombre_remitente', position: 2 },
            { name: 'nombre_clinica', position: 3 },
          ],
        },
      },
      logger: { info() {} },
    });
    const recomposedConfig = semanticFlowTemplate.nodes[0].config;
    assert.equal(recomposedConfig.variables_named.nombre_paciente, '{{lead.nombre}}');
    assert.equal(recomposedConfig.variables_named.nombre_clinica, '{{clinica.nombre}}');
    assert.equal(recomposedConfig.variables_named.nombre_remitente, undefined);
    assert.deepEqual(recomposedConfig.variables, {
      1: '{{lead.nombre}}',
      3: '{{clinica.nombre}}',
    });
  } finally {
    db.AutomationFlowTemplateV2.findAll = originalFlowTemplateFindAll;
  }
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
