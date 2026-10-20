'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const planner = require('../../lib/cliniccloud-import/bs-program-catalog-closure');
const operator = require('../bs-program-catalog-closure');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const snapshot = { target: 'crm', group_id: 29, captured_at: '2026-10-20T15:00:00.000Z',
    clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }],
    configuration: { protected: ['rooms', 'treatments', 'equipment', 'professionals'] }, revisions: [],
    programs: planner.SPECS.map(spec => ({ id: spec.id, public_id: spec.public_id, clinic_id: spec.clinic_id,
      name: spec.reference, kind: 'program', status: 'draft', total_price: spec.id === 22 ? '250.00' : spec.id === 25 ? '430.00' : '670.00',
      price_profile: null, cadence: null, notes: 'Clinical conditions, indication and source preserved.', version_number: 2,
      created_by: 1, updated_by: 1, created_at: '2026-09-27 00:00:00', updated_at: '2026-09-27 00:00:00',
      request_key: `source-${spec.id}`, request_payload_hash: 'a'.repeat(64),
      appointments: spec.treatments.map((id, index) => ({ key: `s${index + 1}`, label: `Visit ${index + 1}`,
        treatment_ids: [id], offset_days: index * spec.source_cadence.interval_days })) })) };
  const decision = { version: 1, scope: planner.VERSION, authorized_at: '2026-10-20T14:59:00.000Z',
    authority_reference: 'Explicit task-scoped user authority, 20 October 2026',
    authority_text: 'User approves the corporate programme total at 21 percent and explicitly preserves GLP1 as three medical reviews for 250 euros without VAT or a pen.',
    corporate_program_tax_percent: 21, default_interval_days: 15, glp1_three_medical_reviews_no_vat: true, activation_ids: [22, 25, 26] };
  const createdAt = '2026-10-20T15:01:00.000Z';
  const initial = planner.buildPlan({ snapshot, decision, createdAt });
  const previews = initial.operations.map(operation => ({ program_id: operation.program_id, expected_version: operation.expected_version,
    before_sha256: operation.before_sha256, checked_at: '2026-10-20T15:00:30.000Z', item: { ...clone(operation.after), status: 'active',
      clinic_id: operation.clinic_id, version: 0, summary: { ready_for_activation: true, issues: [] }, commercial_ready: true, commercial_issues: [] } }));
  const plan = planner.buildPlan({ snapshot, decision, previews, createdAt });
  const bundle = { mode: 'published_canonical_service_select_only_not_http', target: 'crm', actor_id: 1, snapshot,
    backup_sha256: hash(snapshot), previews, previews_sha256: hash(previews), plan, configuration_and_programs_unchanged: true,
    source: { source_commit: 'a'.repeat(40), loaded_source_files: [{ path: 'service.js', sha256: 'b'.repeat(64) }] } };
  const records = [], current = clone(snapshot), calls = [];
  return { bundle, records, current, calls, args: { bundle, approvedSha256: plan.package_sha256,
    journal: { append: record => records.push(clone(record)) }, capture: async () => clone(current),
    now: () => Date.parse('2026-10-20T15:02:00.000Z'), update: async operation => {
      calls.push(operation.program_id); const index = current.programs.findIndex(row => row.id === operation.program_id);
      current.programs[index] = { ...current.programs[index], ...clone(operation.after), version_number: operation.expected_version + 1, updated_by: 1 };
      current.revisions.push({ id: 100 + operation.program_id, program_id: operation.program_id, version_number: operation.expected_version + 1,
        actor_id: 1, snapshot: clone(current.programs[index]) });
    } } };
}
test('published service application records durable intent before every canonical update and verifies each immutable revision', async () => {
  const f = fixture(), originalUpdate = f.args.update;
  f.args.update = async operation => { assert.equal(f.records.at(-1).phase, 'intent'); await originalUpdate(operation); };
  const result = await operator.applyBundle(f.args);
  assert.deepEqual(f.calls, [25, 26, 22]); assert.equal(result.outcomes.length, 3);
  assert.ok(result.outcomes.every(outcome => outcome.state === 'applied_verified'));
  assert.equal(result.protected_domain_dml, 0); assert.equal(result.messages_sent, 0);
  assert.deepEqual(f.current.configuration, f.bundle.snapshot.configuration);
});
test('replay recognizes audited prior writes and never adds a second version, revision or update', async () => {
  const f = fixture(); await operator.applyBundle(f.args); const calls = f.calls.length, revisions = f.current.revisions.length;
  const replay = await operator.applyBundle(f.args);
  assert.equal(f.calls.length, calls); assert.equal(f.current.revisions.length, revisions);
  assert.ok(replay.outcomes.every(outcome => outcome.state === 'already_applied_verified'));
});
test('expired or unapproved package cannot enter any update', async () => {
  for (const patch of [{ approvedSha256: 'c'.repeat(64) }, { now: () => Date.parse('2026-10-20T16:00:00Z') },
    { now: () => Date.parse('2026-10-20T14:59:59Z') }]) {
    const f = fixture(); await assert.rejects(operator.applyBundle({ ...f.args, ...patch }), /APPROVAL_OR_FRESHNESS/);
    assert.equal(f.calls.length, 0);
  }
});
test('a concurrent full-row programme edit or protected configuration change stops writes', async () => {
  for (const mutate of [f => { f.current.programs[0].notes = 'Concurrent human edit'; },
    f => { f.current.configuration.protected.push('new equipment'); }]) {
    const f = fixture(); mutate(f); await assert.rejects(operator.applyBundle(f.args), /CONCURRENT_CHANGE|PROTECTED_STATE_CHANGED/);
    assert.equal(f.calls.length, 0);
  }
});
test('a lost update response is never retried automatically and replay verifies the committed result', async () => {
  const f = fixture(), originalUpdate = f.args.update;
  f.args.update = async operation => { await originalUpdate(operation); throw Error('transport uncertain'); };
  await assert.rejects(operator.applyBundle(f.args), /transport uncertain/); assert.equal(f.calls.length, 1);
  f.args.update = originalUpdate; const result = await operator.applyBundle(f.args);
  assert.equal(result.outcomes[0].state, 'already_applied_verified'); assert.equal(f.calls.length, 3);
});
test('missing, duplicated or wrong-actor revision is not accepted as a successful update', async () => {
  for (const corrupt of [f => f.current.revisions.pop(), f => { f.current.revisions[0].actor_id = 99; },
    f => f.current.revisions.push(clone(f.current.revisions[0]))]) {
    const f = fixture(), originalUpdate = f.args.update;
    f.args.update = async operation => { await originalUpdate(operation); corrupt(f); };
    await assert.rejects(operator.applyBundle(f.args), /POST_APPLY_VERIFICATION_FAILED/); assert.equal(f.calls.length, 1);
  }
});
test('published source drift stops before canonical update even when programme snapshots remain unchanged', async () => {
  const f = fixture(); f.args.assertPublishedSource = () => { throw Error('SOURCE_CHANGED'); };
  await assert.rejects(operator.applyBundle(f.args), /SOURCE_CHANGED/); assert.equal(f.calls.length, 0);
});
test('full-row CAS tolerates SQL versus Sequelize timestamp representation but no other field change', () => {
  const before = fixture().bundle.snapshot.programs[0], current = clone(before);
  current.created_at = new Date('2026-09-27T00:00:00Z'); current.updated_at = '2026-09-27T00:00:00.000Z';
  assert.doesNotThrow(() => operator.assertFullRow(before, current));
  current.request_payload_hash = 'c'.repeat(64); assert.throws(() => operator.assertFullRow(before, current), /FULL_ROW_CAS_CONFLICT/);
});
test('SQL guard admits only selects in preparation and only canonical programme/revision writes after locked CAS', () => {
  const operation = { program_id: 22 }, write = { writable: true, operation, casVerified: true };
  assert.equal(operator.sqlAllowed('SELECT * FROM TreatmentPrograms', { writable: false }), true);
  assert.equal(operator.sqlAllowed('SELECT * FROM TreatmentPrograms FOR UPDATE', write), true);
  assert.equal(operator.sqlAllowed('START TRANSACTION;', write), true);
  assert.equal(operator.sqlAllowed('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;', write), true);
  assert.equal(operator.sqlAllowed('UPDATE `TreatmentPrograms` SET status=$1 WHERE id=$2', write), true);
  assert.equal(operator.sqlAllowed('INSERT INTO `TreatmentProgramRevisions` (program_id) VALUES ($1)', write), true);
  for (const sql of ['UPDATE Tratamientos SET activo=1', 'UPDATE CitasPacientes SET estado=1', 'DELETE FROM TreatmentPrograms',
    'INSERT INTO PatientVouchers(id) VALUES(1)', 'ALTER TABLE TreatmentPrograms ADD COLUMN other INT', 'SET GLOBAL general_log=1',
    "SELECT * FROM TreatmentPrograms INTO OUTFILE '/tmp/export'", "SELECT LOAD_FILE('/secret')"]) {
    assert.equal(operator.sqlAllowed(sql, write), false, sql);
  }
  assert.equal(operator.sqlAllowed('UPDATE TreatmentPrograms SET status=1', { writable: false, operation, casVerified: true }), false);
  assert.equal(operator.sqlAllowed('UPDATE TreatmentPrograms SET status=1', { writable: true, operation }), false);
  assert.equal(operator.sqlAllowed('UPDATE TreatmentPrograms SET status=1', { ...write, operation: { program_id: 11 } }), false);
});
test('operator explicitly uses the published service and minimum model factories, never application bootstrap or jobs', () => {
  const source = fs.readFileSync(require.resolve('../bs-program-catalog-closure'), 'utf8');
  assert.match(source, /context\.service\.update/); assert.match(source, /expected_version/);
  assert.match(source, /opts\?\.lock && opts\.transaction/); assert.match(source, /assertFullRow\(operation.before, raw\)/);
  assert.doesNotMatch(source, /requirePublished\(['"]models(?:\/index)?['"]\)/);
  assert.doesNotMatch(source, /require\([^\n]*(?:app\.js|worker|cron)/);
  assert.match(source, /fs\.fsyncSync/); assert.match(source, /models_index_loaded: false/);
});
