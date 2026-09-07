'use strict';

// Every identity below is synthetic. No source export, private plan, application
// model, real database, authentication provider or messaging runtime is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash, normalizeContacts } = require('../../lib/cliniccloud-import/adapter');
const core = require('../../lib/cliniccloud-import/new-patients-apply');
const { createNewPatientsStore, sqlDate } = require('../../lib/cliniccloud-import/new-patients-store');
const clone = value => JSON.parse(JSON.stringify(value));
const NOW = Date.parse('2026-09-07T12:00:00Z');

function fixture(count = 2, defer = 0) {
  const records = Array.from({ length: count }, (_, i) => ({ source_row: i + 2, values: {
    IDCONTACTO: String(8000000 + i), NUM: String(90000 + i), NOMBRE: `Demostracion${i}`, APELLIDOS: `Ficticia${i}`,
    'TELF. MOVIL': String(600100000 + i), 'TELF. FIJO': '', 'TELF. ADICIONAL': '', EMAIL: `person-${i}@example.invalid`,
    DNI: '', 'F. NACIMIENTO': '02/01/1980', ALTA: '02-08-2026 10:00:00', ESTADO: 'ACTIVO',
    WHATSAPP: i % 2 ? 'true' : 'false', ALERGIAS: 'SOURCE-ONLY-HEALTH-NOT-TO-BE-IMPORTED',
  } }));
  const sources = Object.fromEntries(['contacts', 'appointments', 'historic_contacts', 'historic_types'].map(role => [role, {
    file: { role, sha256: hash(`synthetic-${role}`) }, rows: role === 'contacts' ? records : [],
  }]));
  let audit, review;
  function rehash() {
    const normalized = normalizeContacts(records, sources.contacts.file.sha256);
    audit = { manifest: { version: 'cliniccloud-new-patients-audit/1', source_account: core.ACCOUNT,
      policy: { whatsapp_ignored: true, primary_requires_source_creation_inside_export_coverage: true },
      source_files: Object.values(sources).map(source => clone(source.file)) }, rows: normalized.map((row, i) => ({
      ...row, action_key: `synthetic-action-${i}`, status: 'safe_candidate_for_reviewed_creation', reasons: [],
      proposed_primary_clinic_id: i % 2 ? 66 : 72, membership_clinic_ids: [66, 72],
      primary_rule: 'oldest_recorded_treatment', primary_evidence: [{ clinic_id: i % 2 ? 66 : 72,
        source_contact_id: row.source_contact_id, treatment_id: 'SYNTHETIC-ACT', treatment_date: '2026-08-03', paid_evidence: false }],
    })) };
    audit.plan_sha256 = hash(audit);
    review = { source_audit_sha256: audit.plan_sha256, prepared_by: 'offline-test-reviewer', prepared_at: new Date(NOW).toISOString(),
      peer_evidence: [{ file: 'synthetic-only.json', sha256bytes: 'e'.repeat(64) }], decisions: audit.rows.map((row, i) => ({
        source_contact_id: row.source_contact_id, disposition: i < defer ? 'defer' : 'retain',
        reason: i < defer ? 'Synthetic ambiguous name; no merge authorized.' : 'Synthetic identity checks complete.', matching_rule: 'SYNTHETIC_RULE',
      })) };
  }
  rehash();
  const state = { data: { group_id: 29, clinic_ids: [66, 72], patients: [{ id_paciente: 11, public_id: 'pac_native_fixture',
    clinica_id: 72, nombre: 'Existing', apellidos: 'Native', email: 'native@example.invalid', telefono_movil: '699900001',
    telefono_secundario: null, dni: null, updatedAt: '2026-09-01 10:00:00' }], source_links: [], memberships: [] },
    transactions: 0, committed: 0, insertAttempts: 0, clock: NOW, failStage: null, failAt: count - defer,
    concurrentPrecommit: false, concurrentPostcommit: false, commitFailure: false, expireAfterInsert: false };
  const store = {
    async captureGroup() {
      if (state.concurrentPostcommit) {
        state.concurrentPostcommit = false;
        const imported = state.data.patients.find(row => row.id_paciente >= 1000);
        state.data.patients.push({ ...clone(imported), id_paciente: 9000, public_id: 'pac_concurrent_native' });
      }
      return clone(state.data);
    },
    async transaction(callback) {
      state.transactions++;
      const working = clone(state.data);
      let reads = 0;
      const result = await callback({
        async captureGroup() {
          if (++reads === 2 && state.concurrentPrecommit) working.patients.push({ id_paciente: 9500,
            clinica_id: 72, nombre: 'Concurrent', apellidos: 'Native', telefono_movil: '699900999' });
          return clone(working);
        },
        async insertPatient(operation, payload) {
          state.insertAttempts++;
          const id = 1000 + working.patients.filter(row => row.id_paciente >= 1000).length;
          working.patients.push({ id_paciente: id, ...clone(payload) });
          if (state.failStage === 'source' && state.insertAttempts === state.failAt) throw new Error('SIMULATED_SOURCE_WRITE_FAILURE');
          working.source_links.push({ paciente_id: id, source_contact_id: operation.source_contact_id, history_number: operation.history_number });
          if (state.failStage === 'membership' && state.insertAttempts === state.failAt) throw new Error('SIMULATED_MEMBERSHIP_WRITE_FAILURE');
          working.memberships.push(...operation.memberships.map(clinica_id => ({ paciente_id: id, clinica_id, es_principal: clinica_id === payload.clinica_id })));
          if (state.expireAfterInsert) state.clock = NOW + 7200000;
          return { patient_id: id, after_sha256: hash({ id, payload }) };
        },
      });
      if (state.commitFailure) throw new Error('SIMULATED_COMMIT_FAILURE');
      state.data = working;
      state.committed++;
      return result;
    },
  };
  const events = [];
  const journal = { append: async event => events.push(clone(event)) };
  const prepare = () => core.prepareNewPatients({ audit, sources, review, live: clone(state.data), now: new Date(NOW).toISOString() });
  const approve = pkg => ({ package_sha256: pkg.package_sha256, reviewed_by: 'offline-test-operator', acknowledge_native_create_race: true,
    automation_policy: 'hold', backup_manifest_sha256: 'b'.repeat(64), expires_at: new Date(NOW + 3600000).toISOString() });
  let publicCounter = 0;
  const apply = (pkg, overrides = {}) => core.executeNewPatients({ pkg, approval: approve(pkg), store, journal,
    now: () => state.clock, publicId: () => `pac_fixture_${++publicCounter}`, ...overrides });
  return { records, sources, state, store, events, journal, rehash, prepare, approve, apply,
    get audit() { return audit; }, get review() { return review; } };
}

