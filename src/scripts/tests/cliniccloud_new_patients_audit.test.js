'use strict';
// Entirely synthetic, no database, real exports, application boot or messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const auditCore = require('../../lib/cliniccloud-import/new-patients-audit');
const apply = require('../../lib/cliniccloud-import/new-patients-apply');

function fixture(count = 1) {
  const contacts = Array.from({ length: count }, (_, i) => ({ source_row: i + 2, values: {
    IDCONTACTO: String(8000000 + i), NUM: String(90000 + i), NOMBRE: `Persona${String(i).repeat(3)}`,
    APELLIDOS: `Prueba${hash(String(i)).slice(0, 12)}`, 'TELF. MOVIL': String(600100000 + i), EMAIL: `${i}@example.invalid`,
    'F. NACIMIENTO': '02/01/1980', ALTA: '08-09-2026 10:00:00', ESTADO: 'ACTIVO', WHATSAPP: 'true', ALERGIAS: 'NEVER_IMPORT_THIS',
  } }));
  const appointments = contacts.map((row, i) => ({ source_row: i + 2, values: { IDCONTACTO: row.values.IDCONTACTO,
    FECHA: '09/09/2026', SERVICIOS: 'Servicio de prueba', 'TIPO SERVICIO': 'ESTETICA', ESTADO: 'Pagada', 'PAGADO CITA': '0' } }));
  const sources = Object.fromEntries(['contacts', 'appointments', 'historic_contacts', 'historic_types'].map(role => [role, {
    file: { role, sha256: hash(`synthetic-${role}`) }, rows: role === 'contacts' ? contacts : role === 'appointments' ? appointments
      : role === 'historic_types' ? [{ values: { idTipoServicio: '90521', nombre: 'ESTETICA' } }, { values: { idTipoServicio: '260902', nombre: 'CAPILAR' } }] : [],
  }]));
  const live = { group_id: 29, database_group_id: 29, clinic_ids: [66, 72], patients: [], source_links: [] };
  const build = () => auditCore.buildNewPatientsAudit({ sources, live, coverage: { start: '2026-08-01', end: '2026-12-31' }, contactsAsOf: '2026-09-13' });
  const review = audit => ({ source_audit_sha256: audit.plan_sha256, prepared_by: 'offline-test-operator',
    decisions: audit.rows.filter(row => row.status === 'safe_candidate_for_reviewed_creation').map(row => ({
      source_contact_id: row.source_contact_id, disposition: 'retain', reason: 'Synthetic identity, creation and source-clinic proof checked.' })) });
  return { sources, live, contacts, appointments, build, review };
}

test('latest explicitly dated source prepares a new patient with source proof and no clinical/consent fields', () => {
  const f = fixture(), audit = f.build();
  assert.equal(audit.summary.actions.safe_candidate_for_reviewed_creation, 1);
  const pkg = apply.prepareNewPatients({ audit, sources: f.sources, review: f.review(audit), live: f.live });
  assert.equal(pkg.operations.length, 1);
  assert.equal(pkg.operations[0].payload.clinica_id, 72);
  assert.equal(pkg.operations[0].source_created.utc, '2026-09-08T08:00:00.000Z');
  assert.equal(pkg.operations[0].primary_rule, 'oldest_paid_treatment');
  assert.equal(pkg.operations[0].primary_evidence[0].payment_evidence_kind, 'literal_export_state_pagada_not_money');
  assert.doesNotMatch(JSON.stringify(pkg), /WHATSAPP|NEVER_IMPORT_THIS/);
});

test('v1 date bounds stay unchanged and v2 requires an explicit valid source window', () => {
  assert.throws(() => apply.sourceCreated({ ALTA: '08-09-2026 10:00:00' }), /COVERAGE/);
  for (const input of [{}, { coverage: { start: '2026-08-01', end: '2026-12-31' }, contacts_as_of: '2027-01-01' },
    { coverage: { start: '2026-08-01', end: '2026-02-31' }, contacts_as_of: '2026-09-13' },
    { coverage: { start: '2020-01-01', end: '2026-12-31' }, contacts_as_of: '2026-09-13' }]) {
    assert.throws(() => auditCore.sourceWindow(input), /COVERAGE_INVALID/);
  }
});

test('existing IDs, reused history numbers, old creations, invalid births and absent evidence are deferred', () => {
  for (const change of [
    f => { f.live.source_links.push({ paciente_id: 1, source_contact_id: '8000000' }); },
    f => { f.live.source_links.push({ paciente_id: 1, source_contact_id: 'different', history_number: '90000' }); },
    f => { f.contacts[0].values.ALTA = '20-07-2026 10:00:00'; },
    f => { f.contacts[0].values['F. NACIMIENTO'] = '10/09/2026'; },
    f => { f.contacts[0].values['F. NACIMIENTO'] = '31/02/1980'; },
    f => { f.sources.appointments.rows = []; },
    f => { f.appointments[0].values.FECHA = '07/09/2026'; },
  ]) {
    const f = fixture(); change(f); assert.equal(f.build().summary.actions.safe_candidate_for_reviewed_creation || 0, 0);
  }
});

