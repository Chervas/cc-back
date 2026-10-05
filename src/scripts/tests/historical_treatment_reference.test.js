'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const historical = require('../../lib/historical-treatment-reference');
const commercial = require('../../lib/treatment-commercial-policy');
const contract = require('../../lib/treatment-catalog-contract');
const economics = require('../../lib/economic-commercial-policy');
const programs = require('../../lib/treatmentPrograms.contract');
const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');
const { prepareHistoricalReference } = require('../../services/historicalTreatmentReference.service');
const now = new Date('2026-10-05T00:00:00.000Z');
function row(id = 101) {
  return { id_cita: id, clinica_id: 66, paciente_id: 8, doctor_id: 50, instalacion_id: 75,
    inicio: '2026-10-06T10:00:00.000Z', fin: '2026-10-06T10:30:00.000Z', estado: 'pendiente', tipo_cita: 'continuacion',
    source_system: 'cliniccloud', source_reference: 'delta:cliniccloud-5880:fixture', tratamiento_id: null,
    titulo: 'IM CAPILAR', nota: 'DUTAS', motivo: null, voucher_id: null,
    import_metadata: { source_account: 'cliniccloud-5880', source_appointment_id: String(id + 1000),
      cliniccloud_delta: { source: { kind: 'appointment', source_external_id: String(id + 1000), service_key: 'IM CAPILAR', details: 'DUTAS', agenda_key: 'CAPILARES',
        start_utc: '2026-10-06T10:00:00.000Z', end_utc: '2026-10-06T10:30:00.000Z', provenance: { row_sha256: 'a'.repeat(64) } } },
      booking: { profile: { version: 2, phases: [{ key: 'appointment', duration_minutes: 30, installation_ids: [75], professionals: { ids: [50], mode: 'any', preferred_id: 50 } }] },
        phases: [{ key: 'appointment', installation_id: 75, doctor_ids: [50], start_at: '2026-10-06T10:00:00.000Z', end_at: '2026-10-06T10:30:00.000Z' }] },
      cliniccloud_source_booking: { source_appointment_id: String(id + 1000), policy: 'preserve_source_interval_report_conflicts' } } };
}
function reference(rows = [row()], options = {}) {
  return { id_tratamiento: 900, ...historical.buildHistoricalReferenceValues({ rows, actorId: 7, discipline: 'capilar', now, ...options }) };
}
test('source-derived noncommercial reference has no tariff, clinical phases, duration, activation or approval', () => {
  const source = row(), before = structuredClone(source), value = reference([source]);
  assert.deepEqual(source, before);
  assert.equal(value.precio_base, null); assert.equal(value.activo, false); assert.equal(value.duracion_min, null);
  assert.equal(value.clinical_config.booking_profile, undefined); assert.equal(value.clinical_config.price_profile, undefined);
  assert.equal(value.clinical_config.historical_reference.clinical_approval_inferred, false);
  assert.equal(value.clinical_config.historical_reference.required_clinical_document_review, true);
  assert.match(value.nombre, /LED no documentado/);
  assert.equal(historical.assertReviewedHistoricalTreatment({ treatment: value, row: source }).nonbillable, true);
  assert.deepEqual(value.clinical_config.historical_reference.rows[0].source_appointment_ids, ['1101']);
});
test('arrival/state progress is allowed, but guards do not change source or current reservation', () => {
  const source = row(), value = reference([source]);
  for (const estado of ['confirmada', 'no_asistio', 'completada']) assert.doesNotThrow(() => historical.assertReviewedHistoricalTreatment({ treatment: value,
    row: { ...source, estado, arrived_at: now.toISOString(), care_started_at: now.toISOString(), tratamiento_id: 900, updated_at: now.toISOString() } }));
  const resolved = structuredClone(source); resolved.tratamiento_id = 900; resolved.import_metadata.import_treatment_resolution = { version: 1 };
  assert.doesNotThrow(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: resolved }));
});
test('Sequelize Date/BOOLEAN and captured SQL ISO/TINYINT guards agree; changed Date clock cannot collapse to an empty object', () => {
  const source = row(); source.es_provisional = 0;
  const model = structuredClone(source); model.inicio = new Date(source.inicio); model.fin = new Date(source.fin); model.es_provisional = false;
  const value = reference([model]);
  assert.deepEqual(historical.rowEvidence(source), historical.rowEvidence(model));
  assert.doesNotThrow(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: source }));
  model.inicio = new Date('2026-10-06T10:01:00.000Z');
  assert.throws(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: model }), { code: 'historical_reference_reservation_mismatch' });
});
test('wrong appointment, tenant, source ID, source act, source note, current note, clock, room, staff and economic reference fail closed', () => {
  const value = reference();
  const mutations = [r => { r.id_cita = 102; }, r => { r.clinica_id = 72; }, r => { r.paciente_id = 9; },
    r => { r.import_metadata.source_appointment_id = '8888'; }, r => { r.import_metadata.cliniccloud_delta.source.service_key = 'PRP'; },
    r => { r.import_metadata.cliniccloud_delta.source.details = 'PRP'; }, r => { r.nota = 'PRP'; },
    r => { r.inicio = '2026-10-06T10:01:00.000Z'; }, r => { r.instalacion_id = 83; }, r => { r.doctor_id = 53; },
    r => { r.voucher_id = 2; }, r => { r.tipo_cita = 'primera'; }, r => { r.tratamiento_id = 1999; },
    r => { r.import_metadata.booking.phases[0].doctor_ids = [53]; }, r => { r.import_metadata.booking.profile.phases[0].equipment_requirements = [{ equipment_ids: [15] }]; }];
  for (const mutate of mutations) { const source = row(); mutate(source); assert.throws(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: source })); }
});
test('historical reference is bound to whole parallel source records without inventing a phase split or validated combination', () => {
  const source = row(); source.import_metadata.cliniccloud_delta.source.service_key = 'INDIBA CORPORAL-IM CAPILAR'; source.nota = 'INDIBA MUÑECA Y DUTAS';
  source.import_metadata.cliniccloud_parallel_sources = { source_account: 'cliniccloud-5880', entries: [
    { source_appointment_id: '1102', source: { service_key: 'INDIBA CORPORAL-IM CAPILAR', details: 'INDIBA MUÑECA Y DUTAS' } }] };
  const value = reference([source]); assert.match(value.nombre, /^INDIBA CORPORAL-IM CAPILAR · referencia histórica$/);
  assert.deepEqual(value.clinical_config.historical_reference.rows[0].source_appointment_ids, ['1101', '1102']);
  assert.equal(value.clinical_config.booking_profile, undefined); assert.equal(value.duracion_min, null);
  assert.doesNotThrow(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: source }));
  source.import_metadata.cliniccloud_parallel_sources.entries[0].source.details = 'PRP';
  assert.throws(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: source }), { code: 'historical_reference_reservation_mismatch' });
});
test('generic source acts/brands/quantities stay literal references, not new procedures, premium modalities or commercial products', () => {
  for (const key of ['INDIBA', 'INDIBA-PRP', 'IM CAPILAR', 'EMS 1 ZONA', 'ONDAS ACUSTICAS 1 SESION', '3 ACTOS']) {
    const source = row(); source.import_metadata.cliniccloud_delta.source.service_key = key; source.import_metadata.cliniccloud_delta.source.details = '';
    const value = reference([source]); assert.equal(value.nombre, key + ' · referencia histórica');
    assert.equal(value.precio_base, null); assert.equal(value.clinical_config.historical_reference.required_clinical_document_review, true);
  }
});
test('only existing unclassified ClinicCloud slots of one scope can create a reference; evidence hashes supplied elsewhere are ignored', () => {
  for (const mutate of [r => { r.tratamiento_id = 1999; }, r => { r.source_system = 'native'; }, r => { delete r.import_metadata.booking; },
    r => { r.source_reference = 'native'; }, r => { r.import_metadata.cliniccloud_delta.source.source_external_id = '9999'; }]) {
    const source = row(); mutate(source); assert.throws(() => reference([source]));
  }
  const foreign = row(102); foreign.clinica_id = 72; assert.throws(() => reference([row(), foreign]), { code: 'historical_reference_scope' });
  assert.throws(() => reference([row(), row()]), { code: 'historical_reference_scope' });
  assert.throws(() => reference([row()], { actorId: 0 })); assert.throws(() => reference([row()], { discipline: undefined }), { code: 'historical_reference_discipline_required' });
});
test('catalogue is immutable, nonbookable and explicitly nonbillable rather than free or missing standalone price', async () => {
  const value = reference(), dto = contract.catalogDto(value);
  assert.equal(dto.standalone_sellable, false); assert.equal(dto.catalog_price.amount, null);
  assert.equal(dto.catalog_price.semantics, 'historical_nonbillable'); assert.match(dto.catalog_price.label, /sin tarifa/);
  assert.deepEqual(contract.catalogState(value), { status: 'historical_reference', editable: false, booking_ready: false, booking_issues: ['historical_reference'] });
  assert.throws(() => contract.assertCatalogEditable(value), { code: 'treatment_historical_reference' });
  assert.throws(() => commercial.assertStandalone(value), { code: 'treatment_historical_reference' });
  await validateCatalogResources(value, {});
  for (const patch of [{ precio_base: 0 }, { precio_base: '0.00' }, { activo: true }, { origen: 'grupo' }, { appointment_automation_template_key: 'new-sale' }]) {
    assert.throws(() => historical.validateHistoricalReference({ ...value, ...patch }), { code: 'historical_reference_invalid' });
  }
});
test('ordinary catalogue API cannot manufacture/remove historical evidence or turn a reference into a standalone sellable item', () => {
  const value = reference(), cfg = value.clinical_config;
  for (const incoming of [{ commercial: { sale_mode: 'historical_reference' } }, { catalog_status: 'historical_reference' }, { historical_reference: cfg.historical_reference }]) {
    assert.throws(() => contract.mergeClinicalConfig(null, incoming), { code: 'historical_reference_server_owned' });
  }
  assert.throws(() => commercial.assertNoClientImportEvidence(null, { historical_reference: cfg.historical_reference }), { code: 'historical_reference_server_owned' });
  const merged = contract.mergeClinicalConfig(cfg, { commercial: { sale_mode: 'standalone' }, catalog_status: 'active', historical_reference: null, price_profile: { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21 } });
  assert.deepEqual(merged, cfg);
});
test('catalogue DTO exposes only non-sensitive historical status, never patient/source bindings or reviewer proof', () => {
  const value = reference(), before = structuredClone(value), dto = contract.catalogDto(value);
  assert.deepEqual(value, before);
  assert.deepEqual(dto.clinical_config.historical_reference, { version: historical.VERSION, nonbillable: true,
    required_clinical_document_review: true, clinical_approval_inferred: false });
  for (const key of ['rows', 'source_services', 'source_account', 'reviewed_by', 'reviewed_at', 'binding_sha256']) {
    assert.equal(dto.clinical_config.historical_reference[key], undefined);
  }
  assert.equal(JSON.stringify(dto).includes('source_appointment_ids'), false);
  assert.equal(JSON.stringify(dto).includes('current_note_sha256'), false);
  assert.doesNotThrow(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: row() }));
});
test('a changed reference seal or current source proof cannot pass a reviewed import classification', () => {
  const value = reference(); value.clinical_config.historical_reference.rows[0].current_note_sha256 = 'b'.repeat(64);
  assert.throws(() => historical.assertReviewedHistoricalTreatment({ treatment: value, row: row() }), { code: 'historical_reference_invalid' });
});
test('all new individual, budget, voucher and program commercial aliases reject historical references even with positive client prices', async () => {
  const value = reference(), resolveTreatments = async () => new Map([[900, value]]);
  for (const product_type of ['treatment', 'pack', 'voucher']) for (const reference of [{ treatment_id: 900 }, { catalogoId: 900 }]) for (const unit_price of [0, 90]) {
    await assert.rejects(economics.assertCommercialLines([{ ...reference, product_type, unit_price }], { resolveTreatments, selling: false }), { code: 'treatment_historical_reference' });
  }
  const line = { program_id: 'new-program', program_snapshot: { appointments: [{ treatment_ids: [900], treatments: [{ sale_mode: 'standalone' }] }] } };
  for (const selling of [false, true]) await assert.rejects(economics.assertCommercialLines([line], { resolveTreatments, selling }), { code: 'treatment_historical_reference' });
  const dto = programs.treatmentDto(value); assert.equal(dto.booking_ready, false); assert(dto.issues.some(v => v.code === 'treatment_historical_reference'));
  let reads = 0; await economics.assertCommercialLines([{ treatment_id: 900 }], { historicalPurchase: true, resolveTreatments: () => { reads++; } }); assert.equal(reads, 0);
});
test('care documentation gap is separate from classification and defaults to blocking when malformed', () => {
  const value = reference(); assert.equal(historical.clinicalDocumentReviewRequired(value), true);
  const invalid = structuredClone(value); delete invalid.clinical_config.historical_reference.required_clinical_document_review;
  assert.equal(historical.clinicalDocumentReviewRequired(invalid), true);
  assert.equal(historical.clinicalDocumentReviewRequired({ clinical_config: {} }), false);
});
test('service reads scoped exact server records, locks when called in a transaction and performs zero writes', async () => {
  const ids = [101, 102], symbol = Symbol('in'), transaction = { LOCK: { UPDATE: 'update' } }; let calls = 0;
  const db = { Sequelize: { Op: { in: symbol } }, CitaPaciente: { findAll: async query => { calls++; assert.equal(query.where.clinica_id, 66);
    assert.deepEqual(query.where.id_cita[symbol], ids); assert.equal(query.transaction, transaction); assert.equal(query.lock, 'update'); return ids.map(row); } } };
  const result = await prepareHistoricalReference({ db, appointmentIds: ids, clinicId: 66, actorId: 7, discipline: 'capilar', transaction });
  assert.equal(calls, 1); assert.equal(result.clinical_config.historical_reference.rows.length, 2); assert.equal(result.precio_base, null);
  await assert.rejects(prepareHistoricalReference({ db, appointmentIds: [], clinicId: 66, actorId: 7, discipline: 'capilar' }), { code: 'historical_reference_invalid' });
  db.CitaPaciente.findAll = async () => [row()]; await assert.rejects(prepareHistoricalReference({ db, appointmentIds: ids, clinicId: 66, actorId: 7, discipline: 'capilar' }), { code: 'historical_reference_scope' });
});