test('reviewed 70-candidate fixture prepares exactly 59 retain / 11 defer and binds review hash without writes', () => {
  const f = fixture(70, 11), pkg = f.prepare();
  assert.equal(pkg.operations.length, 59);
  assert.equal(pkg.excluded.length, 11);
  assert.equal(pkg.identity_review_sha256, hash(f.review));
  assert.equal(pkg.expected_global_guard, core.globalGuard(f.state.data));
  assert.equal(pkg.messages_enabled, false);
  assert.equal(pkg.appointments_created, false);
  assert.equal(pkg.automation_policy, 'hold');
  assert.equal(pkg.native_create_uniqueness_guaranteed, false);
  assert.equal(f.state.transactions, 0);
  for (const operation of pkg.operations) {
    assert.doesNotMatch(JSON.stringify(operation), /WHATSAPP|SOURCE-ONLY-HEALTH|ALERGIAS|consent/i);
    assert.deepEqual(Object.keys(operation.payload).sort(), ['nombre', 'apellidos', 'dni', 'telefono_movil', 'telefono_secundario',
      'email', 'fecha_nacimiento', 'fecha_alta', 'clinica_id', 'idioma_preferido', 'paciente_conocido'].sort());
  }
});

test('complete reviewed decisions, unique IDs, source hashes and immutable approved package are required', () => {
  for (const mutate of [f => f.review.decisions.pop(), f => { f.review.decisions[1].source_contact_id = f.review.decisions[0].source_contact_id; },
    f => { f.review.source_audit_sha256 = 'wrong'; }, f => { f.review.decisions[0].reason = ''; }]) {
    const f = fixture(); mutate(f); assert.throws(f.prepare, /COMPLETE_IDENTITY_REVIEW_REQUIRED/);
  }
  const f = fixture(); f.sources.contacts.file.sha256 = 'changed'; assert.throws(f.prepare, /(?:SOURCE_FILE_HASH_MISMATCH|SOURCE_ROW_HASH_MISMATCH)/);
  const good = fixture(), pkg = good.prepare(); pkg.operations[0].payload.clinica_id = 1;
  assert.throws(() => core.verifyPackage(pkg), /INTEGRITY_MISMATCH/);
});