test('paid clinic wins over oldest registered treatment and memberships retain both clinics', () => {
  const f = fixture(); f.appointments[0].values.ESTADO = 'Pendiente';
  f.appointments.push({ source_row: 3, values: { ...f.appointments[0].values, FECHA: '10/09/2026', ESTADO: 'Pagada', 'TIPO SERVICIO': 'CAPILAR' } });
  const row = f.build().rows[0];
  assert.equal(row.proposed_primary_clinic_id, 66); assert.equal(row.primary_rule, 'oldest_paid_treatment');
  assert.deepEqual(row.membership_clinic_ids, [66, 72]);
});

test('an earlier unknown paid area or an oldest-clinic tie cannot choose a default clinic', () => {
  const f = fixture(); f.appointments.push({ source_row: 3, values: { ...f.appointments[0].values, 'TIPO SERVICIO': 'UNKNOWN' } });
  assert(f.build().rows[0].reasons.includes('EARLIER_OR_PAID_TREATMENT_HAS_AMBIGUOUS_CLINIC'));
  f.appointments[1].values['TIPO SERVICIO'] = 'CAPILAR';
  assert(f.build().rows[0].reasons.includes('OLDEST_TREATMENT_CLINIC_TIE'));
});

test('shared phone and conservative name variants defer, never merge or create', () => {
  const f = fixture(); f.live.patients.push({ id_paciente: 1, nombre: 'Unrelated', apellidos: 'Person', telefono_movil: '600100000' });
  assert.equal(f.build().rows[0].status, 'defer');
  f.live.patients = [{ id_paciente: 1, nombre: 'Ana', apellidos: 'Garcia Martinez' }];
  f.contacts[0].values.NOMBRE = 'Ana Maria'; f.contacts[0].values.APELLIDOS = 'Garcia Martinez';
  assert(f.build().rows[0].reasons.includes('POSSIBLE_NAME_VARIANT_REQUIRES_REVIEW'));
  assert(auditCore.nearName('ANA GARCIA MARTINEZ', 'ANA GARCIA MARTINES'));
  assert(!auditCore.nearName('ANA GARCIA MARTINEZ', 'ELENA GOMEZ SANCHEZ'));
});

test('a name variant appearing after the audit is rejected during live preparation', () => {
  const f = fixture(); f.contacts[0].values.NOMBRE = 'Ana Maria'; f.contacts[0].values.APELLIDOS = 'Garcia Martinez';
  const audit = f.build(); f.live.patients.push({ id_paciente: 1, nombre: 'Ana', apellidos: 'Garcia Martinez' });
  assert.throws(() => apply.prepareNewPatients({ audit, sources: f.sources, review: f.review(audit), live: f.live }), /LOCAL_NAME_VARIANT/);
});

test('writer recomputes primary clinic from the source and rejects a rehashed false assignment', () => {
  const f = fixture(), audit = f.build();
  audit.rows[0].proposed_primary_clinic_id = 66; audit.rows[0].membership_clinic_ids = [66];
  const { plan_sha256, ...body } = audit; audit.plan_sha256 = hash(body);
  assert.throws(() => apply.operationsFromAudit(audit, f.sources), /SOURCE_PROOF_MISMATCH/);
});

test('all four exact source files are bound and incomplete manifests cannot reach application', () => {
  const f = fixture(), audit = f.build(); audit.manifest.source_files.pop();
  const { plan_sha256, ...body } = audit; audit.plan_sha256 = hash(body);
  assert.throws(() => apply.operationsFromAudit(audit, f.sources), /MANIFEST_INCOMPLETE/);
});

test('an audit is bounded to 70 creations; further safe people wait for a fresh batch', () => {
  const f = fixture(75), audit = f.build();
  assert.equal(audit.summary.actions.safe_candidate_for_reviewed_creation, 70);
  assert.equal(audit.summary.actions.ready_for_next_batch, 5);
  assert.equal(apply.prepareNewPatients({ audit, sources: f.sources, review: f.review(audit), live: f.live }).operations.length, 70);
});
test('CLI requires actual operator evidence for v2 while retaining the v1 peer requirement', () => {
  const { validateReviewEvidence, loadSources } = require('../cliniccloud-import-new-patients-apply');
  const current = { manifest: { version: auditCore.VERSION } };
  assert.throws(() => validateReviewEvidence({}, '/unused', current), /IDENTITY_REVIEW_METHOD_REQUIRED/);
  const review = { review_method: 'deterministic_source_and_live_identity_checks', peer_evidence: [{ file: 'not-an-operator.json' }] };
  assert.throws(() => validateReviewEvidence(review, '/unused', current), /OPERATOR_REVIEW_EVIDENCE_REQUIRED/);
  assert.throws(() => validateReviewEvidence({ operator_evidence: [] }, '/unused'), /PEER_REVIEW_EVIDENCE_REQUIRED/);
  review.operator_evidence = [{ file: '../escape.json' }];
  assert.throws(() => validateReviewEvidence(review, '/unused', current), /OPERATOR_REVIEW_EVIDENCE_PATH_INVALID/);
  assert.throws(() => loadSources({ '--source-dir': '/unused', '--contacts-csv': '../escape.csv' }), /SOURCE_FILENAME_MUST_BE_BASENAME/);
});
