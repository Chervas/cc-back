'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { buildCatalogPlan } = require('../../lib/cliniccloud-import/catalog');
const { prepareDraftPackage } = require('../../lib/cliniccloud-import/catalog-drafts');
const { prepareResourceRefresh, verifyResourceRefresh, refreshedConfig, isResourceRefreshReplay } = require('../../lib/cliniccloud-import/catalog-resource-refresh');
const { executeRefresh, run } = require('../cliniccloud-import-catalog-resource-refresh');
const now = '2026-09-21T08:00:00.000Z';
function fixture() {
  const local = { installations: [{ id: 81, clinic_id: 72, name: 'C8', active: false }],
    professionals: [{ id: 221, clinic_id: 72, name: 'Piedad', active: true, receives_appointments: true }], treatments: [] };
  const sources = { workbookHash: 'a'.repeat(64), repliesHash: 'b'.repeat(64), local,
    sheets: [{ name: 'Tratamientos individuales', rows: [{ source_row: 2,
      cells: { A: 'EXION', B: 'Sesión QA', C: '30 min', D: '121 €', G: '8', H: 'Aux. Piedad' } }] }] };
  const empty = { treatments: [], installations: [{ id: 81, clinica_id: 72, activo: 0 }],
    professionals: [{ id: 1, doctor_id: 221, clinica_id: 72, activo: 1, recibe_citas: 1 }] };
  const initial = prepareDraftPackage({ plan: buildCatalogPlan(sources), before: empty, now });
  const values = initial.operations[0].values;
  const before = { ...structuredClone(empty), treatments: [{ id_tratamiento: 7, ...values,
    clinical_config: { ...values.clinical_config, catalog_import_package: initial.package_sha256 }, createdAt: now, updatedAt: now }] };
  const plan = buildCatalogPlan({ ...sources, resourceMap: { cabins_by_clinic: {72: { C8: 81 }}, professionals: { 'Aux. Piedad': 221 } } });
  return { before, initial, plan };
}
function build(f = fixture()) { return prepareResourceRefresh({ ...f, createdAt: now }); }
function sealedInitial(initial) { const { package_sha256, ...body } = initial; return { ...body, package_sha256: hash(body) }; }
function connectionFor(before) {
  let state = structuredClone(before), original;
  const actions = [];
  return { actions, state: () => state, beginTransaction: async () => { original = structuredClone(state); },
    rollback: async () => { if (original) state = original; actions.push('rollback'); },
    commit: async () => { actions.push('commit'); original = null; },
    query: async (sql, values) => {
      if (sql.startsWith('SET TRANSACTION')) return [[]];
      if (sql.startsWith('SELECT id_clinica')) return [[{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }]];
      if (sql.includes('information_schema.TRIGGERS')) return [[]];
      if (sql.startsWith('SELECT * FROM Tratamientos')) return [structuredClone(state.treatments)];
      if (sql.startsWith('SELECT id,clinica_id,activo FROM Instalaciones')) return [structuredClone(state.installations)];
      if (sql.startsWith('SELECT id,doctor_id')) return [structuredClone(state.professionals)];
      assert.equal(sql, 'UPDATE Tratamientos SET clinical_config=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=?');
      const row = state.treatments.find(t => t.id_tratamiento === values[1]); assert(row);
      row.clinical_config = values[0]; row.updatedAt = '2026-09-21T08:01:00.000Z'; actions.push('update');
      return [{ affectedRows: 1 }];
    } };
}
test('fills a missing profile from actual cabin/person IDs, preserving every non-resource field and draft holds', () => {
  const f = fixture(), pkg = build(f); verifyResourceRefresh(pkg, f);
  assert.equal(pkg.operations.length, 1); const op = pkg.operations[0];
  assert.deepEqual(op.after_config.booking_profile.phases[0].installation_ids, [81]);
  assert.deepEqual(op.after_config.booking_profile.phases[0].professionals.ids, [221]);
  assert.equal(op.after_config.booking_profile.phases[0].duration_minutes, 30);
  assert.equal(op.after_config.fiscal_mapping_pending, true); assert.equal(op.after_config.catalog_status, 'draft');
  assert.deepEqual(op.after_config.source_price, op.before.clinical_config.source_price);
  assert.equal(op.before.precio_base, null); assert.equal(op.before.activo, 0);
  assert.deepEqual(pkg.policy.columns, ['clinical_config', 'updatedAt']);
});
test('preserves existing profiles and defers modified drafts, approved prices and activations', () => {
  for (const change of [row => row.nombre = 'Edición humana', row => row.clinical_config.custom = true,
    row => row.activo = 1, row => row.precio_base = 121, row => row.clinical_config.fiscal_mapping_pending = false]) {
    const f = fixture(); change(f.before.treatments[0]); const pkg = build(f);
    assert.equal(pkg.operations.length, 0); assert.equal(pkg.deferred.length, 1);
  }
  const f = fixture(); f.before.treatments[0].clinical_config.booking_profile = { human: true };
  assert.equal(build(f).operations.length, 0); assert.deepEqual(build(f).preserved, [7]);
});
test('cannot cross clinics, duplicate source codes, change source bytes or tamper with a generated profile', () => {
  let f = fixture(); f.before.treatments[0].clinica_id = 66; assert.throws(() => build(f), /SOURCE_CHANGED/);
  f = fixture(); f.before.treatments.push({ ...f.before.treatments[0], id_tratamiento: 8 }); assert.throws(() => build(f), /SOURCE_NOT_UNIQUE/);
  f = fixture(); f.initial.workbook_sha256 = 'c'.repeat(64); f.initial = sealedInitial(f.initial); assert.throws(() => build(f), /BASELINE_INVALID/);
  f = fixture(); const pkg = build(f); pkg.operations[0].after_config.booking_profile.phases[0].installation_ids = [999];
  assert.throws(() => verifyResourceRefresh(pkg, f), /PACKAGE_CHANGED/);
});
test('the two previously preserved examples require the exact unchanged original row', () => {
  const f = fixture(), row = f.before.treatments[0]; row.clinical_config.import_batch = 'cliniccloud-program-examples-20260914';
  f.initial.before.treatments = [structuredClone(row)]; f.initial.operations = []; f.initial = sealedInitial(f.initial);
  assert.equal(build(f).operations.length, 1);
  row.updatedAt = '2026-09-21T08:02:00.000Z'; assert.equal(build(f).deferred.length, 1);
});
test('writes only clinical_config and timestamp, verifies readback and replays without a second update', async () => {
  const f = fixture(), pkg = build(f), c = connectionFor(f.before), entries = [];
  const journal = { append: async entry => entries.push(entry) };
  const result = await executeRefresh({ connection: c, pkg, journal }); assert.equal(result.updated, 1);
  assert.equal(result.active_changed, 0); assert.equal(result.prices_changed, 0); assert.equal(result.reminders_activated, false);
  const row = c.state().treatments[0]; assert(isResourceRefreshReplay(row, pkg.operations[0], pkg));
  assert.equal(row.nombre, f.before.treatments[0].nombre); assert.equal(row.activo, 0); assert.equal(row.precio_base, null);
  const replay = await executeRefresh({ connection: c, pkg, journal }); assert.equal(replay.replayed, 1);
  assert.equal(c.actions.filter(a => a === 'update').length, 1);
  assert.deepEqual(JSON.parse(row.clinical_config), refreshedConfig(pkg.operations[0], pkg));
});
test('state drift stops before writes, including a staff membership change', async () => {
  for (const mutate of [f => f.before.treatments[0].nombre = 'Otro nombre', f => f.before.professionals[0].activo = 0]) {
    const f = fixture(), pkg = build(f); mutate(f); const c = connectionFor(f.before);
    await assert.rejects(executeRefresh({ connection: c, pkg, journal: { append: async () => {} } }), /STATE_DRIFT/);
    assert(!c.actions.includes('update'));
  }
});
test('journal failure rolls back configuration and replay refuses a later human edit', async () => {
  const f = fixture(), pkg = build(f), c = connectionFor(f.before);
  await assert.rejects(executeRefresh({ connection: c, pkg, journal: { append: async entry => {
    if (entry.stage === 'resource_refresh_written_before_commit') throw Error('journal unavailable');
  } } }), /journal unavailable/);
  assert.equal(hash(c.state()), hash(f.before));
  const row = { ...pkg.operations[0].before, clinical_config: refreshedConfig(pkg.operations[0], pkg), nombre: 'Edición posterior' };
  assert.equal(isResourceRefreshReplay(row, pkg.operations[0], pkg), false);
});
test('operator requires explicit CRM scope before it may connect', async () => {
  await assert.rejects(run(['--mode', 'apply', '--target', 'dev']), /EXPLICIT_CRM_REFRESH_MODE_REQUIRED/);
});
test('unknown COMMIT outcome requires journal reconciliation rather than a blind retry', async () => {
  const f = fixture(), pkg = build(f), c = connectionFor(f.before);
  c.commit = async () => { throw Error('connection lost'); };
  await assert.rejects(executeRefresh({ connection: c, pkg, journal: { append: async () => {} } }), /COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW/);
});