test('source ALTA is strict DMY local Madrid, validated against export coverage and calendar dates', () => {
  assert.equal(core.sourceCreated({ ALTA: '02-08-2026 10:00:00' }).utc, '2026-08-02T08:00:00.000Z');
  assert.equal(sqlDate('2026-08-02T08:00:00.000Z'), '2026-08-02 08:00:00.000');
  for (const ALTA of ['2026-08-02 10:00:00', '08-02-2026 10:00:00', '31-08-2026 25:00:00',
    '31-07-2026 10:00:00', '06-09-2026 10:00:00', '31-08-2026', '32-08-2026 10:00:00']) {
    assert.throws(() => core.sourceCreated({ ALTA }), /SOURCE_CREATION_NOT_WITHIN_CONFIRMED_COVERAGE/);
  }
});

test('future birth dates cannot enter a source-created patient', () => {
  const f = fixture(); f.records[0].values['F. NACIMIENTO'] = '03/08/2026'; f.rehash();
  assert.throws(f.prepare, /BIRTH|DOB|DEMOGRAPHICS/);
});

test('a deferred invalid birth date does not prevent preparing the retained subset', () => {
  const f = fixture(70, 12); f.records[0].values['F. NACIMIENTO'] = '03/08/2026'; f.rehash();
  const pkg = f.prepare();
  assert.equal(pkg.operations.length, 58); assert.equal(pkg.excluded.length, 12);
  assert(!pkg.operations.some(operation => operation.source_contact_id === f.records[0].values.IDCONTACTO));
});

test('NUM and source demographic baseline are preserved separately from display normalization', () => {
  const f = fixture(); f.records[0].values.NOMBRE = 'DEMOSTRACION';
  f.records[0].values['TELF. MOVIL'] = '+34 600 100 000'; f.rehash();
  const operation = f.prepare().operations[0];
  assert.equal(operation.source_fields.name, 'DEMOSTRACION');
  assert.equal(operation.payload.nombre, 'Demostracion');
  assert.equal(operation.source_fields.phone, '+34 600 100 000');
  assert.equal(operation.payload.telefono_movil, '600100000');
  assert.equal(operation.history_number, f.records[0].values.NUM);
  f.audit.rows[0].history_number = 'incorrect';
  const { plan_sha256, ...body } = f.audit; f.audit.plan_sha256 = hash(body);
  f.review.source_audit_sha256 = f.audit.plan_sha256;
  assert.throws(f.prepare, /HISTORY|NUM/);
});

