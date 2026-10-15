'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const operator = require('../bs-client-surgical-profiles');
const configuration = { database: 'owned_fictitious_surgery_fixture', password: 'not_printed_fixture' };
const info = { commit: 'a'.repeat(40), pins: { owned_fixture: 'b'.repeat(64) } };
const now = Date.now(), generatedAt = new Date(now).toISOString();
const mutationAt = generatedAt.slice(0, 19).replace('T', ' ');
const clone = value => structuredClone(value);

function sheets() {
  return [{ name: 'Tratamientos', rows: [
    { source_row: 9, cells: { A: 'CAP-DHI-1', B: 'BS Capilar', E: '07:00–14:30 (450 min). Dr. Loza y apoyo Ainhoa en C6.', F: 'Mantener 07:00–14:30', M: '1994' } },
    { source_row: 19, cells: { A: 'CAP-APOYO', B: 'BS Capilar', E: 'Barba 240 min; cejas 180 min. Dr. Loza en C6.', F: 'Ainhoa durante toda la intervención, en ambos casos', M: '1997, 1998' } },
  ] }];
}
function evidence() {
  return { ...operator.workbookEvidence(sheets(), operator.WORKBOOK_SHA), protocol: {
    package_sha256: operator.PROTOCOL_PACKAGE_SHA, source_file: 'BS-Medical-Protocolos-V3-Capilar.pdf',
    source_sha256: operator.PROTOCOL_SHA, pdf_page: 41, page_sha256: operator.PROTOCOL_PAGE_SHA, clinical_approval: false } };
}
function state() {
  const treatments = operator.SPECS.map(spec => ({ id_tratamiento: spec.id, codigo: spec.code, nombre: 'Owned fictitious surgical draft ' + spec.id,
    clinica_id: 66, activo: 0, duracion_min: null, precio_base: spec.id === 1994 ? '4390.00' : null,
    descripcion: 'Original fixture text retained', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-02 00:00:00',
    clinical_config: { catalog_status: 'draft', product_type: 'treatment', import_batch: 'cliniccloud-bs-catalog-individuals-20260921',
      source_catalog: { file_sha256: operator.ORIGINAL_CATALOG_SHA, sheet: 'Capilar · sesiones y bonos', source_row: spec.source_row, row_sha256: spec.source_row_sha256 },
      source_duration: 'Original source duration remains', source_price: { mode: spec.id === 1998 ? 'from' : 'fixed', gross_amount: spec.id === 1994 ? 4390 : 2500 },
      fiscal_mapping_pending: true, custom_preserved: { human_note: 'Not overwritten' },
      import_issues: ['DURATION_REQUIRES_CONFIGURATION', 'INSTALLATION_INACTIVE', 'INDIVIDUAL_QUOTATION_REQUIRED'] } }));
  return { target: 'crm', identity_sha256: hash('owned_database'), configuration_sha256: hash(configuration), schema_sha256: hash('owned_schema'),
    clinics: [{ id_clinica: 66, grupoClinicaId: 29 }], treatments,
    config_sql_sha256: Object.fromEntries(treatments.map(row => [row.id_tratamiento, hash(JSON.stringify(row.clinical_config))])),
    rooms: [{ id: 78, clinica_id: 66, activo: 1, capacidad: 1, requiere_preparacion: 0, tiempo_preparacion_minutos: 0, profesionales_permitidos: [50, 120] }],
    staff: [{ id: 20, doctor_id: 50, clinica_id: 66, activo: 1, recibe_citas: 1 }, { id: 91, doctor_id: 120, clinica_id: 66, activo: 1, recibe_citas: 1 }],
    appointments: { count: 2, sha256: hash([{ fixture_appointment: 1 }, { fixture_appointment: 2 }]) } };
}
function plan() { return operator.makePlan({ before: state(), info, evidence: evidence(), generatedAt }); }
function applied(prepared = plan(), at = mutationAt) {
  const after = clone(prepared.before);
  after.treatments.forEach(row => {
    const op = prepared.operations.find(value => value.id === row.id_tratamiento);
    Object.assign(row, { duracion_min: op.minutes, clinical_config: clone(op.after_config), updatedAt: at });
    after.config_sql_sha256[row.id_tratamiento] = hash(JSON.stringify(row.clinical_config));
  });
  return after;
}
function fixture({ stale = false, busy = false, lostLock = false, sourceDrift = false, evidenceDrift = false,
  failBackup = false, failJournal = null, failedCas = null, changedAppointment = false, changedPrice = false,
  failCommit = false, failIndependent = false, replay = false, partial = false } = {}) {
  const prepared = plan(), calls = [], backups = [], events = [];
  let current = replay || partial ? applied(prepared) : clone(prepared.before), saved, transaction = false, writes = 0;
  if (partial) current.treatments[1] = clone(prepared.before.treatments[1]);
  if (stale) current.treatments[0].descripcion = 'Later human edit';
  const connection = {
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: busy ? 0 : 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT IS_USED_LOCK')) return [[{ owned: lostLock ? 0 : 1 }]];
      if (sql.startsWith('SELECT DATE_FORMAT')) return [[{ mutation_at: mutationAt }]];
      if (sql.startsWith('SET TRANSACTION')) return [[], []];
      if (sql.startsWith('UPDATE Tratamientos')) {
        assert(transaction); assert(backups.length === 1); assert(events.some(event => event.phase === 'backup_durable_before_mutation'));
        writes++;
        if (failedCas === writes) return [{ affectedRows: 0 }];
        const [minutes, configJson, at, id, code, oldAt, oldConfigSha] = values;
        const row = current.treatments.find(value => value.id_tratamiento === id);
        assert.equal(row.codigo, code); assert.equal(row.updatedAt, oldAt); assert.equal(row.duracion_min, null); assert.equal(row.activo, 0);
        assert.equal(current.config_sql_sha256[id], oldConfigSha);
        Object.assign(row, { duracion_min: minutes, clinical_config: JSON.parse(configJson), updatedAt: at });
        current.config_sql_sha256[id] = hash(JSON.stringify(row.clinical_config));
        if (changedAppointment) current.appointments.sha256 = hash('unexpected appointment mutation');
        if (changedPrice) row.precio_base = '1.00';
        return [{ affectedRows: 1 }];
      }
      assert.fail('Unexpected SQL ' + sql);
    },
    beginTransaction: async () => { assert(!transaction); saved = clone(current); transaction = true; calls.push({ sql: 'BEGIN' }); },
    rollback: async () => { if (transaction) current = clone(saved); transaction = false; calls.push({ sql: 'ROLLBACK' }); },
    commit: async () => { calls.push({ sql: 'COMMIT' }); if (failCommit) throw Error('owned_commit_uncertainty'); transaction = false; },
  };
  const run = extra => operator.execute({ connection, plan: prepared, info, evidence: evidence(), configuration,
    backupPath: '/home/ubuntu/secure-imports/owned_not_written_surgical_fixture.json',
    journal: { append: async event => { if (event.phase === failJournal) throw Error('owned_journal_failure'); events.push(clone(event)); } },
    captureState: async () => clone(current),
    saveBackup: (_filename, value) => { if (failBackup) throw Error('owned_backup_failure'); backups.push(clone(value)); },
    readIndependent: async () => { if (failIndependent) throw Error('owned_independent_failure'); return clone(current); },
    checkSource: () => sourceDrift ? { ...info, commit: 'c'.repeat(40) } : info,
    checkEvidence: () => evidenceDrift ? { ...evidence(), workbook_sha256: 'e'.repeat(64) } : evidence(), ...extra });
  return { prepared, run, calls, backups, events, current: () => current };
}

