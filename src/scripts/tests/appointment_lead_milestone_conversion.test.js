'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isTreatmentAppointment,
  maybeUploadCompletedTreatmentConversion,
  processAppointmentLeadMilestones,
  reliableBasePrice,
  syncLeadStatusFromAppointments,
} = require('../../services/appointmentLeadMilestone.service');

function leadFixture(overrides = {}) {
  const lead = {
    id: 7180,
    clinica_id: 56,
    grupo_clinica_id: 5,
    status_lead: 'citado',
    call_outcome_appointment_id: 90,
    gclid: 'opaque-click-id',
    consentimiento_canal: { ad_user_data: 'granted' },
    ...overrides,
  };
  lead.updates = [];
  lead.update = async (values) => {
    lead.updates.push(values);
    Object.assign(lead, values);
    return lead;
  };
  return lead;
}

function statusDependencies(lead, citas, counters = {}) {
  return {
    LeadIntake: {
      async findByPk(id) {
        counters.leadReads = (counters.leadReads || 0) + 1;
        return Number(id) === Number(lead.id) ? lead : null;
      },
    },
    CitaPaciente: {
      async findAll(query) {
        counters.appointmentReads = (counters.appointmentReads || 0) + 1;
        assert.deepEqual(query.attributes, ['id_cita', 'estado', 'inicio', 'tratamiento_id', 'tipo_cita']);
        return citas;
      },
    },
  };
}

async function testLeadStatusMilestones() {
  const attendedLead = leadFixture();
  await syncLeadStatusFromAppointments(attendedLead.id, statusDependencies(attendedLead, [{
    id_cita: 101,
    estado: 'completada',
    tratamiento_id: null,
    tipo_cita: 'primera_sin_trat',
  }]));
  assert.equal(attendedLead.status_lead, 'acudio_cita');
  assert.equal(attendedLead.call_outcome_appointment_id, 101);

  const convertedByTreatmentId = leadFixture();
  await syncLeadStatusFromAppointments(convertedByTreatmentId.id, statusDependencies(convertedByTreatmentId, [{
    id_cita: 102,
    estado: 'completada',
    tratamiento_id: 7,
    tipo_cita: 'continuacion',
  }]));
  assert.equal(convertedByTreatmentId.status_lead, 'convertido');
  assert.equal(convertedByTreatmentId.call_outcome_appointment_id, 102);

  const convertedByType = leadFixture({ status_lead: 'acudio_cita' });
  await syncLeadStatusFromAppointments(convertedByType.id, statusDependencies(convertedByType, [{
    id_cita: 103,
    estado: 'completada',
    tratamiento_id: null,
    tipo_cita: 'primera_con_trat',
  }]));
  assert.equal(convertedByType.status_lead, 'convertido');

  const attendedIsNotDegraded = leadFixture({ status_lead: 'acudio_cita', call_outcome_appointment_id: 104 });
  await syncLeadStatusFromAppointments(attendedIsNotDegraded.id, statusDependencies(attendedIsNotDegraded, [{
    id_cita: 105,
    estado: 'pendiente',
    tratamiento_id: null,
    tipo_cita: 'primera_sin_trat',
  }]));
  assert.equal(attendedIsNotDegraded.status_lead, 'acudio_cita');
  assert.equal(attendedIsNotDegraded.call_outcome_appointment_id, 104);

  const activeLead = leadFixture({ status_lead: 'info_recibida', call_outcome_appointment_id: null });
  await syncLeadStatusFromAppointments(activeLead.id, statusDependencies(activeLead, [{
    id_cita: 106,
    estado: 'recordatorio_confirmado',
    tratamiento_id: null,
    tipo_cita: 'primera_sin_trat',
  }]));
  assert.equal(activeLead.status_lead, 'citado');
  assert.equal(activeLead.call_outcome_appointment_id, 106);

  const noAppointmentLead = leadFixture();
  await syncLeadStatusFromAppointments(noAppointmentLead.id, statusDependencies(noAppointmentLead, []));
  assert.equal(noAppointmentLead.status_lead, 'info_recibida');
  assert.equal(noAppointmentLead.call_outcome_appointment_id, null);
}