test('exact identities normalize case, accents, punctuation, hyphens and token order conservatively', () => {
  const a = core.identityKeys({ name: 'Ána-Luz', surname: 'Pérez', phones: ['+34 600 100 001'] });
  const b = core.identityKeys({ name: 'PEREZ ANA', surname: 'LUZ', phones: ['0034600100001'] });
  assert.equal(a.name, b.name); assert.equal(a.phones[0], b.phones[0]); assert(core.intersects(a, b));
  assert(!core.intersects(core.identityKeys({ name: 'Julia', surname: 'Pérez' }), core.identityKeys({ name: 'Julia', surname: 'Torres' })));
});

test('59 creates and their source links/memberships commit together without appointments, consents or messages', async () => {
  const f = fixture(70, 11), result = await f.apply(f.prepare());
  assert.equal(result.created_patients, 59); assert.equal(result.appointments_created, 0);
  assert.equal(result.consent_mutations, 0); assert.equal(result.messages_enabled, false);
  assert.equal(f.state.transactions, 1); assert.equal(f.state.committed, 1);
  assert.equal(f.state.data.patients.length, 60); assert.equal(f.state.data.source_links.length, 59);
  assert.equal(f.state.data.memberships.length, 118);
  assert.deepEqual(f.events.map(row => row.phase), ['prepared_new_patients', 'validated_before_commit', 'committed_new_patients', 'post_commit_audit']);
});

for (const stage of ['source', 'membership']) test(`failure on final ${stage} insert rolls all 59 new patients back`, async () => {
  const f = fixture(70, 11), before = clone(f.state.data), pkg = f.prepare(); f.state.failStage = stage;
  await assert.rejects(f.apply(pkg), /SIMULATED_.*_WRITE_FAILURE/);
  assert.equal(f.state.insertAttempts, 59); assert.equal(f.state.committed, 0);
  assert.deepEqual(f.state.data, before); assert.equal(f.events.some(row => row.phase === 'committed_new_patients'), false);
});

test('exact global baseline must match before the first insert and source collisions never become new patients', async () => {
  const f = fixture(), pkg = f.prepare(); f.state.data.patients[0].apellidos = 'Locally edited after preparation';
  await assert.rejects(f.apply(pkg), /GLOBAL|BASELINE|SNAPSHOT/);
  assert.equal(f.state.insertAttempts, 0);
  const g = fixture(), gpkg = g.prepare(); g.state.data.patients[0].telefono_movil = gpkg.operations[0].payload.telefono_movil;
  await assert.rejects(g.apply(gpkg), /IDENTITY_COLLISION|GLOBAL|BASELINE|SNAPSHOT/); assert.equal(g.state.insertAttempts, 0);
});

test('history-number collisions are checked independently of source ID and demographics', async () => {
  const f = fixture(); f.state.data.source_links.push({ paciente_id: 11, source_contact_id: 'other-source', history_number: f.records[0].values.NUM });
  assert.throws(f.prepare, /NEW_PATIENT_HISTORY_NUMBER_NOW_EXISTS/);
  const g = fixture(), pkg = g.prepare();
  g.state.data.source_links.push({ paciente_id: 11, source_contact_id: 'other-source', history_number: pkg.operations[0].history_number });
  await assert.rejects(g.apply(pkg), /NEW_PATIENT_HISTORY_NUMBER_NOW_EXISTS/); assert.equal(g.state.insertAttempts, 0);
});

test('a concurrent native identity change before commit rolls back every import insert', async () => {
  const f = fixture(70, 11), before = clone(f.state.data), pkg = f.prepare(); f.state.concurrentPrecommit = true;
  await assert.rejects(f.apply(pkg), /CONCURRENT_NATIVE_PATIENT_OR_IDENTITY_CHANGE/);
  assert.equal(f.state.insertAttempts, 59); assert.equal(f.state.committed, 0); assert.deepEqual(f.state.data, before);
});

test('full replay preserves patients and later local edits without a second insert', async () => {
  const f = fixture(), pkg = f.prepare(); await f.apply(pkg);
  const imported = f.state.data.patients.find(row => row.id_paciente >= 1000); imported.nombre = 'Later local correction';
  const before = clone(f.state.data), inserts = f.state.insertAttempts, result = await f.apply(pkg);
  assert.equal(result.created_patients, 0); assert.equal(result.preserved_existing_source_patients, 2);
  assert.equal(f.state.insertAttempts, inserts); assert.deepEqual(f.state.data, before);
});

