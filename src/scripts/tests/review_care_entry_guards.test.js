'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { createReviewCareContext } = require('../../services/reviewCareContext.service');
const dates = require('../../lib/marketing-template-variables');
const snapshots = require('../../lib/review-care-snapshot');

function reactivationFixture(record) {
  const state = { itemReads: 0 };
  const row = { id: 3, list_id: 98, paciente_id: 11, clinica_id: 1, name: 'Ficticio',
    status: 'ready', custom_fields: { nombre: 'Ficticio', [snapshots.KEY]: { date: '2026-09-10',
      provenance: [{ sourceRecordId: '90071992547409931' }] } } };
  const service = loadDiscoverySource('services/marketingReactivation.service.js', {
    sequelize, crypto: require('node:crypto'),
    '../../models': { MarketingPatientList: { findByPk: async () => record },
      MarketingPatientListItem: { findAll: async () => { state.itemReads++; return [row]; } } },
    '../lib/phone': { normalizePhoneDigits: String },
    '../lib/marketing-template-variables': dates,
  });
  return { state, service, row, scope: { scope: 'clinic', clinicIds: [1] } };
}

test('reactivation GET list/items rejects another objective or a protected review flag before reading recipients', async () => {
  for (const record of [
    { id: 98, clinica_id: 1, objective_id: 'mass_sends', criteria: {} },
    { id: 98, clinica_id: 1, objective_id: 'reactivate_patients', criteria: { review_care_version: 1 } },
    { id: 98, clinica_id: 1, criteria: { review_care_version: 1 } },
  ]) {
    const { service, scope, state } = reactivationFixture(record);
    await assert.rejects(service.getList(scope, 98), error => error.status === 404);
    await assert.rejects(service.getItems(scope, 98), error => error.status === 404);
    assert.equal(state.itemReads, 0);
  }
});

test('reactivation generic serialization strips snapshot residue even on a legitimate legacy list', async () => {
  const { service, scope, row } = reactivationFixture({ id: 98, clinica_id: 1,
    objective_id: 'reactivate_patients', criteria: {}, counters: {}, metrics: {}, safety_gates: {} });
  for (const output of [await service.getList(scope, 98), await service.getItems(scope, 98)]) {
    assert.equal(output.items[0].custom_fields[snapshots.KEY], undefined);
    assert.equal(output.items[0].custom_fields.fecha_ultima_cita_asistida, undefined);
    assert.equal(output.items[0].custom_fields.nombre, 'Ficticio');
    assert(!JSON.stringify(output).includes('90071992547409931'));
  }
  assert.equal(row.custom_fields[snapshots.KEY].date, '2026-09-10', 'serialization does not mutate stored evidence');
});

function reviewFixture() {
  const at = '2026-09-10T10:00:00.000Z';
  const patient = { id_paciente: 11, clinica_id: 1, nombre: 'Ficticio', apellidos: 'Paciente',
    telefono_movil: '900000001', email: 'testonly@example.invalid' };
  const appointment = { id_cita: 71, paciente_id: 11, clinica_id: 1, tratamiento_id: 3,
    estado: 'completada', inicio: at, care_schedule_start: at, arrived_at: at, care_started_at: at,
    care_completed_at: at, paciente: patient, clinica: { nombre_clinica: 'Clínica ficticia' } };
  const state = { allowed: true, held: false, authorityCalls: [], holdReads: 0, careReads: 0 };
  const db = { Sequelize: sequelize,
    sequelize: { async query(sql, options) {
      if (sql.startsWith('SELECT patient_id FROM PatientImportedIdentities')) {
        state.holdReads++; assert.equal(options.logging, false);
        return state.held ? [{ patient_id: 11 }] : [];
      }
      if (sql.includes('FROM Pacientes p')) return [{ ...patient, review_clinica_id: 1,
        review_clinica_nombre: 'Clínica ficticia' }];
      if (sql.includes('FROM CitasPacientes c')) return [];
      throw Error('UNEXPECTED_SOURCE_QUERY_IN_ENTRY_QA');
    } },
    CitaPaciente: { findOne: async () => appointment, findAll: async options => options.group ? [] : [appointment] },
    Clinica: {}, Paciente: {}, PatientCustomField: { findAll: async () => [] },
  };
  const authority = { actorId: 225, async authorize(input) {
    state.authorityCalls.push(input);
    if (!state.allowed) throw Object.assign(Error('FICTITIOUS_REVOKED_CLINICAL_PERMISSION'), { status: 403 });
    return { actorId: 225, sessionRef: 'fictitious-session' };
  } };
  const context = createReviewCareContext({ db, access: { assertPatientPairs: async ({ pairs }) => {
    assert(pairs.every(pair => pair.patientId === 11 && pair.clinicId === 1));
    if (!state.allowed) throw Object.assign(Error('FICTITIOUS_MEMBERSHIP_REVOKED'), { status: 403 });
  } }, createReader: ({ authorize }) => ({ async read(input) {
    state.careReads++;
    await authorize({ clinicId: input.clinicId, phase: 'before' });
    await authorize({ clinicId: input.clinicId, phase: 'after' });
    return { items: input.patientIds.map(patientId => ({ patientId, clinicId: input.clinicId,
      latestCare: { date: '2026-10-01', kind: 'performed_service_import', precision: 'day', provenance: [] } })) };
  } }) });
  const service = loadDiscoverySource('services/marketingBulkSends.service.js', {
    crypto: require('node:crypto'), sequelize, '../../models': db,
    '../lib/phone': { normalizePhoneDigits: value => String(value || '').replace(/\D/g, '') },
    '../lib/marketing-template-variables': dates,
    '../lib/status-catalog': require('../../lib/status-catalog'),
    '../lib/appointment-care': require('../../lib/appointment-care'),
    '../lib/review-request-history': { readReviewRequestHistory: async () => ({ patientIds: new Set(), phoneKeys: new Set() }),
      hasPriorReviewRequest: () => false },
    './reviewCareContext.service': { current: () => context },
  });
  const scope = { scope: 'clinic', clinicIds: [1], reviewCareAuthority: authority };
  return { state, service: service.__testing, scope };
}

const branches = [
  ['manual patient selection', { review_source: 'manual_selection' }],
  ['one completed appointment', { review_source: 'manual_selection', review_appointment_id: 71 }],
  ['completed treatment', { review_source: 'completed_treatment' }],
];
for (const [label, body] of branches) {
  test(`${label} cannot bypass clinical authority before returning a new review audience`, async () => {
    const { service, state, scope } = reviewFixture(); state.allowed = false;
    await assert.rejects(service.buildItemsForReviewRequest(scope, body), error => error.status === 403);
    assert(state.authorityCalls.length > 0);
    assert.equal(state.holdReads, 0, 'denied source projection does not advance to HOLD or return candidate dates');
  });

  test(`${label} reaches common latest-care/HOLD projection without releasing communications`, async () => {
    const { service, state, scope } = reviewFixture(); state.held = true;
    const output = await service.buildItemsForReviewRequest(scope, body);
    assert.equal(state.careReads, 1); assert.equal(state.holdReads, 1);
    assert(state.authorityCalls.length >= 3, 'source and post-HOLD authority rechecks remain active');
    assert.equal(state.held, true);
    assert(output.every(item => item.status === 'excluded_import_hold' && item.selected === false));
    for (const item of output) {
      assert.equal(snapshots.snapshotOf(item).date, '2026-10-01');
      assert.equal(snapshots.snapshotOf(item).importedMessagesHold, true);
    }
  });
}
