'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const legacy = require('../bs-consent-catalog-withdrawal');
const operator = require('../bs-consent-requirements-retirement');
const configuration = { database: 'owned_fictitious_requirement_retirement', password: 'fixture_never_printed' };
const info = { commit: 'a'.repeat(40), pins: { owned_fixture: 'b'.repeat(64) } };
const now = Date.now(), generatedAt = new Date(now).toISOString(), mutationAt = generatedAt.slice(0, 19).replace('T', ' ');
const clone = value => structuredClone(value);

function state() {
  const ids = [46, ...Array.from({ length: 93 }, (_, i) => 2000 + i)];
  const requirements = [{ id: 2, tratamiento_id: 46, clinica_id: 66, clinic_template_id: 2, catalog_template_id: null,
    requirement_scope: 'treatment', condition_key: null, required: 1, blocking_policy: 'hard', sort_order: 0,
    createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' },
  ...Array.from({ length: 103 }, (_, i) => ({ id: i + 3, tratamiento_id: 2000 + (i % 93), clinica_id: 66,
    clinic_template_id: i === 102 ? 67 : 3, catalog_template_id: null, requirement_scope: 'treatment', condition_key: null,
    required: i < 100 ? 1 : 0, blocking_policy: i < 100 ? 'hard' : 'soft', sort_order: i,
    createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' }))];
  const protectedState = {};
  for (const key of ['versions', 'requirements', 'documents', 'packages', 'global_catalog', 'global_catalog_versions', 'other_clinic_templates']) {
    protectedState[key] = key === 'requirements' ? legacy.digest(requirements) : legacy.digest([{ id: key, status: 'owned_fixture' }]);
  }
  return { identity_sha256: hash('owned_database'), configuration_sha256: hash(configuration), schema_sha256: hash('owned_schema'),
    clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }],
    templates: legacy.EXPECTED_IDS.map(id => ({ id, clinic_id: 66, name: 'Owned fictitious template ' + id,
      purpose: legacy.DATA_PROTECTION_IDS.includes(id) ? 'data_protection' : id === 67 ? 'clinical_image' : 'clinical',
      status: 'active', is_default: id % 2, public_id: 'owned_fixture_' + id, createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-02 00:00:00' })),
    protected: protectedState, requirements, treatment_ids: ids,
    treatments: ids.map(id => ({ id_tratamiento: id, clinica_id: 66, nombre: 'Owned treatment ' + id,
      clinical_config: { retained: true }, activo: 1, precio_base: '10.00', updatedAt: '2026-01-01 00:00:00' })),
    requirement_schema_sha256: hash('owned_requirement_schema'), other_requirements: legacy.digest([{ id: 900, clinica_id: 1 }]) };
}
function authority(before = state()) {
  return { literal: operator.AUTHORITY_LITERAL, decision_date: '2026-10-15', timezone: 'Europe/Madrid', scope: {
    clinic_ids: [66, 72], group_id: 29, requirements: 104, non_data_protection_headers: 81,
    preserved_data_protection_header_ids: legacy.DATA_PROTECTION_IDS,
    audited_requirements_sha256: hash(before.requirements) } };
}
function plan() { const before = state(); return operator.makePlan({ before, info, authority: authority(before), generatedAt }); }
function afterState(p = plan()) {
  const after = clone(p.before);
  after.templates.forEach(row => { if (p.header_operations.some(op => op.id === row.id)) Object.assign(row, { status: 'archived', is_default: 0, updatedAt: mutationAt }); });
  after.requirements = [];
  after.protected.requirements = legacy.digest([]);
  return after;
}
function fixture({ stale = false, busy = false, lostLock = false, sourceDrift = false, authorityDrift = false,
  failBackup = false, failJournal = null, failHeaderAt = null, failDeleteAt = null, extraMutation = null,
  failCommit = false, failIndependent = false, replay = false, partial = false } = {}) {
  const p = plan(), calls = [], backups = [], events = [];
  let current = replay || partial ? afterState(p) : clone(p.before), saved, transaction = false, headerWrites = 0, deletes = 0;
  if (partial) { current.requirements = [clone(p.before.requirements[0])]; current.protected.requirements = legacy.digest(current.requirements); }
  if (stale) current.treatments[0].nombre = 'A later human edit';
  const connection = {
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: busy ? 0 : 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT IS_USED_LOCK')) return [[{ owned: lostLock ? 0 : 1 }]];
      if (sql.startsWith('SET TRANSACTION')) return [[], []];
      if (sql.startsWith('SELECT DATE_FORMAT')) return [[{ mutation_at: mutationAt }]];
      assert(transaction); assert(backups.length === 1); assert(events.some(event => event.phase === 'backup_durable_before_mutation'));
      if (sql.startsWith('UPDATE ClinicConsentTemplates')) {
        headerWrites++; if (headerWrites === failHeaderAt) return [{ affectedRows: 0 }];
        const [at, id, clinicId, purpose, status, isDefault, oldAt] = values;
        const row = current.templates.find(item => item.id === id);
        assert.equal(row.clinic_id, clinicId); assert.equal(row.purpose, purpose); assert.notEqual(purpose, 'data_protection');
        assert.equal(row.status, status); assert.equal(row.is_default, isDefault); assert.equal(row.updatedAt, oldAt);
        Object.assign(row, { status: 'archived', is_default: 0, updatedAt: at });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('DELETE FROM TreatmentConsentRequirements')) {
        deletes++; if (deletes === failDeleteAt) return [{ affectedRows: 0 }];
        const id = values[0], row = current.requirements.find(item => item.id === id);
        assert.deepEqual(values, operator.FIELDS.map(field => row[field]));
        current.requirements = current.requirements.filter(item => item.id !== id);
        current.protected.requirements = legacy.digest(current.requirements);
        if (extraMutation) extraMutation(current);
        return [{ affectedRows: 1 }];
      }
      assert.fail('Unexpected SQL ' + sql);
    },
    beginTransaction: async () => { assert(!transaction); saved = clone(current); transaction = true; calls.push({ sql: 'BEGIN' }); },
    rollback: async () => { if (transaction) current = clone(saved); transaction = false; calls.push({ sql: 'ROLLBACK' }); },
    commit: async () => { calls.push({ sql: 'COMMIT' }); if (failCommit) throw Error('owned_commit_uncertainty'); transaction = false; },
  };
  const run = extra => operator.execute({ connection, plan: p, info, authority: authority(), configuration,
    backupPath: '/home/ubuntu/secure-imports/owned_not_written_retirement_fixture.json',
    saveBackup: (_filename, backup) => { if (failBackup) throw Error('owned_backup_failure'); backups.push(clone(backup)); },
    journal: { append: async event => { if (event.phase === failJournal) throw Error('owned_journal_failure'); events.push(clone(event)); } },
    captureState: async (_c, _configuration, options) => {
      if (options.lock) assert.deepEqual(options.expectedTreatmentIds, p.before.treatment_ids);
      return clone(current);
    },
    readIndependent: async (_configuration, ids) => { assert.deepEqual(ids, p.before.treatment_ids); if (failIndependent) throw Error('owned_independent_failure'); return clone(current); },
    checkSource: () => sourceDrift ? { ...info, commit: 'c'.repeat(40) } : info,
    checkAuthority: () => authorityDrift ? { ...authority(), literal: 'Changed' } : authority(), ...extra });
  return { p, run, current: () => current, calls, backups, events };
}

test('literal authority, date, exact scope and independently audited full requirement hash are required', () => {
  assert.doesNotThrow(() => operator.validateAuthority(authority()));
  for (const mutate of [a => a.literal = 'Retirar algunos requisitos', a => a.decision_date = '2026-10-14',
    a => a.timezone = 'UTC', a => a.scope.requirements = 103, a => a.scope.clinic_ids = [66],
    a => a.scope.non_data_protection_headers = 86, a => a.scope.preserved_data_protection_header_ids = [],
    a => a.scope.audited_requirements_sha256 = 'invalid']) {
    const broken = authority(); mutate(broken); assert.throws(() => operator.validateAuthority(broken));
  }
  const before = state(), forged = authority(); forged.scope.audited_requirements_sha256 = hash('other inventory');
  assert.throws(() => operator.makePlan({ before, info, authority: forged, generatedAt }), /AUDITED_REQUIREMENTS_CHANGED/);
});
test('plan retires exact 104 links and 81 headers while retaining five privacy headers and all protected snapshots', () => {
  const p = plan(); assert.equal(p.requirement_operations.length, 104); assert.equal(p.header_operations.length, 81);
  assert.deepEqual(p.categories, { 'clinical:hard': 100, 'clinical:soft': 2, 'clinical_image:soft': 1, 'data_protection:hard': 1 });
  assert.equal(p.before.treatment_ids.length, 94);
  assert(p.header_operations.every(op => !legacy.DATA_PROTECTION_IDS.includes(op.id)));
  assert(p.requirement_operations.some(op => op.id === 2));
  assert.equal(p.policy.no_runtime_bypass, true); assert.match(p.caution, /extraction\/PRP parent guard/);
});
test('same-count reconfiguration, new requirements, moved rows, catalog references and changed privacy identity are rejected', () => {
  for (const mutate of [s => s.requirements[1].blocking_policy = 'soft', s => s.requirements[0].tratamiento_id = 2000,
    s => s.requirements[1].catalog_template_id = 3, s => s.requirements[1].clinica_id = 72,
    s => s.requirements.push({ ...s.requirements[1], id: 10000 }), s => s.requirements.pop(),
    s => s.templates.find(t => t.id === 2).purpose = 'clinical', s => s.treatments[0].clinica_id = 72,
    s => s.treatment_ids.reverse(), s => s.treatment_ids.pop(), s => s.templates[0].clinic_id = 35]) {
    const before = state(); mutate(before); assert.throws(() => operator.makePlan({ before, info, authority: authority(), generatedAt }));
  }
  const before = state(); before.templates.find(t => t.id === 3).status = 'archived'; before.templates.find(t => t.id === 3).is_default = 0;
  assert.throws(() => operator.makePlan({ before, info, authority: authority(), generatedAt }), /HEADER_SCOPE_CHANGED/);
});
test('complete approval, source, protected schema, row images and freshness are sealed', () => {
  const p = plan(); assert.doesNotThrow(() => operator.validatePlan(p, info, authority(), configuration, { now }));
  for (const patch of [{ target: 'dev' }, { requirement_operations: [] }, { header_operations: [] }, { policy: { no_dispatch: false } },
    { source: { ...info, commit: 'c'.repeat(40) } }, { plan_sha256: 'e'.repeat(64) }]) {
    assert.throws(() => operator.validatePlan({ ...p, ...patch }, info, authority(), configuration, { now }));
  }
  assert.throws(() => operator.validatePlan(p, info, authority(), configuration, { now: now + 7200001 }), /EXPIRED/);
  assert.throws(() => operator.validatePlan(p, info, authority(), { ...configuration, database: 'other' }, { now }));
});
test('verification permits only approved header fields and exact link removal, never privacy/history/treatments', () => {
  const p = plan(), after = afterState(p); assert(operator.verifyAfter(p, after, mutationAt));
  for (const mutate of [s => s.templates.find(t => t.id === 2).status = 'archived', s => s.templates.find(t => t.id === 73).is_default = 0,
    s => s.treatments[0].clinical_config.retained = false, s => s.treatments[0].precio_base = '0.00',
    s => s.protected.documents.sha256 = hash('changed signature'), s => s.protected.packages.sha256 = hash('changed issued token'),
    s => s.protected.versions.sha256 = hash('changed version'), s => s.other_requirements.sha256 = hash('another clinic changed'),
    s => s.schema_sha256 = hash('changed schema'), s => s.requirement_schema_sha256 = hash('changed FK')]) {
    const broken = clone(after); mutate(broken); assert.throws(() => operator.verifyAfter(p, broken, mutationAt));
  }
});
test('actual capture takes sorted treatment UPDATE anchors before any legacy header or requirement query', async () => {
  const ids = state().treatment_ids, seen = [];
  const c = { query: async (sql, values) => { seen.push(sql);
    if (sql.startsWith('SELECT * FROM Tratamientos')) { assert.match(sql, /ORDER BY id_tratamiento LIMIT 95 FOR UPDATE$/); assert.deepEqual(values, [ids]); return [state().treatments]; }
    assert.match(sql, /^SELECT DATABASE/); assert.equal(seen.length, 2); throw Error('owned_stop_after_anchor_order_verified');
  } };
  await assert.rejects(operator.capture(c, configuration, { lock: true, expectedTreatmentIds: ids }), /owned_stop_after_anchor_order_verified/);
  assert.equal(seen.length, 2);
});
test('successful transaction backs up full 104 rows before 81 updates/104 complete-column CAS deletes', async () => {
  const f = fixture(), receipt = await f.run();
  assert.equal(receipt.status, 'committed_and_verified'); assert.equal(receipt.changed_headers, 81); assert.equal(receipt.retired_requirements, 104);
  assert.equal(f.backups.length, 1); assert.deepEqual(f.backups[0].before, f.p.before);
  assert.equal(f.backups[0].before.requirements.length, 104);
  assert.equal(f.calls.filter(call => call.sql.startsWith('UPDATE')).length, 81);
  const deletes = f.calls.filter(call => call.sql.startsWith('DELETE')); assert.equal(deletes.length, 104);
  assert(deletes.every(call => call.values.length === 12 && call.sql.includes('`updatedAt` <=> ?')));
  assert.equal(f.events.at(-1).phase, 'committed_and_independently_verified');
  assert.deepEqual(f.current().templates.filter(t => t.purpose === 'data_protection'), f.p.before.templates.filter(t => t.purpose === 'data_protection'));
  assert.deepEqual(f.current().treatments, f.p.before.treatments);
});
test('dry run exercises every DML and independently proves rollback restored all original rows', async () => {
  const f = fixture(), receipt = await f.run({ dryRun: true });
  assert.equal(receipt.status, 'rolled_back_and_verified'); assert.equal(receipt.retired_requirements, 0);
  assert.equal(f.calls.filter(call => call.sql.startsWith('DELETE')).length, 104); assert.deepEqual(f.current(), f.p.before);
  assert(!f.calls.some(call => call.sql === 'COMMIT'));
});
test('exact replay does zero DML, partial retirement or later human edits stop without completing old work', async () => {
  const f = fixture({ replay: true }), receipt = await f.run();
  assert.equal(receipt.status, 'replay_preserved'); assert.equal(receipt.changed_headers, 0); assert.equal(receipt.retired_requirements, 0);
  assert.equal(f.backups.length, 0); assert(!f.calls.some(call => /^(UPDATE|DELETE)/.test(call.sql)));
  for (const options of [{ partial: true }, { stale: true }, { replay: true, stale: true }]) {
    const bad = fixture(options); await assert.rejects(bad.run()); assert(!bad.calls.some(call => /^(UPDATE|DELETE)/.test(call.sql)));
  }
});
test('locks, stale state, authority/source drift and nondurable intent prevent any mutation', async () => {
  for (const options of [{ busy: true }, { lostLock: true }, { stale: true }, { sourceDrift: true }, { authorityDrift: true },
    { failBackup: true }, { failJournal: 'backup_durable_before_mutation' }, { failJournal: 'before_exact_header_and_requirement_cas' }]) {
    const f = fixture(options); await assert.rejects(f.run());
    assert(!f.calls.some(call => /^(UPDATE|DELETE|COMMIT)/.test(call.sql)));
  }
});
test('failed CAS halfway through header updates or link deletes restores all rows, including defaults', async () => {
  for (const options of [{ failHeaderAt: 40 }, { failDeleteAt: 50 }, { failJournal: 'headers_requirements_and_protected_evidence_verified_before_commit' }]) {
    const f = fixture(options); await assert.rejects(f.run()); assert.deepEqual(f.current(), f.p.before);
    assert(!f.calls.some(call => call.sql === 'COMMIT'));
  }
});
test('unexpected treatment/patient/package/other-clinic changes before commit abort atomically', async () => {
  for (const extraMutation of [s => s.treatments[0].activo = 0, s => s.protected.documents.sha256 = hash('changed_document'),
    s => s.protected.packages.sha256 = hash('changed_link'), s => s.other_requirements.sha256 = hash('other_clinic')]) {
    const f = fixture({ extraMutation }); await assert.rejects(f.run()); assert.deepEqual(f.current(), f.p.before);
  }
});
test('ambiguous commit or failure after commit requires private journal review, never claims rollback success', async () => {
  for (const options of [{ failCommit: true }, { failIndependent: true }, { failJournal: 'committed' }]) {
    const f = fixture(options); await assert.rejects(f.run(), /COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW/);
    assert(f.events.some(event => event.phase === 'commit_outcome_requires_private_review_no_blind_retry'));
  }
});
test('CLI cannot broaden to patient-data headers, another clinic/DB, runtime exemption or dispatch', () => {
  const base = ['--mode', 'prepare', '--target', 'crm', '--authority', '/owned.json', '--private-output', '/owned-plan.json'];
  assert.equal(operator.parseOptions(base)['--mode'], 'prepare');
  for (const args of [[], [...base, '--include-patient-data', 'true'], [...base, '--send', 'true'], [...base, '--runtime-bypass', 'true'],
    base.map(value => value === 'crm' ? 'dev' : value), [...base, '--mode', 'apply']]) assert.throws(() => operator.parseOptions(args));
});
test('only header UPDATE and requirement DELETE exist; no patient/runtime/activation DML is introduced', () => {
  const text = fs.readFileSync(require.resolve('../bs-consent-requirements-retirement'), 'utf8');
  assert.deepEqual([...text.matchAll(/UPDATE ([A-Za-z_]+)/g)].map(match => match[1]), ['ClinicConsentTemplates']);
  assert.deepEqual([...text.matchAll(/DELETE FROM ([A-Za-z_]+)/g)].map(match => match[1]), ['TreatmentConsentRequirements']);
  assert(!/\b(?:INSERT INTO|ALTER TABLE|TRUNCATE)\b/.test(text));
  assert(!/require\(['"][^'"]*(?:\/models|app\.js)['"]\)/.test(text));
  assert(operator.PIN_FILES.includes('src/scripts/bs-consent-requirements-retirement.js'));
  assert(operator.PIN_FILES.includes('src/scripts/tests/bs_consent_requirements_retirement.test.js'));
  assert.equal(operator.LOCK_KEY, legacy.LOCK_KEY);
});