test('partial replay is not a valid recovery for an atomic batch and fails before writes', async () => {
  const f = fixture(), pkg = f.prepare(); f.state.data.source_links.push({ paciente_id: 11, source_contact_id: pkg.operations[0].source_contact_id });
  await assert.rejects(f.apply(pkg), /PARTIAL|BASELINE|GLOBAL|SNAPSHOT/); assert.equal(f.state.insertAttempts, 0);
});

test('approval hash, backup proof, race acknowledgement and expiry are mandatory; expiry before commit rolls back', async () => {
  const f = fixture(), pkg = f.prepare();
  for (const change of [{ package_sha256: 'changed' }, { backup_manifest_sha256: '' }, { acknowledge_native_create_race: false },
    { automation_policy: 'normal' }, { expires_at: new Date(NOW - 1).toISOString() }]) {
    await assert.rejects(f.apply(pkg, { approval: { ...f.approve(pkg), ...change } }), /EXPLICIT_APPROVAL_REQUIRED/);
  }
  assert.equal(f.state.transactions, 0);
  f.state.expireAfterInsert = true;
  await assert.rejects(f.apply(pkg), /APPROVAL_EXPIRED_BEFORE_COMMIT/);
  assert.equal(f.state.committed, 0); assert.equal(f.state.data.source_links.length, 0);
});

test('precommit journal/commit failure rolls back, but postcommit journal failure must not be called rollback', async () => {
  for (const phase of ['prepared_new_patients', 'validated_before_commit']) {
    const f = fixture(), pkg = f.prepare();
    await assert.rejects(f.apply(pkg, { journal: { append: async event => { if (event.phase === phase) throw new Error('DISK_FULL'); } } }), /DISK_FULL/);
    assert.equal(f.state.committed, 0); assert.equal(f.state.data.source_links.length, 0);
  }
  const f = fixture(), pkg = f.prepare(); f.state.commitFailure = true;
  await assert.rejects(f.apply(pkg), /SIMULATED_COMMIT_FAILURE/); assert.equal(f.state.data.source_links.length, 0);
  f.state.commitFailure = false;
  await assert.rejects(f.apply(pkg, { journal: { append: async event => { if (event.phase === 'committed_new_patients') throw new Error('AFTER_COMMIT_DISK_FULL'); } } }), /AFTER_COMMIT_DISK_FULL/);
  assert.equal(f.state.data.source_links.length, 2);
  assert.equal((await f.apply(pkg)).created_patients, 0);
});

test('postcommit native collision stops subsequent batches without pretending to roll back committed patients', async () => {
  const f = fixture(), pkg = f.prepare(); f.state.concurrentPostcommit = true;
  await assert.rejects(f.apply(pkg), /COMMITTED_PATIENT_IDENTITY_COLLISION_STOP_ALL_BATCHES/);
  assert.equal(f.state.committed, 1); assert.equal(f.state.data.source_links.length, 2);
  assert.equal(f.events.at(-1).phase, 'post_commit_audit'); assert(f.events.at(-1).conflicts.length > 0);
});

