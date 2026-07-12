'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS,
} = require('../../services/googleDataManagerConversion.service');
const {
  getGoogleAdsEventConfig,
} = require('../../services/googleAdsConversionUpload.service');
const {
  qualifiedLeadActionPayload,
} = require('../../services/googleAdsConversion.service');
const {
  ensureQualifiedLeadConversion,
  maybeUploadQualifiedLeadStatusTransition,
  uploadScheduleForLinkedAppointment,
} = require('../../services/leadQualificationMilestone.service');
const {
  buildLifecycleConversionPayload,
} = require('../../services/googleLeadLifecycleConversion.service');

function leadFixture(overrides = {}) {
  return {
    id: 7180,
    clinica_id: 56,
    grupo_clinica_id: 5,
    email: 'patient@example.com',
    telefono: '+34600000000',
    nombre: 'Paciente Prueba',
    notas: 'dato clínico que nunca debe entrar en el payload del hito',
    consentimiento_canal: { ad_user_data: 'granted' },
    ...overrides,
  };
}

async function testExplicitQualifiedTransitionIsIdempotentAndMinimal() {
  const uploads = [];
  const dependencies = {
    maybeUploadLeadLifecycleConversion: async (input) => {
      uploads.push(input);
      return { sent: true, accepted: true };
    },
  };
  const lead = leadFixture();

  const first = await maybeUploadQualifiedLeadStatusTransition({
    lead,
    previousStatus: 'contactado',
    nextStatus: 'cualificado',
    occurredAt: new Date('2026-07-12T12:00:00Z'),
    dependencies,
  });
  assert.equal(first.sent, true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].eventName, 'qualified_lead');
  assert.equal(uploads[0].eventId, 'lead-7180-qualified');
  assert.equal(uploads[0].value, 0);
  assert.equal(Object.hasOwn(uploads[0], 'customData'), false);
  const externalPayload = buildLifecycleConversionPayload({
    lead,
    eventName: uploads[0].eventName,
    eventId: uploads[0].eventId,
    value: uploads[0].value,
  });
  assert.equal(JSON.stringify(externalPayload).includes('dato clínico'), false);
  assert.equal(Object.hasOwn(externalPayload.userData, 'notes'), false);

  const alreadyQualified = await maybeUploadQualifiedLeadStatusTransition({
    lead,
    previousStatus: 'cualificado',
    nextStatus: 'cualificado',
    dependencies,
  });
  assert.equal(alreadyQualified.reason, 'qualified_status_already_set');
  assert.equal(uploads.length, 1);

  const contactOnly = await maybeUploadQualifiedLeadStatusTransition({
    lead,
    previousStatus: 'nuevo',
    nextStatus: 'contactado',
    dependencies,
  });
  assert.equal(contactOnly.reason, 'qualified_status_required');
  assert.equal(uploads.length, 1);
}

async function testDirectAppointmentUsesSameQualifiedIdBeforeSchedule() {
  const uploads = [];
  const dependencies = {
    maybeUploadLeadLifecycleConversion: async (input) => {
      uploads.push(input);
      return { sent: true, accepted: true };
    },
  };
  const lead = leadFixture();
  const appointment = {
    id_cita: 321,
    clinica_id: 56,
    lead_intake_id: lead.id,
    created_at: new Date('2026-07-12T12:30:00Z'),
  };

  await ensureQualifiedLeadConversion({ lead, dependencies });
  await uploadScheduleForLinkedAppointment({ lead, appointment, dependencies });
  assert.deepEqual(uploads.map((item) => item.eventId), [
    'lead-7180-qualified',
    'appointment-321',
  ]);
  assert.deepEqual(uploads.map((item) => item.eventName), ['qualified_lead', 'schedule']);

  const wrongLink = await uploadScheduleForLinkedAppointment({
    lead,
    appointment: { ...appointment, lead_intake_id: 999 },
    dependencies,
  });
  assert.equal(wrongLink.reason, 'appointment_lead_link_required');
  assert.equal(uploads.length, 2);
}

async function testQualifiedEventCatalogAndEnhancedAllowlist() {
  const action = qualifiedLeadActionPayload();
  assert.equal(action.name, 'Qualified Lead - ClinicaClick');
  assert.equal(action.category, 'QUALIFIED_LEAD');
  assert.equal(action.primaryForGoal, false);
  const configured = getGoogleAdsEventConfig({
    enabled: true,
    events: {
      qualified_lead: {
        enabled: true,
        customer_id: '5992356722',
        conversion_action_id: '123456789',
      },
    },
  }, 'qualified_lead');
  assert.equal(configured.event_name, 'qualified_lead');
  assert.equal(configured.customer_id, '5992356722');
  assert.equal(configured.conversion_action_id, '123456789');
  const missing = getGoogleAdsEventConfig({
    enabled: true,
    customer_id: '5992356722',
    conversion_action_id: '999999999',
    events: {},
  }, 'qualified_lead');
  assert.equal(missing.enabled, false);
  assert.equal(missing.conversion_action_id, null);
  assert.equal(GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS.includes('qualified_lead'), true);
}

async function testControllerAndMigrationContracts() {
  const intakeController = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/intake.controller.js'),
    'utf8'
  );
  assert.match(intakeController, /status_lead === 'cualificado'/);
  assert.match(intakeController, /lead-\$\{lead\.id\}-qualified/);
  assert.match(intakeController, /\['cualificado', 'citado', 'acudio_cita', 'convertido', 'descartado'\][\s\S]*\? lead\.status_lead[\s\S]*: 'contactado'/);
  assert.match(intakeController, /linkedAppointment\.update\(\{[\s\S]*lead_intake_id: leadId/);
  assert.match(intakeController, /uploadScheduleForLinkedAppointment\(\{/);

  const appointmentController = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/citas.controller.js'),
    'utf8'
  );
  const qualifiedIndex = appointmentController.indexOf('await ensureQualifiedLeadConversion({');
  const scheduleIndex = appointmentController.indexOf('await uploadScheduleForLinkedAppointment({');
  assert.ok(qualifiedIndex > 0 && scheduleIndex > qualifiedIndex);

  const migration = require('../../../migrations/20260712123000-add-qualified-lead-status');
  assert.equal(typeof migration.up, 'function');
  assert.equal(typeof migration.down, 'function');
  const calls = [];
  const queryInterface = {
    changeColumn: async (...args) => calls.push(['changeColumn', ...args]),
    sequelize: { query: async (sql) => calls.push(['query', sql]) },
  };
  const Sequelize = { ENUM: (...values) => ({ values }) };
  await migration.up(queryInterface, Sequelize);
  assert.equal(calls[0][3].type.values.includes('cualificado'), true);
  await migration.down(queryInterface, Sequelize);
  assert.match(calls[1][1], /SET `status_lead` = 'info_recibida'/);
  assert.equal(calls[2][3].type.values.includes('cualificado'), false);
}

async function run() {
  await testExplicitQualifiedTransitionIsIdempotentAndMinimal();
  await testDirectAppointmentUsesSameQualifiedIdBeforeSchedule();
  await testQualifiedEventCatalogAndEnhancedAllowlist();
  await testControllerAndMigrationContracts();
  console.log('qualified_lead_milestone.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
