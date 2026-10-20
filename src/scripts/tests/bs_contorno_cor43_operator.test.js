'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const Sequelize = require('sequelize');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const P = require('../../lib/cliniccloud-import/bs-contorno-cor43-closure');
const O = require('../bs-contorno-cor43-closure');
const contract = require('../../lib/treatment-catalog-contract');
const copy = value => JSON.parse(JSON.stringify(value));
const NOW = '2026-10-20T18:01:02.500Z';
const captured = '2026-10-20T18:01:00.000Z';
const reviewed = '2026-10-20T18:01:01.123Z';

function treatment() {
  return { id_tratamiento: 2122, codigo: P.CODE, nombre: P.NAME, origen: 'clinica', clinica_id: 72, grupo_clinica_id: null,
    activo: 0, precio_base: null, duracion_min: 45, sesiones_defecto: 1, color: null, descripcion: 'Source caveats: retain exactly.',
    createdAt: '2026-09-27T01:45:20.000Z', updatedAt: '2026-09-27T01:45:20.000Z',
    clinical_config: { catalog_status: 'draft', fiscal_mapping_pending: true, import_batch: 'cliniccloud-contorno-program-variant/1',
      catalog_badge: 'Nuevo', booking_profile: P.expectedProfile(), source_price: { mode: 'unresolved', currency: 'EUR', includes_tax: true },
      source_program_variant: { version: 1, protocol: 'COR-43', program_codes: ['COR-05'], pdf_pages: [10, 11, 32],
        documentary_gross_price: 145, source_hashes: copy(P.SOURCES), plan_sha256: P.SOURCE_PLAN_SHA256, effective_date: '2026-10-01',
        activation: false, clinical_approval: false, qualification_verified: false } } };
}

function fakeContext({ validationError = false, uncertainCommit = false, badCount = null, changedAfterUpdate = false } = {}) {
  let current = treatment();
  const events = [], state = { writable: true, casVerified: false, writes: 0, selects: 0 }, room = { id: 85, clinica_id: 72, activo: 1, capacidad: 1 };
  const clinic = { id_clinica: 72, grupoClinicaId: 29, equipment_booking_enabled: 1 };
  const context = { state, events, get current() { return current; }, set current(value) { current = value; }, room,
    validations: 0, contract, commitUncertain: uncertainCommit,
    async validate(value) { context.validations++; events.push('validate'); if (validationError) throw Error('resource_failed');
      assert.equal(value.activo, true); assert.equal(value.clinical_config.catalog_status, 'active'); },
    db: { Sequelize, Clinica: { findByPk: async () => copy(clinic), findAll: async () => [copy(clinic)] },
      Tratamiento: { findByPk: async () => copy(current) }, InstallationPhysicalAlias: { findAll: async () => [] },
      Instalacion: { findAll: async () => [copy(room)] },
      DoctorClinica: { findAll: async () => [{ id: 119, doctor_id: 221, clinica_id: 72, activo: 1, recibe_citas: 1 }] },
      BookingEquipment: { findAll: async () => [{ id: 4, owner_clinic_id: 72, status: 'available' }, { id: 10, owner_clinic_id: 72, status: 'available' }] },
      BookingEquipmentClinic: { findAll: async () => [{ equipment_id: 4, clinic_id: 72 }, { equipment_id: 10, clinic_id: 72 }] },
      BookingEquipmentRoomPolicy: { findAll: async () => [{ installation_id: 85, mode: 'selected', equipment_ids: [4, 5, 6] }] },
    } };
  context.db.sequelize = {
    async query(sql, options) {
      assert(O.sqlAllowed(sql, state), 'SQL guard must approve every simulated query before execution');
      if (sql.startsWith('SELECT ')) {
        state.selects++;
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) return [{ ENGINE: 'InnoDB' }];
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [
          { COLUMN_NAME: 'clinical_config', DATA_TYPE: 'json', NUMERIC_SCALE: null, DATETIME_PRECISION: null },
          { COLUMN_NAME: 'id_tratamiento', DATA_TYPE: 'int', NUMERIC_SCALE: 0, DATETIME_PRECISION: null },
          { COLUMN_NAME: 'precio_base', DATA_TYPE: 'decimal', NUMERIC_SCALE: 2, DATETIME_PRECISION: null },
          { COLUMN_NAME: 'updatedAt', DATA_TYPE: 'datetime', NUMERIC_SCALE: null, DATETIME_PRECISION: 0 },
        ];
        if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [{ COLUMN_NAME: 'id_tratamiento', SEQ_IN_INDEX: 1 }];
        if (sql.includes('INFORMATION_SCHEMA.TRIGGERS')) return [];
        return [{ id_usuario: 1, estado_cuenta: 'activo' }];
      }
      events.push('update'); state.writes++;
      assert.equal(sql, O.UPDATE_SQL);
      const r = options.replacements;
      assert.equal(current.id_tratamiento, 2122); assert.equal(current.clinica_id, 72); assert.equal(current.codigo, P.CODE);
      assert.equal(current.activo, 0); assert.equal(current.precio_base, null);
      assert.deepEqual(JSON.parse(r.beforeConfig), current.clinical_config);
      assert.equal(r.beforeUpdatedAt, current.updatedAt.slice(0, 19).replace('T', ' '));
      if (badCount !== null) return [undefined, badCount];
      current = { ...current, precio_base: '145.00', activo: 1, clinical_config: JSON.parse(r.afterConfig),
        updatedAt: r.updatedAt.replace(' ', 'T') + '.000Z' };
      if (changedAfterUpdate) current.descripcion += ' unexpected change';
      return [undefined, 1];
    },
    async transaction(options, fn) {
      const before = copy(current), tx = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
      events.push('begin');
      let result;
      try { result = await fn(tx); } catch (error) { current = before; events.push('rollback'); throw error; }
      events.push('commit');
      if (context.commitUncertain) { context.commitUncertain = false; throw Error('connection_lost_during_commit'); }
      return result;
    },
  };
  return context;
}