function sqlStub({ triggers = false } = {}) {
  const calls = [], state = { patient: null, fields: [], memberships: [], commits: 0, rollbacks: 0 };
  const connection = {
    async query(sql, params = []) {
      calls.push({ sql, params: clone(params) });
      if (sql.includes('information_schema.TRIGGERS')) return [triggers ? [{ TRIGGER_NAME: 'synthetic_trigger' }] : []];
      if (sql.startsWith('SET TRANSACTION')) return [[]];
      if (sql.startsWith('INSERT INTO Pacientes')) {
        const columns = [...sql.matchAll(/`([^`]+)`/g)].map(match => match[1]);
        state.patient = { id_paciente: 1000, ...Object.fromEntries(columns.map((column, i) => [column, params[i]])),
          alergias: null, antecedentes: null, medicacion: null, foto: null };
        return [{ insertId: 1000, affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO PatientCustomFields')) {
        state.fields.push({ field_key: params[2], source: params[6], source_column: params[7], value: params[4] }); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO PacienteClinicas')) { state.memberships.push({ clinica_id: params[1], es_principal: params[2] }); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('SELECT * FROM Pacientes')) return [[clone(state.patient)]];
      if (sql.startsWith('SELECT field_key')) return [clone(state.fields).sort((a, b) => a.field_key.localeCompare(b.field_key))];
      if (sql.startsWith('SELECT clinica_id, es_principal')) return [clone(state.memberships).sort((a, b) => a.clinica_id - b.clinica_id)];
      throw new Error('UNEXPECTED_TEST_SQL');
    },
    async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
    async commit() { state.commits++; calls.push({ sql: 'COMMIT' }); },
    async rollback() { state.rollbacks++; calls.push({ sql: 'ROLLBACK' }); state.patient = null; state.fields = []; state.memberships = []; },
  };
  return { calls, state, connection };
}

async function sourceRoundtripFixture() {
  const f = fixture(1); f.records[0].values.NOMBRE = 'DEMOSTRACION'; f.records[0].values.APELLIDOS = 'FICTICIA';
  f.records[0].values['TELF. MOVIL'] = '+34 600 100 000'; f.records[0].values.EMAIL = 'DEMO@EXAMPLE.INVALID'; f.rehash();
  const operation = f.prepare().operations[0], stub = sqlStub();
  const store = await createNewPatientsStore(stub.connection, { groupId: 29, readOnly: false });
  await store.transaction(tx => tx.insertPatient(operation, { ...operation.payload, public_id: 'pac_roundtrip_synthetic' }, {
    source_account: core.ACCOUNT, package_sha256: 'a'.repeat(64), reviewed_by: 'offline-test', imported_at: new Date(NOW).toISOString(),
  }));
  const marker = stub.state.fields.find(row => row.field_key === 'cliniccloud_contact_snapshot');
  const { canonicalImportedBaseline } = require('../cliniccloud-import-snapshot');
  const rows = [{ source_column: marker.source_column, source_contact_id: operation.source_contact_id,
    history_number: operation.history_number, canonical_snapshot: marker.value }];
  const patient = { id: 1000, clinic_id: operation.payload.clinica_id, source_contact_ids: [operation.source_contact_id],
    last_imported_fields: canonicalImportedBaseline(rows), last_imported_local_fields: canonicalImportedBaseline(rows, 'stored_fields'),
    fields: canonicalImportedBaseline(rows, 'stored_fields') };
  const contact = normalizeContacts(f.records, f.sources.contacts.file.sha256)[0];
  const plan = () => require('../../lib/cliniccloud-import/planner').planContacts([contact], [], [patient]).actions[0];
  return { contact, patient, plan };
}

test('roundtrip of identical original export has no patch after canonical name/email/phone storage', async () => {
  const f = await sourceRoundtripFixture(), action = f.plan();
  assert.notEqual(f.patient.last_imported_fields.name, f.patient.fields.name);
  assert.notEqual(f.patient.last_imported_fields.email, f.patient.fields.email);
  assert.notEqual(f.patient.last_imported_fields.phone, f.patient.fields.phone);
  assert.equal(action.action, 'link_patient'); assert.deepEqual(action.fields_patch, {}); assert.deepEqual(action.reasons, []);
});

test('roundtrip legitimate source correction compares current value with stored baseline, not raw original formatting', async () => {
  const f = await sourceRoundtripFixture(); f.contact.fields.phone = '600200888';
  const action = f.plan();
  assert.equal(action.action, 'link_patient'); assert.deepEqual(action.fields_patch, { phone: '600200888' });
  assert.deepEqual(action.reasons, []);
});

test('roundtrip a real local edit conflicting with a source correction is never overwritten', async () => {
  const f = await sourceRoundtripFixture(); f.contact.fields.phone = '600200888'; f.patient.fields.phone = '600300777';
  const action = f.plan();
  assert.equal(action.action, 'review'); assert(action.reasons.includes('LOCAL_FIELD_CONFLICT:phone'));
  assert.equal(action.fields_patch.phone, undefined);
});

test('real SQL adapter writes only allowlisted demographic/source/membership tables and excludes raw WHATSAPP and health', async () => {
  const f = fixture(), operation = f.prepare().operations[0], s = sqlStub();
  const store = await createNewPatientsStore(s.connection, { groupId: 29, readOnly: false });
  const payload = { ...operation.payload, public_id: 'pac_synthetic_sql' };
  const marker = { source_account: core.ACCOUNT, package_sha256: 'a'.repeat(64), reviewed_by: 'offline-test', imported_at: new Date(NOW).toISOString() };
  await assert.rejects(store.insertPatient(operation, payload, marker), /WRITE_TRANSACTION_REQUIRED/);
  const result = await store.transaction(tx => tx.insertPatient(operation, payload, marker));
  assert.equal(result.patient_id, 1000); assert.equal(s.state.commits, 1);
  assert.equal(s.state.fields.length, 2); assert.equal(s.state.memberships.length, 2);
  const mutations = s.calls.filter(call => /^(?:INSERT|UPDATE|DELETE)/.test(call.sql));
  assert(mutations.every(call => /^INSERT INTO (?:Pacientes |PatientCustomFields |PacienteClinicas )/.test(call.sql)));
  assert.doesNotMatch(JSON.stringify(mutations), /WHATSAPP|SOURCE-ONLY-HEALTH|consent|alergias|antecedentes|medicacion/i);
  const snapshot = JSON.parse(s.state.fields.find(row => row.field_key === 'cliniccloud_contact_snapshot').value);
  assert.equal(snapshot.contact.idContacto, operation.source_contact_id);
  assert.equal(snapshot.contact.num, operation.history_number);
  assert.equal(snapshot.source_created.raw, '02-08-2026 10:00:00');
  assert.equal(snapshot.import.automation_policy, 'hold'); assert.equal(snapshot.import.messages_enabled, false);
});

test('SQL triggers, read-only mode and unexpected payload columns stop before SQL mutations', async () => {
  const f = fixture(), operation = f.prepare().operations[0];
  const t = sqlStub({ triggers: true }); await assert.rejects(createNewPatientsStore(t.connection, { groupId: 29, readOnly: false }), /TRIGGERS_REQUIRE_REVIEW/);
  const s = sqlStub(), readonly = await createNewPatientsStore(s.connection, { groupId: 29 });
  await assert.rejects(readonly.transaction(() => {}), /WRITE_TRANSACTION_REQUIRED/);
  const writable = await createNewPatientsStore(s.connection, { groupId: 29, readOnly: false });
  await assert.rejects(writable.transaction(tx => tx.insertPatient(operation, { ...operation.payload, public_id: 'pac_synthetic', consentimiento: true }, {})), /COLUMN_ALLOWLIST_VIOLATION/);
  assert.equal(s.calls.some(call => call.sql.startsWith('INSERT')), false);
});

test('the import SQL adapter is isolated from application models, hooks, jobs and external messaging', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../lib/cliniccloud-import/new-patients-store.js'), 'utf8');
  assert.doesNotMatch(source, /require\([^\n]*(?:models|controllers|jobRequests|Automation|whatsapp)/i);
  assert.doesNotMatch(source, /UPDATE\s+(?:Pacientes|Lead|Consent)|DELETE\s+FROM|INSERT\s+INTO\s+(?:Job|Consent|Citas|Lead)/i);
  assert.match(source, /READ COMMITTED/);
});