async function testTerminalLeadStatusesArePreserved() {
  for (const status of ['convertido', 'descartado']) {
    const counters = {};
    const lead = leadFixture({ status_lead: status });
    await syncLeadStatusFromAppointments(lead.id, statusDependencies(lead, [{
      id_cita: 200,
      estado: 'pendiente',
    }], counters));
    assert.equal(lead.status_lead, status);
    assert.equal(lead.updates.length, 0);
    assert.equal(counters.appointmentReads || 0, 0);
  }
}

async function testPurchasePayloadAndValue() {
  const lead = leadFixture();
  let uploadInput = null;
  const result = await maybeUploadCompletedTreatmentConversion({
    cita: {
      id_cita: 301,
      clinica_id: 56,
      lead_intake_id: lead.id,
      tratamiento_id: 77,
      tipo_cita: 'continuacion',
      estado: 'completada',
      updated_at: new Date('2026-07-12T12:00:00Z'),
    },
    previousStatus: 'recordatorio_confirmado',
    dependencies: {
      LeadIntake: { findByPk: async () => lead },
      Tratamiento: {
        findByPk: async (id, query) => {
          assert.equal(id, 77);
          assert.deepEqual(query.attributes, ['id_tratamiento', 'precio_base']);
          return { id_tratamiento: 77, precio_base: '1250.499' };
        },
      },
      maybeUploadLeadLifecycleConversion: async (input) => {
        uploadInput = input;
        return { sent: true };
      },
    },
  });

  assert.equal(result.sent, true);
  assert.equal(uploadInput.eventName, 'purchase');
  assert.equal(uploadInput.eventId, 'appointment-301-treatment-completed');
  assert.equal(uploadInput.clinicId, 56);
  assert.equal(uploadInput.value, 1250.5);
  assert.equal(uploadInput.valueProvenance, 'treatment_base_price');
  assert.equal(uploadInput.valueIsFallback, true);
  assert.equal(uploadInput.currency, 'EUR');
  assert.equal(uploadInput.occurredAt.toISOString(), '2026-07-12T12:00:00.000Z');
  assert.equal(Object.hasOwn(uploadInput, 'customData'), false);
  assert.equal(JSON.stringify(uploadInput).includes('tratamiento'), false);
}

async function testPurchaseGuardsAndZeroFallback() {
  const lead = leadFixture();
  let uploadCalls = 0;
  const upload = async (input) => {
    uploadCalls += 1;
    return { sent: true, input };
  };
  const baseDependencies = {
    LeadIntake: { findByPk: async () => lead },
    maybeUploadLeadLifecycleConversion: upload,
  };

  const repeated = await maybeUploadCompletedTreatmentConversion({
    cita: {
      id_cita: 302,
      clinica_id: 56,
      lead_intake_id: lead.id,
      tratamiento_id: 77,
      estado: 'completada',
    },
    previousStatus: 'completada',
    dependencies: baseDependencies,
  });
  assert.equal(repeated.reason, 'first_completed_transition_required');

  const noTreatment = await maybeUploadCompletedTreatmentConversion({
    cita: {
      id_cita: 303,
      clinica_id: 56,
      lead_intake_id: lead.id,
      tratamiento_id: null,
      tipo_cita: 'primera_sin_trat',
      estado: 'completada',
    },
    previousStatus: 'pendiente',
    dependencies: baseDependencies,
  });
  assert.equal(noTreatment.reason, 'completed_treatment_required');

  const outsideLead = leadFixture({ grupo_clinica_id: 9 });
  const outside = await maybeUploadCompletedTreatmentConversion({
    cita: {
      id_cita: 304,
      clinica_id: 999,
      lead_intake_id: outsideLead.id,
      tratamiento_id: 77,
      estado: 'completada',
    },
    previousStatus: 'pendiente',
    dependencies: {
      ...baseDependencies,
      LeadIntake: { findByPk: async () => outsideLead },
    },
  });
  assert.equal(outside.reason, 'outside_propdental_scope');
  assert.equal(uploadCalls, 0);

  let zeroValueInput = null;
  await maybeUploadCompletedTreatmentConversion({
    cita: {
      id_cita: 305,
      clinica_id: 56,
      lead_intake_id: lead.id,
      tratamiento_id: null,
      tipo_cita: 'primera_con_trat',
      estado: 'completada',
    },
    previousStatus: 'pendiente',
    dependencies: {
      LeadIntake: { findByPk: async () => lead },
      maybeUploadLeadLifecycleConversion: async (input) => {
        zeroValueInput = input;
        return { sent: true };
      },
    },
  });
  assert.equal(zeroValueInput.value, 0);
  assert.equal(uploadCalls, 0);

  assert.equal(reliableBasePrice('not-a-price'), 0);
  assert.equal(reliableBasePrice(-10), 0);
  assert.equal(isTreatmentAppointment({ tratamiento_id: null, tipo_cita: 'primera_con_trat' }), true);
}