async function bundleFor(context, transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } }) {
  const backup = await O.capture(context, transaction);
  backup.captured_at = captured;
  const decision = { version: 1, scope: P.VERSION, gross_amount: 145, tax_percent: 21, activate: true, actor_id: 1,
    authorized_at: '2026-10-20T18:00:00.000Z', authority_reference: 'Carlos: explicit programme commercial closure 20 October 2026',
    authority_text: 'Use documentary COR-43 standalone price 145 EUR and the authorized corporal VAT of 21 percent; activate only after canonical validation.' };
  const sourceEvidence = { version: 1, protocol: 'COR-43', price_pdf_page: 32, standalone_gross_amount: 145, currency: 'EUR',
    source_hashes: copy(P.SOURCES), extracted_source_verified: true, checked_at: captured };
  const initial = P.buildPlan({ snapshot: backup, decision, sourceEvidence, createdAt: reviewed, reviewedAt: reviewed });
  const files = [{ path: 'src/lib/treatment-catalog-contract.js', sha256: 'a'.repeat(64) }];
  const source = { source_root: O.ROOT, source_commit: 'b'.repeat(40), loaded_source_files: files,
    loaded_source_sha256: hash(files), gates: { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_EQUIPMENT_ENABLED: 'true' } };
  const proof = { validator: 'validateCatalogResources', ok: true, issues: [], treatment_id: 2122, clinic_id: 72,
    before_sha256: initial.before_sha256, candidate_sha256: initial.activation_candidate_sha256,
    configuration_sha256: backup.configuration_sha256, checked_at: '2026-10-20T18:01:02.000Z', published_source: source };
  const plan = P.buildPlan({ snapshot: backup, decision, sourceEvidence, canonicalValidation: proof, createdAt: NOW, reviewedAt: reviewed });
  return { mode: 'cor43_published_helpers_select_only', actor_id: 1, backup, backup_sha256: hash(backup), plan, source,
    metadata: { read_only: true, business_writes: 0, provider_calls: 0, patient_rows_read: false } };
}
function applyOptions(context, bundle, extras = {}) {
  return { context, bundle, approvedSha256: bundle.plan.plan_sha256, now: () => NOW,
    log: { append(value) { context.events.push(value.phase); } }, assertPublishedSource() { context.events.push('source_verified'); }, ...extras };
}

