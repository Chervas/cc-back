'use strict';

const assert = require('node:assert/strict');

const db = require('../../../models');
const service = require('../../services/marketingBulkSends.service');
const controller = require('../../controllers/marketingBulkSends.controller');

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

async function main() {
  const { mapReviewItemsFromImportedList, parseReviewImportListId } = service.__testing;

  assert.equal(parseReviewImportListId({ review_import_list_id: '42' }), 42);
  assert.equal(parseReviewImportListId({ reviewImportListId: 17 }), 17);
  assert.equal(parseReviewImportListId({ review_import_list_id: 'invalid' }), null);

  const rows = [
    {
      paciente_id: 10,
      clinica_id: 66,
      name: 'Paciente con cita futura',
      phone: '+34611111111',
      status: 'excluded_future_appointment',
      exclusion_reason: 'cita_futura',
      selected: false,
      last_visit_at: '2026-06-01T10:00:00.000Z',
      custom_fields: { origen: 'csv' },
    },
    {
      paciente_id: 11,
      clinica_id: 66,
      name: 'Paciente sin teléfono',
      phone: null,
      status: 'excluded_invalid_phone',
      exclusion_reason: 'telefono_invalido',
      selected: false,
      last_visit_at: '2026-07-01T10:00:00.000Z',
    },
    {
      paciente_id: 12,
      clinica_id: 66,
      name: 'Paciente ya solicitado',
      phone: '+34633333333',
      status: 'ready',
      selected: true,
      last_visit_at: '2026-08-01T10:00:00.000Z',
    },
    {
      paciente_id: 13,
      clinica_id: 66,
      name: 'Paciente con baja comercial',
      phone: '+34644444444',
      status: 'excluded_opt_out',
      exclusion_reason: 'opt_out',
      selected: false,
      last_visit_at: '2026-07-15T10:00:00.000Z',
    },
  ];

  const items = mapReviewItemsFromImportedList(
    rows,
    { clinica_id: 66 },
    new Set([12]),
  );
  const futureAppointment = items.find((item) => item.paciente_id === 10);
  const invalidPhone = items.find((item) => item.paciente_id === 11);
  const alreadyRequested = items.find((item) => item.paciente_id === 12);
  const optedOut = items.find((item) => item.paciente_id === 13);

  assert.equal(futureAppointment.status, 'ready', 'una cita futura no excluye de una reseña');
  assert.equal(futureAppointment.selected, true);
  assert.equal(futureAppointment.custom_fields.origen, 'csv');
  assert.equal(invalidPhone.status, 'excluded_invalid_phone');
  assert.equal(invalidPhone.selected, false);
  assert.equal(alreadyRequested.status, 'excluded_review_already_requested');
  assert.equal(alreadyRequested.exclusion_reason, 'solicitud_previa');
  assert.equal(alreadyRequested.selected, false);
  assert.equal(optedOut.status, 'excluded_opt_out');
  assert.equal(optedOut.selected, false);

  const manuallyExcluded = mapReviewItemsFromImportedList(
    [rows[0]],
    { clinica_id: 66 },
    new Set(),
    { excluded_review_patient_ids: [10] },
  );
  assert.equal(manuallyExcluded[0].status, 'excluded_manual');

  const originalSummary = service.getReviewRequestSummary;
  let forwardedOptions = null;
  try {
    service.getReviewRequestSummary = async (_scope, options) => {
      forwardedOptions = options;
      return { success: true, summary: { possible_patients: 1 } };
    };
    const response = responseRecorder();
    await controller.getReviewRequestSummary({
      query: { clinicId: '66', review_import_list_id: '42' },
      userData: { userId: 7 },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(forwardedOptions.review_import_list_id, '42');
  } finally {
    service.getReviewRequestSummary = originalSummary;
  }

  console.log('marketing_review_imported_list.test.js: OK');
}

(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  try {
    await db.sequelize.close();
  } catch (error) {
    console.error('No se pudo cerrar Sequelize tras la prueba:', error);
    exitCode = 1;
  }
  process.exit(exitCode);
})();
