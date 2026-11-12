'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const dates = require('../../lib/marketing-template-variables');
const snapshots = require('../../lib/review-care-snapshot');

function load(db = {}, dependencies = {}) {
  return loadDiscoverySource('services/marketingBulkSends.service.js', {
    crypto: require('node:crypto'), sequelize, '../../models': { Sequelize: sequelize, ...db },
    '../lib/phone': { normalizePhoneDigits: value => String(value || '').replace(/\D/g, '') },
    '../lib/marketing-template-variables': dates,
    '../lib/status-catalog': require('../../lib/status-catalog'),
    '../lib/review-request-history': { readReviewRequestHistory: async () => ({ patientIds: new Set(), phoneKeys: new Set() }),
      hasPriorReviewRequest: () => false },
    ...dependencies,
  });
}

test('normal contact import remains ready without a care date and reports row-level unusable dates', () => {
  const build = load().__testing.buildItemsFromRows;
  const rows = [
    { Nombre: 'Ficticio uno', Teléfono: '900000001', 'Fecha tratamiento': '05/06/2026' },
    { Nombre: 'Ficticio dos', Teléfono: '900000002', 'Fecha tratamiento': '31/02/2026' },
    { Nombre: 'Ficticio tres', Teléfono: '900000003', 'Fecha tratamiento': '' },
    { Nombre: 'Ficticio cuatro', Teléfono: '900000004', 'Fecha tratamiento': '2099-01-01' },
  ];
  const { items } = build(rows, {}, ['whatsapp']);
  assert.deepEqual(Array.from(items, item => item.status), ['ready', 'ready', 'ready', 'ready']);
  assert.equal(dates.resolveLastAttendedAppointmentDate(items[0]), '05/06/2026');
  assert.equal(items[0].last_visit_at.toISOString().slice(0, 10), '2026-06-05');
  assert.deepEqual(Array.from(items.slice(1), item => dates.resolveLastAttendedAppointmentDate(item)), ['', '', '']);
  assert.deepEqual(Array.from(items.slice(1), item => item.custom_fields.import_care_date.status), ['invalid', 'missing', 'future']);
  assert.equal(items[1].custom_fields.import_care_date.raw, '31/02/2026');
});

test('one explicit format/mapping applies to all rows and opting out never silently re-infers care', () => {
  const build = load().__testing.buildItemsFromRows;
  const row = { Nombre: 'Persona ficticia', Teléfono: '900000001', 'Fecha tratamiento': '05/06/2026' };
  const [mdy] = build([row], { import_date_format: 'mdy' }, ['whatsapp']).items;
  assert.equal(dates.resolveLastAttendedAppointmentDate(mdy), '06/05/2026');
  const [unmapped] = build([row], { column_mapping: { last_visit_at: '' } }, ['whatsapp']).items;
  assert.equal(unmapped.status, 'ready');
  assert.equal(unmapped.custom_fields.fecha_tratamiento, '05/06/2026', 'original column is retained');
  assert.equal(dates.resolveLastAttendedAppointmentDate(unmapped), '', 'retained raw columns are not care evidence');
  const [birth] = build([{ Nombre: 'Ficticio', Teléfono: '900000001', 'Fecha nacimiento': '05/06/2000' }],
    { column_mapping: { last_visit_at: 'Fecha nacimiento' } }, ['whatsapp']).items;
  assert.equal(dates.resolveLastAttendedAppointmentDate(birth), '');
});

test('an imported field cannot create a server-owned care snapshot, including an explicit schema key', () => {
  const build = load().__testing.buildItemsFromRows;
  const row = { Nombre: 'Ficticio', Teléfono: '900000001', review_care_v1: '{"date":"2026-01-01"}', Datos: 'malicious' };
  for (const body of [{}, { custom_fields_schema: [{ key: 'review_care_v1', source_column: 'Datos' }] }]) {
    const [item] = build([row], body, ['whatsapp']).items;
    assert.equal(snapshots.hasCareSnapshot(item), false);
  }
});

