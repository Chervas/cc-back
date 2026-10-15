'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const operator = require('../bs-consent-catalog-withdrawal');

const configuration = { database: 'owned_fictitious_consent_withdrawal', user: 'fixture', password: 'never_emitted' };
const info = { commit: 'a'.repeat(40), pins: { owned_fixture_only: 'b'.repeat(64) } };
const now = Date.now();
const mutationAt = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
const clone = value => structuredClone(value);
const dataProtectionIds = new Set([2, 73, 90, 92, 154]);

function state() {
  const protectedState = {};
  for (const key of ['versions', 'requirements', 'documents', 'packages', 'global_catalog', 'global_catalog_versions', 'other_clinic_templates']) {
    protectedState[key] = { count: 2, sha256: hash([{ fixture: key }]), statuses: { fixture_only: 2 } };
  }
  return { identity_sha256: hash('owned_database'), configuration_sha256: hash(configuration), schema_sha256: hash('owned_schema'),
    clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }],
    templates: operator.EXPECTED_IDS.map(id => ({ id, clinic_id: [2, 3, 70, 71, 73, 74, 75, 76, 77, 248].includes(id) ? 66 : 72,
      public_id: `owned_template_${id}`, purpose: dataProtectionIds.has(id) ? 'data_protection' : 'clinical',
      name: `Owned fictitious template ${id}`, status: 'active', is_default: 1,
      createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-02 00:00:00' })), protected: protectedState };
}
function plan(includePatientData = false) {
  return operator.makePlan({ before: state(), info, includePatientData, generatedAt: new Date(now).toISOString() });
}
function fixture({ busy = false, lostLock = false, stale = false, sourceDrift = false, failBackup = false,
  failAtRow = null, failJournal = null, unexpectedMutation = false, commitFailure = false, independentFailure = false } = {}) {
  const prepared = plan(), calls = [], backups = [], journalEvents = [];
  let current = clone(prepared.before), saved, transaction = false, rowWrites = 0;
  if (stale) current.templates[0].name = 'A later human edit';
  const connection = {
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: busy ? 0 : 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT IS_USED_LOCK')) return [[{ owned: lostLock ? 0 : 1 }]];
      if (sql.startsWith('SET TRANSACTION')) return [[], []];
      if (sql.startsWith('SELECT DATE_FORMAT')) return [[{ mutation_at: mutationAt }]];
      if (sql.startsWith('UPDATE ClinicConsentTemplates')) {
        assert(transaction); rowWrites++;
        if (failAtRow === rowWrites) return [{ affectedRows: 0 }];
        const [at, id, clinicId, purpose, status, isDefault, updatedAt] = values;
        const row = current.templates.find(item => item.id === id);
        assert.equal(row.clinic_id, clinicId); assert.equal(row.purpose, purpose);
        assert.equal(row.status, status); assert.equal(row.is_default, isDefault); assert.equal(row.updatedAt, updatedAt);
        assert(!dataProtectionIds.has(id), 'default executor must not update patient-data templates');
        Object.assign(row, { status: 'archived', is_default: 0, updatedAt: at });
        if (unexpectedMutation) current.protected.documents.sha256 = hash('unexpected_signature_change');
        return [{ affectedRows: 1 }];
      }
      assert.fail('Unexpected SQL ' + sql);
    },
    beginTransaction: async () => { calls.push({ sql: 'BEGIN' }); assert(!transaction); saved = clone(current); transaction = true; },
    commit: async () => { calls.push({ sql: 'COMMIT' }); if (commitFailure) throw Error('owned_commit_uncertainty'); transaction = false; },
    rollback: async () => { calls.push({ sql: 'ROLLBACK' }); if (transaction) current = clone(saved); transaction = false; },
  };
  const run = extra => operator.execute({ connection, plan: prepared, info, configuration,
    backupPath: '/home/ubuntu/secure-imports/not-written-owned-fixture.json',
    saveBackup: (_path, backup) => { if (failBackup) throw Error('owned_backup_failure'); backups.push(clone(backup)); },
    journal: { append: async event => { if (event.phase === failJournal) throw Error('owned_journal_failure'); journalEvents.push(clone(event)); } },
    captureState: async () => clone(current),
    checkSource: () => sourceDrift ? { ...info, commit: 'c'.repeat(40) } : info,
    readIndependent: async () => { if (independentFailure) throw Error('owned_readback_failure'); return clone(current); },
    ...extra });
  return { run, calls, backups, journalEvents, current: () => current, prepared };
}

test('reviewed inventory is exactly 86 clinic headers and default plan excludes all five patient-data templates by purpose', () => {
  assert.equal(operator.EXPECTED_IDS.length, 86); assert.equal(new Set(operator.EXPECTED_IDS).size, 86);
  assert.deepEqual([...operator.EXPECTED_IDS].sort((a, b) => a - b), operator.EXPECTED_IDS);
  assert.deepEqual(operator.DATA_PROTECTION_IDS, [...dataProtectionIds]);
  const p = plan(); assert.equal(p.operations.length, 81);
  assert(p.operations.every(row => row.purpose !== 'data_protection'));
  assert.equal(plan(true).operations.length, 86);
  assert.equal(p.before.templates.filter(row => row.purpose === 'data_protection').length, 5);
  assert.equal(p.before.protected.documents.count, 2);
  assert(p.cautions.some(text => /hard clinical requirements/.test(text)));
  assert(plan(true).cautions.some(text => /patient-intake/.test(text)));
});
test('CLI requires explicit CRM and modes; privacy broadening is an affirmative flag, not a value inferred from a plan', () => {
  const base = ['--mode', 'prepare', '--target', 'crm', '--private-output', '/owned/path'];
  assert.equal(operator.parseOptions(base)['--include-patient-data'], undefined);
  assert.equal(operator.parseOptions([...base, '--include-patient-data'])['--include-patient-data'], 'true');
  for (const args of [[], ['--mode', 'apply', '--target', 'dev', '--private-output', '/owned/path'],
    [...base, '--include-patient-data', 'false'], [...base, '--include-patient-data', '--include-patient-data'],
    [...base, '--send-now', 'true'], [...base, '--target', 'crm']]) assert.throws(() => operator.parseOptions(args));
});
test('source, configuration, scope, exact plan hash, age and explicit privacy choice are all pinned', () => {
  const p = plan(); assert.doesNotThrow(() => operator.validatePlan(p, info, configuration, { now }));
  assert.throws(() => operator.validatePlan(plan(true), info, configuration, { now }), /PATIENT_DATA_CHOICE/);
  assert.doesNotThrow(() => operator.validatePlan(plan(true), info, configuration, { now, includePatientData: true }));
  for (const patch of [{ source: { ...info, commit: 'c'.repeat(40) } }, { target: 'dev' }, { clinic_ids: [66] },
    { group_id: 1 }, { include_patient_data: true }, { plan_sha256: 'e'.repeat(64) },
    { operations: [...p.operations, { id: 2, after: { status: 'archived' } }] }, { policy: { no_dispatch: false } }]) {
    assert.throws(() => operator.validatePlan({ ...p, ...patch }, info, configuration, { now }));
  }
  assert.throws(() => operator.validatePlan(p, info, { ...configuration, database: 'other' }, { now }));
  assert.throws(() => operator.validatePlan(p, info, configuration, { now: now + 7200001 }), /EXPIRED/);
  assert.throws(() => operator.validatePlan(p, info, configuration, { now: now - 1 }), /EXPIRED/);
  assert.doesNotThrow(() => operator.validatePlan(p, info, configuration, { now: now + 7200001, requireFresh: false }));
});
test('unexpected template, moved clinic, purpose corruption, group drift and missing protected digests are refused', () => {
  for (const mutate of [s => s.templates.push({ ...s.templates[0], id: 99999 }), s => s.templates.pop(),
    s => s.templates[0].clinic_id = 77, s => s.clinics[0].grupoClinicaId = 44,
    s => s.templates[0].purpose = 'assumed_from_name', s => s.templates[0].status = 'deleted',
    s => s.templates[0].is_default = 2, s => delete s.protected.documents,
    s => s.protected.documents.sha256 = 'invalid', s => s.protected.documents.count = 10001]) {
    const broken = state(); mutate(broken); assert.throws(() => operator.makePlan({ before: broken, info }));
  }
});
test('a valid purpose change before preparation cannot make a privacy identity eligible or silently broaden the excluded set', () => {
  for (const mutate of [s => s.templates.find(row => row.id === 2).purpose = 'clinical',
    s => s.templates.find(row => row.id === 154).purpose = 'financial',
    s => s.templates.find(row => row.id === 67).purpose = 'data_protection',
    s => { s.templates.find(row => row.id === 73).purpose = 'clinical'; s.templates.find(row => row.id === 74).purpose = 'data_protection'; }]) {
    for (const includePatientData of [false, true]) {
      const broken = state(); mutate(broken);
      assert.throws(() => operator.makePlan({ before: broken, info, includePatientData }), /REVIEWED_PATIENT_DATA_IDENTITIES_OR_PURPOSE_CHANGED/);
    }
  }
});
test('archival verification permits only status/default/updatedAt; it preserves names, source metadata, versions, signed snapshots and every excluded row', () => {
  const p = plan(), after = clone(p.before);
  for (const row of after.templates) if (!dataProtectionIds.has(row.id)) Object.assign(row, { status: 'archived', is_default: 0, updatedAt: mutationAt });
  assert(operator.verifyAfter(p.before, after, p.operations, mutationAt));
  for (const mutate of [s => s.templates[0].status = 'archived', s => s.templates[2].name = 'Changed',
    s => s.protected.documents.sha256 = hash('signature_changed'), s => s.protected.versions.count++,
    s => s.protected.requirements.sha256 = hash('removed_required'), s => s.protected.packages.sha256 = hash('token_cancelled'),
    s => s.protected.global_catalog.sha256 = hash('changed_other_tenants'), s => s.schema_sha256 = hash('schema_changed')]) {
    const bad = clone(after); mutate(bad); assert.throws(() => operator.verifyAfter(p.before, bad, p.operations, mutationAt));
  }
});
test('already archived headers are skipped without changing dates; an empty second plan is read-only', () => {
  const p = plan(), after = clone(p.before);
  for (const row of after.templates) if (!dataProtectionIds.has(row.id)) Object.assign(row, { status: 'archived', is_default: 0, updatedAt: mutationAt });
  assert.equal(operator.makePlan({ before: after, info }).operations.length, 0);
  assert.equal(operator.makePlan({ before: after, info, includePatientData: true }).operations.length, 5);
});
test('durable self-contained row backup precedes any DML and successful commit independently verifies all protected evidence', async () => {
  const f = fixture(), receipt = await f.run();
  assert.equal(receipt.status, 'committed_and_verified'); assert.equal(receipt.changed_headers, 81);
  assert.equal(f.backups.length, 1); assert.deepEqual(f.backups[0].before, f.prepared.before);
  assert.equal(f.backups[0].before_sha256, hash(f.prepared.before));
  assert.equal(f.backups[0].mutation_at, mutationAt);
  assert.equal(f.journalEvents[0].phase, 'backup_durable_before_mutation');
  assert.equal(f.journalEvents.at(-1).phase, 'committed_and_independently_verified');
  assert.equal(f.calls.filter(call => call.sql.startsWith('UPDATE')).length, 81);
  assert.equal(f.calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.deepEqual(f.current().protected, f.prepared.before.protected);
  assert.deepEqual(f.current().templates.filter(row => dataProtectionIds.has(row.id)), f.prepared.before.templates.filter(row => dataProtectionIds.has(row.id)));
});
test('dry-run executes exact same header SQL then rolls back and independently verifies the original state', async () => {
  const f = fixture(), receipt = await f.run({ dryRun: true });
  assert.equal(receipt.status, 'rolled_back_and_verified'); assert.equal(receipt.proposed, 81); assert.equal(receipt.changed_headers, 0);
  assert.equal(f.calls.filter(call => call.sql.startsWith('UPDATE')).length, 81);
  assert(!f.calls.some(call => call.sql === 'COMMIT')); assert.deepEqual(f.current(), f.prepared.before);
  assert.equal(f.journalEvents.at(-1).phase, 'dry_run_rolled_back_and_independently_verified');
});
test('busy operator, lost lock, stale full-row evidence, changed source or failed backup cannot commit', async () => {
  for (const setting of [{ busy: true }, { lostLock: true }, { stale: true }, { sourceDrift: true }, { failBackup: true }]) {
    const f = fixture(setting); await assert.rejects(f.run());
    assert(!f.calls.some(call => call.sql.startsWith('UPDATE') || call.sql === 'COMMIT'));
  }
});
test('any failed CAS, changed protected evidence or durable precommit journal failure rolls back every header', async () => {
  for (const setting of [{ failAtRow: 3 }, { unexpectedMutation: true }, { failJournal: 'headers_and_protected_evidence_verified_before_commit' }]) {
    const f = fixture(setting); await assert.rejects(f.run());
    assert(!f.calls.some(call => call.sql === 'COMMIT')); assert.deepEqual(f.current(), f.prepared.before);
    assert.equal(f.journalEvents.at(-1).phase, 'rolled_back_no_commit_attempt');
  }
});
test('uncertain commit or postcommit verification failure never triggers a blind replay or inverse writes', async () => {
  for (const setting of [{ commitFailure: true }, { independentFailure: true }]) {
    const f = fixture(setting); await assert.rejects(f.run(), /COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW/);
    assert.equal(f.calls.filter(call => call.sql === 'COMMIT').length, 1);
    assert.equal(f.calls.filter(call => call.sql.startsWith('UPDATE')).length, 81);
    assert.equal(f.journalEvents.at(-1).phase, 'commit_outcome_requires_manual_review_no_replay');
  }
});
test('operator has one bounded DML statement, no model bootstrap, provider, DDL, removal or protected-table write', () => {
  const text = fs.readFileSync(require.resolve('../bs-consent-catalog-withdrawal'), 'utf8');
  assert.equal((text.match(/UPDATE ClinicConsentTemplates SET /g) || []).length, 1);
  assert.match(text, /status='archived',is_default=0,updatedAt=\?/);
  assert.match(text, /AND purpose=\? AND status=\? AND is_default=\? AND updatedAt <=> \?/);
  assert(!/require\(['"]\.\.\/\.\.\/models['"]/.test(text));
  assert(!/\b(?:DELETE FROM|INSERT INTO|ALTER TABLE|DROP TABLE|TRUNCATE TABLE)\b|\.sync\(|fetch\(|axios\.|\.sendMessage\(/.test(text));
  assert.match(text, /START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/);
  assert.match(text, /SOURCE_CHANGED_BEFORE_COMMIT/);
});

test('native isolated SQL proves exact default/all-template rollback, CAS, advisory lock, committed archive and unchanged signed evidence',
  { skip: process.env.BS_CONSENT_WITHDRAWAL_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
    await withIsolatedCampaignMysql(async ({ sql, report }) => {
      const S = require('sequelize'), D = S.DataTypes;
      const clinic = sql.define('OwnedClinic', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
      const factories = { ClinicConsentTemplate: 'clinicconsenttemplate', ClinicConsentTemplateVersion: 'clinicconsenttemplateversion',
        TreatmentConsentRequirement: 'treatmentconsentrequirement', PatientConsentDocument: 'patientconsentdocument',
        ConsentSignaturePackage: 'consentsignaturepackage', ConsentTemplateCatalog: 'consenttemplatecatalog',
        ConsentTemplateCatalogVersion: 'consenttemplatecatalogversion' };
      const models = Object.fromEntries(Object.entries(factories).map(([name, file]) => [name, require('../../../models/' + file)(sql, D)]));
      await sql.sync(); // Only the empty, owned Unix-socket fixture, never application DB.
      await clinic.bulkCreate([{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }]);
      await models.ClinicConsentTemplate.bulkCreate(state().templates.map(row => ({ ...row,
        public_id: `owned-native-${row.id}`, createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-02Z') })));
      await models.ClinicConsentTemplate.create({ id: 999, clinic_id: 77, public_id: 'owned-other-clinic', name: 'Owned other clinic', status: 'active', purpose: 'clinical' });
      await models.ClinicConsentTemplateVersion.create({ id: 1, clinic_template_id: 67, version: 1, locale: 'es', title: 'Owned text', body_html: '<p>Fictitious fixture consent.</p>', status: 'published' });
      await models.TreatmentConsentRequirement.create({ id: 1, tratamiento_id: 12345, clinica_id: 72, clinic_template_id: 67, required: true, blocking_policy: 'hard' });
      await models.ConsentSignaturePackage.bulkCreate([{ id: 1, public_id: 'owned-signed', paciente_id: 100, clinica_id: 72, status: 'signed', signed_count: 1 },
        { id: 2, public_id: 'owned-pending', paciente_id: 101, clinica_id: 66, status: 'pending', signed_count: 0 }]);
      await models.PatientConsentDocument.bulkCreate([{ id: 1, public_id: 'owned-signed-doc', package_id: 1, paciente_id: 100, clinica_id: 72,
        clinic_template_id: 67, clinic_template_version_id: 1, status: 'signed', title: 'Owned signed consent', signed_at: new Date('2026-10-01Z'),
        snapshot_json: { signature_evidence: { fixture_only: true } }, snapshot_html: '<p>Immutable fictitious evidence.</p>', snapshot_hash: 'owned_snapshot_hash' },
      { id: 2, public_id: 'owned-pending-doc', package_id: 2, paciente_id: 101, clinica_id: 66, clinic_template_id: 74,
        status: 'pending', title: 'Owned pending consent', snapshot_hash: 'owned_pending_hash' }]);
      const mysql = require('mysql2/promise');
      const nativeOptions = { socketPath: sql.options.dialectOptions.socketPath, database: report.database,
        user: 'root', password: '', timezone: 'Z', dateStrings: true, multipleStatements: false };
      const config = { database: report.database, user: 'owned_fixture_only' };
      const connection = await mysql.createConnection(nativeOptions);
      const readIndependent = async () => {
        const independent = await mysql.createConnection(nativeOptions);
        try {
          await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
          const result = await operator.capture(independent, config); await independent.rollback(); return result;
        } finally { await independent.end(); }
      };
      try {
        await connection.query('SET SESSION MAX_EXECUTION_TIME=15000');
        await connection.query('SET SESSION innodb_lock_wait_timeout=5');
        await connection.query('SET SESSION lock_wait_timeout=10');
        const before = await readIndependent(); operator.validateState(before);
        assert.equal(before.templates.length, 86); assert.equal(before.protected.documents.count, 2);
        await connection.query('START TRANSACTION READ ONLY');
        await assert.rejects(connection.query("UPDATE ClinicConsentTemplates SET status='archived' WHERE id=67"), /READ ONLY/i);
        await connection.rollback();
        const make = (includePatientData = false) => operator.makePlan({ before, info, includePatientData });
        const backups = [], events = [];
        const args = { connection, info, configuration: config, checkSource: () => info, readIndependent,
          backupPath: '/owned/in-memory-only', saveBackup: (_filename, value) => backups.push(value),
          journal: { append: async event => events.push(event) } };
        const p = make(); assert.equal(p.operations.length, 81); assert.equal(make(true).operations.length, 86);
        await operator.execute({ ...args, plan: p, dryRun: true });
        assert.deepEqual(await readIndependent(), before);
        await operator.execute({ ...args, plan: make(true), includePatientData: true, dryRun: true });
        assert.deepEqual(await readIndependent(), before);
        report.checks.push('Real MySQL READ ONLY denies mutation; default 81 and explicit privacy-inclusive 86 use actual model schema, same CAS SQL and rollback; signed/pending snapshots and existing hard requirement hashes unchanged.');
        const second = await mysql.createConnection(nativeOptions);
        try {
          await second.query('SELECT GET_LOCK(?,0)', [operator.LOCK_KEY]);
          await assert.rejects(operator.execute({ ...args, plan: p }), /ANOTHER_WITHDRAWAL_ACTIVE/);
        } finally { await second.query('SELECT RELEASE_LOCK(?)', [operator.LOCK_KEY]); await second.end(); }
        await connection.query("UPDATE ClinicConsentTemplates SET name='Later human edit' WHERE id=67");
        const backupCount = backups.length;
        await assert.rejects(operator.execute({ ...args, plan: p }), /PREPARED_ROWS_OR_PROTECTED_EVIDENCE_DRIFT/);
        assert.equal(backups.length, backupCount);
        await connection.query('UPDATE ClinicConsentTemplates SET name=? WHERE id=67', [before.templates.find(row => row.id === 67).name]);
        assert.deepEqual(await readIndependent(), before);
        report.checks.push('Independent native advisory lock excludes concurrent operator; stale full-row human edit fails before backup or archival.');
        await assert.rejects(operator.execute({ ...args, plan: p, journal: { append: async event => {
          if (event.phase === 'headers_and_protected_evidence_verified_before_commit') throw Error('owned_forced_journal_failure');
        } } }), /owned_forced_journal_failure/);
        assert.deepEqual(await readIndependent(), before);
        report.checks.push('Forced durable journal failure after all 81 exact header writes rolls back every write.');
        const receipt = await operator.execute({ ...args, plan: p });
        assert.equal(receipt.status, 'committed_and_verified'); assert.equal(receipt.changed_headers, 81);
        const after = await readIndependent();
        assert.deepEqual(after.protected, before.protected);
        assert(after.templates.filter(row => !dataProtectionIds.has(row.id)).every(row => row.status === 'archived' && row.is_default === 0));
        assert.deepEqual(after.templates.filter(row => dataProtectionIds.has(row.id)), before.templates.filter(row => dataProtectionIds.has(row.id)));
        assert.equal(operator.makePlan({ before: after, info }).operations.length, 0);
        await assert.rejects(operator.execute({ ...args, plan: p }), /PREPARED_ROWS_OR_PROTECTED_EVIDENCE_DRIFT/);
        assert.deepEqual(await readIndependent(), after);
        report.checks.push('Commit independently verifies only 81 status/default/timestamp changes; five data-protection headers, versions, requirements, signed/pending documents, packages, global catalogs and another clinic unchanged; repeated prepare has zero writes and stale apply refuses.');
      } finally { await connection.end(); }
    });
  });