async function testProcessIsNonBlockingForProviderFailures() {
  const lead = leadFixture();
  const warnings = [];
  const result = await processAppointmentLeadMilestones({
    cita: {
      id_cita: 401,
      clinica_id: 56,
      lead_intake_id: lead.id,
      tratamiento_id: 77,
      tipo_cita: 'continuacion',
      estado: 'completada',
    },
    previousStatus: 'pendiente',
    dependencies: {
      ...statusDependencies(lead, [{
        id_cita: 401,
        estado: 'completada',
        tratamiento_id: 77,
        tipo_cita: 'continuacion',
      }]),
      Tratamiento: { findByPk: async () => ({ id_tratamiento: 77, precio_base: 200 }) },
      maybeUploadLeadLifecycleConversion: async () => {
        const error = new Error('provider unavailable');
        error.code = 'PROVIDER_UNAVAILABLE';
        throw error;
      },
      logger: { warn: (...args) => warnings.push(args) },
    },
  });
  assert.equal(lead.status_lead, 'convertido');
  assert.equal(result.conversion.reason, 'conversion_upload_failed');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('PROVIDER_UNAVAILABLE'), true);
}

function testControllerUsesCommonHelperForEveryCompletionWritePath() {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/citas.controller.js'),
    'utf8'
  );
  assert.match(
    controller,
    /const\s*\{[^}]*processAppointmentLeadMilestones[^}]*\}\s*=\s*require\('\.\.\/services\/appointmentLeadMilestone\.service'\);/
  );
  assert.match(controller, /if \(estadoRaw === 'completada'\) \{\s*await processAppointmentLeadMilestones\(\{\s*cita,\s*previousStatus: null,/s);
  assert.match(controller, /if \(!\['convertido', 'descartado', 'acudio_cita'\]\.includes\(currentLeadStatus\)\) \{\s*const leadUpdatePayload = \{\s*status_lead: 'citado'/s);

  const updateSection = controller.slice(
    controller.indexOf('exports.updateCitaEstado ='),
    controller.indexOf('exports.reagendarCita =')
  );
  assert.match(updateSection, /const previousStatus = cita\.estado;[\s\S]*await cita\.save\(\);[\s\S]*processAppointmentLeadMilestones\(\{ cita, previousStatus \}\)/);

  const rescheduleSection = controller.slice(controller.indexOf('exports.reagendarCita ='));
  assert.match(rescheduleSection, /const previousStatus = cita\.estado;[\s\S]*await cita\.save\(\);[\s\S]*processAppointmentLeadMilestones\(\{ cita, previousStatus \}\)/);
}

async function run() {
  await testLeadStatusMilestones();
  await testTerminalLeadStatusesArePreserved();
  await testPurchasePayloadAndValue();
  await testPurchaseGuardsAndZeroFallback();
  await testProcessIsNonBlockingForProviderFailures();
  testControllerUsesCommonHelperForEveryCompletionWritePath();
  console.log('appointment_lead_milestone_conversion.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