test('SQL guard is fail-closed, metadata-only and exactly one explicitly armed row UPDATE', () => {
  const armed = { writable: true, casVerified: true, writes: 0 };
  for (const sql of ['SELECT * FROM `Tratamientos` WHERE id_tratamiento=2122;', 'SELECT id FROM Instalaciones WHERE id=85 FOR SHARE',
    'START TRANSACTION;', 'START TRANSACTION READ ONLY;', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;', 'COMMIT;', 'ROLLBACK;']) assert(O.sqlAllowed(sql));
  assert(O.sqlAllowed(O.UPDATE_SQL, armed));
  for (const options of [{}, { writable: true }, { ...armed, writes: 1 }, { ...armed, writable: false }]) assert.equal(O.sqlAllowed(O.UPDATE_SQL, options), false);
  for (const sql of [O.UPDATE_SQL.replace('2122', '2123'), 'SELECT * FROM Pacientes', 'SELECT * FROM CitasPacientes',
    'SELECT * FROM Tratamientos JOIN Pacientes ON 1=1', 'SELECT * FROM foreign_schema.Tratamientos', 'SELECT 1; UPDATE Tratamientos SET activo=1',
    'SELECT SLEEP(1)', "SELECT LOAD_FILE('/etc/passwd')", "SELECT GET_LOCK('x',1)",
    'SELECT * INTO OUTFILE "/tmp/export" FROM Tratamientos', 'DELETE FROM Tratamientos WHERE id_tratamiento=2122',
    'UPDATE Tratamientos SET activo=1', 'CREATE TABLE test(id INT)', 'SET GLOBAL read_only=0']) assert.equal(O.sqlAllowed(sql, armed), false, sql);
});

test('wire date normalization retains milliseconds and parses JSON but does not mutate input', () => {
  const input = { updatedAt: '2026-10-20 18:01:02', createdAt: new Date('2026-09-27T01:45:20.123Z'), clinical_config: '{"a":1}' };
  assert.deepEqual(O.canonicalRow(input), { updatedAt: '2026-10-20T18:01:02.000Z', createdAt: '2026-09-27T01:45:20.123Z', clinical_config: { a: 1 } });
  assert.equal(typeof input.clinical_config, 'string');
  assert.throws(() => O.canonicalRow({ updatedAt: 'invalid clock' }), /COR43_OPERATOR_ROW_CLOCK_INVALID/);
});

test('published fiscal normalizers must reproduce the exact sealed candidate', async () => {
  const bundle = await bundleFor(fakeContext());
  assert.deepEqual(O.canonicalAfter(bundle.plan, contract), bundle.plan.after);
  const changed = { ...contract, mergeClinicalConfig: (...args) => ({ ...contract.mergeClinicalConfig(...args), injected: true }) };
  assert.throws(() => O.canonicalAfter(bundle.plan, changed), /COR43_OPERATOR_PUBLISHED_NORMALIZERS_DIFFER/);
});

test('approval binds the full backup, source helpers, actor, resource metadata and fresh exact plan', async () => {
  const bundle = await bundleFor(fakeContext());
  O.assertBundle(bundle, bundle.plan.plan_sha256, { applying: true, now: Date.parse(NOW) });
  for (const mutate of [b => b.backup.treatment.descripcion += ' edited', b => b.source.source_commit = 'e'.repeat(40),
    b => b.source.gates.BOOKING_EQUIPMENT_ENABLED = 'false', b => b.source.loaded_source_files[0].path = '../escape',
    b => b.actor_id = 2, b => b.metadata.business_writes = 1,
    b => { b.backup.configuration.rooms[0].activo = 0; b.backup_sha256 = hash(b.backup); }]) {
    const changed = copy(bundle); mutate(changed); assert.throws(() => O.assertBundle(changed), /COR43_/);
  }
  assert.throws(() => O.assertBundle(bundle, 'a'.repeat(64), { applying: true, now: Date.parse(NOW) }), /COR43_OPERATOR_EXACT_FRESH_APPROVAL_REQUIRED/);
  assert.throws(() => O.assertBundle(bundle, bundle.plan.plan_sha256, { applying: true, now: Date.parse(NOW) + P.MAX_AGE_MS + 1 }), /COR43_OPERATOR_EXACT_FRESH_APPROVAL_REQUIRED/);
});

test('scoped transaction validates/backs up before exactly one UPDATE and verifies before commit', async () => {
  const context = fakeContext(), bundle = await bundleFor(context);
  const result = await O.applyBundle(applyOptions(context, bundle));
  assert.equal(result.mode, 'committed'); assert.equal(result.updated, 1); assert.equal(context.state.writes, 1);
  assert.equal(result.appointments_changed, 0); assert.equal(result.programmes_changed, 0); assert.equal(result.messages_sent, 0);
  assert.equal(result.after.precio_base, '145.00'); assert.equal(result.after.clinical_config.catalog_badge, 'Nuevo');
  assert.deepEqual(result.after.clinical_config.source_program_variant, bundle.plan.before.clinical_config.source_program_variant);
  const events = context.events;
  assert(events.indexOf('validate') < events.indexOf('update'));
  assert(events.indexOf('locked_full_row_cas_and_canonical_validation') < events.indexOf('update'));
  assert(events.indexOf('update') < events.indexOf('verified_before_commit'));
  assert(events.indexOf('verified_before_commit') < events.indexOf('commit'));
  assert.equal(context.state.casVerified, false);
});

test('verified replay does not rewrite audit time, revalidate or update a second time', async () => {
  const context = fakeContext(), bundle = await bundleFor(context);
  await O.applyBundle(applyOptions(context, bundle));
  const first = copy(context.current), validations = context.validations;
  const replay = await O.applyBundle(applyOptions(context, bundle));
  assert.equal(replay.mode, 'already_applied_verified'); assert.equal(replay.updated, 0); assert.equal(context.state.writes, 1);
  assert.equal(context.validations, validations); assert.deepEqual(context.current, first);
});

test('full-row concurrent edit or resource drift cannot be overwritten', async () => {
  for (const mutate of [c => c.current.descripcion += ' receptionist edit', c => c.current.precio_base = '145.00',
    c => c.current.clinical_config.price_profile = copy(P.PROFILE), c => c.room.activo = 0]) {
    const context = fakeContext(), bundle = await bundleFor(context); mutate(context);
    const before = copy(context.current);
    await assert.rejects(() => O.applyBundle(applyOptions(context, bundle)), /COR43_FULL_ROW_OR_CONFIGURATION_CHANGED/);
    assert.equal(context.state.writes, 0); assert.deepEqual(context.current, before);
  }
});

test('source change or current canonical resource rejection causes zero writes', async () => {
  const changed = fakeContext(), bundle = await bundleFor(changed);
  await assert.rejects(() => O.applyBundle(applyOptions(changed, bundle, { assertPublishedSource() { throw Error('source_changed'); } })), /source_changed/);
  assert.equal(changed.state.writes, 0);
  const invalid = fakeContext({ validationError: true }), invalidBundle = await bundleFor(invalid);
  await assert.rejects(() => O.applyBundle(applyOptions(invalid, invalidBundle)), /resource_failed/);
  assert.equal(invalid.state.writes, 0); assert.equal(invalid.current.precio_base, null);
});

test('nontransactional storage, changed primary key, non-JSON config, precision drift or a trigger fail closed', async () => {
  for (const [needle, replacement] of [
    ['INFORMATION_SCHEMA.TABLES', [{ ENGINE: 'MyISAM' }]],
    ['INFORMATION_SCHEMA.STATISTICS', [{ COLUMN_NAME: 'codigo', SEQ_IN_INDEX: 1 }]],
    ['INFORMATION_SCHEMA.COLUMNS', [{ COLUMN_NAME: 'clinical_config', DATA_TYPE: 'text' }]],
    ['INFORMATION_SCHEMA.TRIGGERS', [{ TRIGGER_NAME: 'unsafe_target_trigger' }]],
  ]) {
    const context = fakeContext(), bundle = await bundleFor(context), original = context.db.sequelize.query;
    context.db.sequelize.query = (text, options) => text.includes(needle) ? Promise.resolve(replacement) : original(text, options);
    await assert.rejects(() => O.applyBundle(applyOptions(context, bundle)), /COR43_OPERATOR_STORAGE_CONTRACT_INVALID/);
    assert.equal(context.state.writes, 0);
  }
});

test('failed audit persistence before UPDATE stops with no writes', async () => {
  const context = fakeContext(), bundle = await bundleFor(context);
  await assert.rejects(() => O.applyBundle(applyOptions(context, bundle, { log: { append() { throw Error('disk_full'); } } })), /disk_full/);
  assert.equal(context.state.writes, 0); assert.equal(context.current.precio_base, null);
});

test('unexpected update count or postcondition mismatch rolls the entire transaction back', async () => {
  for (const options of [{ badCount: 0 }, { badCount: 2 }, { changedAfterUpdate: true }]) {
    const context = fakeContext(options), bundle = await bundleFor(context);
    await assert.rejects(() => O.applyBundle(applyOptions(context, bundle)), /COR43_/);
    assert.deepEqual(context.current, bundle.plan.before); assert(context.events.includes('rollback'));
    assert.equal(context.state.casVerified, false);
  }
});

test('uncertain commit requires independent review; exact readback/replay never duplicates a write', async () => {
  const context = fakeContext({ uncertainCommit: true }), bundle = await bundleFor(context);
  await assert.rejects(() => O.applyBundle(applyOptions(context, bundle)), /COR43_OPERATOR_COMMIT_RESULT_REQUIRES_REVIEW/);
  assert.equal(context.current.precio_base, '145.00'); assert.equal(context.state.writes, 1);
  assert(context.events.includes('commit_result_requires_independent_review'));
  const readback = await O.applyBundle(applyOptions(context, bundle));
  assert.equal(readback.mode, 'already_applied_verified'); assert.equal(context.state.writes, 1);
});

test('alias family and each room/equipment owner clinic are sealed even when room85 is the alias', async () => {
  const context = fakeContext(), seen = [], rows = [{ installation_id: 85, canonical_installation_id: 100, group_id: 29 },
    { installation_id: 101, canonical_installation_id: 100, group_id: 29 }];
  context.db.InstallationPhysicalAlias.findAll = async options => {
    if (options.where.installation_id === 85) return [copy(rows[0])];
    assert.deepEqual(options.where[Sequelize.Op.or][0].installation_id[Sequelize.Op.in], [100]); return copy(rows);
  };
  context.db.Instalacion.findAll = async options => { seen.push(...options.where.id[Sequelize.Op.in]); return [copy(context.room), { id: 100, clinica_id: 66 }, { id: 101, clinica_id: 66 }]; };
  context.db.Clinica.findAll = async options => { assert.deepEqual(options.where.id_clinica[Sequelize.Op.in], [66, 72]);
    return [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }]; };
  const snapshot = await O.capture(context, { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } }, { locked: true });
  assert.deepEqual(seen.sort(), [100, 101, 85].sort()); assert.equal(snapshot.configuration.aliases.length, 2);
  assert.equal(snapshot.configuration.ownerClinics.length, 2);
  assert.equal(snapshot.configuration_sha256, hash(snapshot.configuration));
});

test('operator never loads workers, application models index, patients or program/budget writes', () => {
  const source = fs.readFileSync(require.resolve('../bs-contorno-cor43-closure'), 'utf8');
  assert.equal(/models\/index|require\(['"]\.\.\/\.\.\/models|PatientVoucher|TreatmentProgram|PatientProgramBookingRequest|CitaPaciente|sendWhatsApp/.test(source), false);
  assert.equal(/(?:INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE)/i.test(source), false);
  assert.equal(source.match(/UPDATE Tratamientos SET/g).length, 1);
});