test('generic serialization and cloning omit the protected snapshot while an authorized review preview resolves its date', () => {
  const service = load().__testing;
  const item = { paciente_id: 31, clinica_id: 56, custom_fields: { nombre: 'Ficticio' }, status: 'ready' };
  item.custom_fields.review_care_v1 = snapshots.sealCareSnapshot({ item, actorId: 9, care: {
    patientId: 31, clinicId: 56, latestCare: { date: '2026-09-10', kind: 'performed_service_import', provenance: [] } } });
  const row = { ...snapshots.bindCareSnapshot(item, 98), list_id: 98 };
  assert.equal(service.serializeItem(row).custom_fields.review_care_v1, undefined);
  assert.equal(service.serializeItem(row).custom_fields.fecha_ultima_cita_asistida, undefined);
  assert.equal(service.serializeItem(row, { allowReviewCare: true }).custom_fields.fecha_ultima_cita_asistida, '10/09/2026');
  assert.equal(service.cloneRecipientItemForCampaign(row, ['whatsapp']).custom_fields.review_care_v1, undefined);
});

test('manual group audiences keep each patient-clinic pair separate for fields and appointments', async () => {
  const db = {
    sequelize: { query: async sql => sql.includes('FROM Pacientes p') ? [56, 57].map(clinicId => ({ id_paciente: 41,
      clinica_id: 56, review_clinica_id: clinicId, nombre: 'Paciente ficticio', telefono_movil: '900000001', review_clinica_nombre: `Ficticia ${clinicId}` }))
      : [{ paciente_id: 41, clinica_id: 57, inicio: '2026-11-01T10:00:00Z' }] },
    PatientCustomField: { findAll: async () => [
      { paciente_id: 41, clinica_id: 56, field_key: 'fecha_ultima_cita_asistida', value: '05/09/2026' },
      { paciente_id: 41, clinica_id: 57, field_key: 'fecha_ultima_cita_asistida', value: '08/08/2026' },
    ] },
    CitaPaciente: { findAll: async () => [] },
  };
  const items = await load(db).__testing.buildItemsForReviewRequest({ scope: 'group', clinicIds: [56, 57] },
    { review_source: 'manual_selection', review_exclusion_rules: { no_visit_date: true } });
  assert.equal(items.length, 2);
  assert.equal(dates.resolveLastAttendedAppointmentDate(items.find(item => item.clinica_id === 56)), '05/09/2026');
  assert.equal(dates.resolveLastAttendedAppointmentDate(items.find(item => item.clinica_id === 57)), '01/11/2026');
});

test('summary controller derives clinical authority from its server request, never query or body', async () => {
  const authority = { actorId: 7, authorize: async () => ({ actorId: 7, sessionRef: 'fictitious-session' }) };
  let observed;
  const controller = loadDiscoverySource('controllers/marketingBulkSends.controller.js', {
    '../lib/clinicScope': { resolveClinicScope: async () => ({ clinicIds: [56], scope: 'clinic', isValid: true }) },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async () => true },
    '../services/reviewCareAccess.service': { current: () => ({ httpAuthority: req => {
      assert.equal(req.headers.authorization, 'Bearer fictitious'); return authority;
    } }) },
    '../services/marketingBulkSends.service': { getReviewRequestSummary: async scope => { observed = scope; return { success: true, summary: {} }; } },
  });
  let response;
  const res = { set: () => res, status: () => res, json: payload => { response = payload; return res; } };
  await controller.getReviewRequestSummary({ query: { clinicId: '56', reviewCareAuthority: { actorId: 99 } },
    body: { reviewCareAuthority: { actorId: 99 } }, userData: { userId: 7 }, headers: { authorization: 'Bearer fictitious' } }, res);
  assert.equal(observed.reviewCareAuthority.actorId, authority.actorId);
  assert.equal(observed.reviewCareAuthority.authorize, authority.authorize);
  assert.equal(typeof observed.reviewCareAuthority.auditRead, 'function');
  assert.equal(response.scope.reviewCareAuthority, undefined);
});