test('exact reviewed source answers and row hashes are required; contradictory free text cannot pass', () => {
  const e = evidence(); assert.equal(e.answers.length, 2); assert.equal(e.answers[0].reference, 'CAP-DHI-1');
  for (const mutate of [s => s[0].rows[0].cells.F = 'Otro horario', s => s[0].rows[1].cells.G = 'Solo por la mañana',
    s => s[0].rows[1].cells.O = 'No toda la intervención', s => s[0].rows[1].cells.M = '1997',
    s => s[0].rows[0].cells.E = 'Horario sin minutos ni equipo', s => s[0].rows[1].cells.B = 'BS Medical']) {
    const broken = sheets(); mutate(broken); assert.throws(() => operator.workbookEvidence(broken, operator.WORKBOOK_SHA));
  }
  assert.throws(() => operator.workbookEvidence(sheets(), '0'.repeat(64)), /SOURCE_CHANGED/);
});
test('protocol source and literal page 41 durations are mandatory, not inferred from the old catalogue', () => {
  const document = { results: [{ source_file: 'BS-Medical-Protocolos-V3-Capilar.pdf', source_sha256: operator.PROTOCOL_SHA,
    page_sha256: Array.from({ length: 41 }, (_, i) => i === 40 ? operator.PROTOCOL_PAGE_SHA : hash('other_page')),
    parts: [{ content: '## Página 41 del PDF\nCAP-14 Injerto de barba 4h\nCAP-15 Injerto de cejas 3h' }] }] };
  assert.equal(operator.protocolEvidence(document, operator.PROTOCOL_PACKAGE_SHA).pdf_page, 41);
  const broken = clone(document); broken.results[0].parts[0].content = 'CAP-14 1 jornada';
  assert.throws(() => operator.protocolEvidence(broken, operator.PROTOCOL_PACKAGE_SHA));
  assert.throws(() => operator.protocolEvidence(document, 'f'.repeat(64)));
});
test('three complete-team profiles validate without partial attention, setup sharing, guessed machines or activation', () => {
  const p = plan(); assert.deepEqual(p.operations.map(op => [op.id, op.minutes]), [[1994, 450], [1997, 240], [1998, 180]]);
  for (const op of p.operations) {
    const phase = op.after_config.booking_profile.phases[0];
    assert.deepEqual(phase.professionals, { mode: 'all', ids: [120, 50], preferred_id: null });
    assert.deepEqual(phase.installation_ids, [78]); assert.equal(op.after_config.booking_profile.version, 1);
    assert.equal(phase.staff_attention, undefined); assert.equal(phase.preparation_sharing, undefined); assert.equal(phase.equipment_requirements, undefined);
    assert.deepEqual(op.after_config.import_issues, ['INDIVIDUAL_QUOTATION_REQUIRED']);
    assert.equal(op.after_config.catalog_status, 'draft'); assert.equal(op.after_config.fiscal_mapping_pending, true);
    assert.deepEqual(op.after_config.custom_preserved, { human_note: 'Not overwritten' });
    assert.equal(op.after_config.source_client_surgical_profile.clinical_approval, false);
  }
  assert.equal(p.operations[0].after_config.source_client_surgical_profile.fixed_clock_enforced_by_profile, false);
  assert.equal(p.before.treatments[1].precio_base, null); assert.equal(p.policy.activation, false);
});
test('active or edited drafts, wrong source, clinic, team or room stop planning; no new affiliation is created', () => {
  for (const mutate of [s => s.treatments.pop(), s => s.treatments[0].activo = 1, s => s.treatments[0].duracion_min = 450,
    s => s.treatments[0].clinical_config.booking_profile = operator.profile(operator.SPECS[0]), s => s.treatments[0].codigo = 'other',
    s => s.treatments[1].clinical_config.source_catalog.row_sha256 = hash('other_source'), s => s.rooms[0].clinica_id = 72,
    s => s.rooms[0].profesionales_permitidos = [120], s => s.rooms[0].activo = 0, s => s.rooms[0].capacidad = 2,
    s => s.rooms[0].tiempo_preparacion_minutos = 15, s => s.staff[0].recibe_citas = 0, s => s.staff[1].clinica_id = 72,
    s => s.clinics[0].grupoClinicaId = 1, s => s.appointments.sha256 = 'invalid']) {
    const before = state(); mutate(before); assert.throws(() => operator.makePlan({ before, info, evidence: evidence(), generatedAt }));
  }
});
test('plan scope, source, complete row images, evidence and freshness are sealed', () => {
  const p = plan(); assert.doesNotThrow(() => operator.validatePlan(p, info, evidence(), configuration, { now }));
  for (const patch of [{ target: 'dev' }, { operations: [] }, { policy: { activation: true } }, { plan_sha256: 'e'.repeat(64) },
    { source: { ...info, commit: 'c'.repeat(40) } }, { evidence: { ...evidence(), workbook_sha256: 'f'.repeat(64) } }]) {
    assert.throws(() => operator.validatePlan({ ...p, ...patch }, info, evidence(), configuration, { now }));
  }
  assert.throws(() => operator.validatePlan(p, info, evidence(), { ...configuration, database: 'other' }, { now }));
  assert.throws(() => operator.validatePlan(p, info, evidence(), configuration, { now: now + 7200001 }), /EXPIRED/);
  assert.throws(() => operator.validatePlan(p, info, evidence(), configuration, { now: now - 1 }), /EXPIRED/);
});
test('successful executor backs up complete rows before three exact CAS writes and independently verifies', async () => {
  const f = fixture(), receipt = await f.run();
  assert.equal(receipt.status, 'committed_and_verified'); assert.equal(receipt.changed_rows, 3);
  assert.equal(f.backups.length, 1); assert.deepEqual(f.backups[0].before, f.prepared.before);
  assert.equal(f.events[0].phase, 'backup_durable_before_mutation');
  assert.equal(f.events.at(-1).phase, 'committed_and_independently_verified');
  const updates = f.calls.filter(call => call.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 3); assert(updates.every(call => /WHERE id_tratamiento=\?.*activo=0.*duracion_min IS NULL.*SHA2/.test(call.sql)));
  assert.deepEqual(f.current().treatments.map(row => row.precio_base), ['4390.00', null, null]);
  assert.deepEqual(f.current().appointments, f.prepared.before.appointments);
});
test('dry run exercises the DML then rolls back and independently proves original complete state', async () => {
  const f = fixture(), receipt = await f.run({ dryRun: true });
  assert.equal(receipt.status, 'rolled_back_and_verified'); assert.equal(receipt.changed_rows, 0);
  assert.deepEqual(f.current(), f.prepared.before); assert.equal(f.calls.filter(call => call.sql.startsWith('UPDATE')).length, 3);
  assert(!f.calls.some(call => call.sql === 'COMMIT'));
});
test('exact replay writes zero rows; a partial result or later human change is not completed automatically', async () => {
  const f = fixture({ replay: true }), receipt = await f.run();
  assert.equal(receipt.status, 'replay_preserved'); assert.equal(receipt.changed_rows, 0); assert.equal(receipt.replayed, 3);
  assert.equal(f.backups.length, 0); assert(!f.calls.some(call => call.sql.startsWith('UPDATE')));
  for (const options of [{ partial: true }, { stale: true }, { replay: true, changedPrice: true }]) {
    const bad = fixture(options);
    if (options.changedPrice) bad.current().treatments[0].precio_base = '2.00';
    await assert.rejects(bad.run()); assert(!bad.calls.some(call => call.sql.startsWith('UPDATE')));
  }
});
test('busy/lost lock, stale data, source/evidence drift or nondurable backup/journal never commit', async () => {
  for (const options of [{ busy: true }, { lostLock: true }, { stale: true }, { sourceDrift: true }, { evidenceDrift: true },
    { failBackup: true }, { failJournal: 'backup_durable_before_mutation' }, { failJournal: 'before_three_profile_cas_only' }]) {
    const f = fixture(options); await assert.rejects(f.run());
    assert(!f.calls.some(call => call.sql === 'COMMIT')); assert(!f.calls.some(call => call.sql.startsWith('UPDATE')));
  }
});
test('failed row CAS, price mutation or protected appointment drift rolls back every write', async () => {
  for (const options of [{ failedCas: 2 }, { changedAppointment: true }, { changedPrice: true }, { failJournal: 'profiles_and_protected_state_verified_before_commit' }]) {
    const f = fixture(options); await assert.rejects(f.run()); assert.deepEqual(f.current(), f.prepared.before);
    assert(!f.calls.some(call => call.sql === 'COMMIT'));
  }
});
test('commit uncertainty and failed independent post-commit readback require private journal review', async () => {
  for (const options of [{ failCommit: true }, { failIndependent: true }, { failJournal: 'committed' }]) {
    const f = fixture(options); await assert.rejects(f.run(), /COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW/);
  }
});
test('only explicit CRM prepare/dry-run/apply/check modes and exact source arguments are supported', () => {
  const base = ['--mode', 'prepare', '--target', 'crm', '--workbook', '/owned.xlsx', '--protocol-package', '/owned.json', '--private-output', '/owned.json'];
  assert.equal(operator.parseOptions(base)['--mode'], 'prepare');
  for (const args of [[], [...base, '--mode', 'apply'], base.map(value => value === 'crm' ? 'dev' : value), [...base, '--activate', 'true']]) assert.throws(() => operator.parseOptions(args));
});
test('source contains only the scoped treatment update and never bootstraps models or mutates clinical/message tables', () => {
  const text = fs.readFileSync(require.resolve('../bs-client-surgical-profiles'), 'utf8');
  const updates = [...text.matchAll(/UPDATE ([A-Za-z_]+)/g)].map(match => match[1]);
  assert.deepEqual(updates, ['Tratamientos']);
  assert(!/require\(['"][^'"]*(?:\/models|app\.js|index\.js)['"]\)/.test(text));
  assert(!/\b(?:INSERT INTO|DELETE FROM|ALTER TABLE|TRUNCATE)\b/.test(text));
  assert(operator.PIN_FILES.includes('src/lib/cliniccloud-import/xlsx_catalog.py'));
  assert(operator.PIN_FILES.includes('src/scripts/tests/bs_client_surgical_profiles.test.js'));
});
