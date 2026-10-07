'use strict';
// Deterministic fake SQL only. No env, database, network or source file writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { reconcileCatalog } = require('../../lib/cliniccloud-import/catalog-preflight');
const { buildBsCatalogMigrationPlan } = require('../../lib/cliniccloud-import/bs-catalog-migration-plan');
const { SOURCE_BATCH } = require('../../lib/cliniccloud-import/catalog-retirement');
const { LEGACY_SERVICES_SHA, buildBsCatalogVisibilityPlan } = require('../../lib/cliniccloud-import/bs-catalog-visibility-plan');
const { verifyPlan, materializedRow, executeBsCatalogMigration, journalState } = require('../../lib/cliniccloud-import/bs-catalog-migration-apply');
const { createBsCatalogMigrationStore } = require('../../lib/cliniccloud-import/bs-catalog-migration-store');
const { readJournalEntries, openBsCatalogJournal } = require('../../lib/cliniccloud-import/bs-catalog-migration-journal');
const { PRIVATE_ROOT } = require('../../lib/cliniccloud-import/io');
const copy = value => JSON.parse(JSON.stringify(value));
const NOW = new Date('2030-01-03T12:10:00.000Z');
// Re-use the existing fictional 895-row fixture without registering its tests.
const fixtureFile = path.join(__dirname, 'bs_catalog_migration_plan_offline.test.js');
const fixtureModule = { exports: {} }, fixtureRequire = createRequire(fixtureFile);
vm.runInNewContext(`${fs.readFileSync(fixtureFile, 'utf8')}\nmodule.exports.fixture = fixture;`, {
    require: name => name === 'node:test' ? () => {} : fixtureRequire(name), module: fixtureModule, __dirname,
});
const fixture = () => copy(fixtureModule.exports.fixture());
function refresh(input) {
    input.preflight.snapshot_sha256 = hash(input.preflight.snapshot);
    input.preflight.reconciliation = reconcileCatalog(input.matrixRows, input.preflight.snapshot);
    input.snapshotFileSha256 = hash(input.preflight); return input;
}
function visibilityFixture() {
    const input = fixture();
    input.legacyServices = Array.from({ length: 186 }, (_, index) => ({ source_row: index + 2,
        values: { idServicio: String(500 + index), idEmpresa: '5880', nombre: `Servicio original ficticio ${index}`, esbono: index === 1 ? '1' : '0' } }));
    input.legacyServicesFileSha256 = LEGACY_SERVICES_SHA;
    const old = index => ({ ...copy(input.preflight.snapshot.treatments[0]), id_tratamiento: 5000 + index,
        codigo: `CCLOUD-${500 + index}`, activo: 1, clinical_config: { source_system: 'cliniccloud', source_batch: SOURCE_BATCH,
            source_reference: `service:${500 + index}`, raw: copy(input.legacyServices[index].values),
            is_voucher_service: index === 1, clinic_unknown_property: { preserve: true } } });
    const rows = [old(0), old(1), old(2), old(3), old(4)];
    rows[2].activo = 0; rows[2].clinical_config.catalog_status = 'obsolete';
    rows[3].clinical_config.raw.nombre = 'Nombre raw alterado';
    rows[4].clinical_config.catalog_status = 'draft';
    rows.push({ ...old(5), id_tratamiento: 6000, codigo: null, clinical_config: { catalog_status: 'historical_reference' }, activo: 0 });
    rows.push({ ...old(6), id_tratamiento: 6001, codigo: 'CCIMP-506', clinical_config: { demo: true, source_service_id: '506' } });
    rows.push({ ...old(7), id_tratamiento: 6002, codigo: 'BS26-other-offer', clinical_config: { product_type: 'program' } });
    rows.push({ ...old(8), id_tratamiento: 6003, codigo: 'MANUAL-1', clinical_config: null });
    input.preflight.snapshot.treatments.push(...rows); return refresh(input);
}
class FakeConnection {
    constructor(rows) { this.rows = new Map(rows.map(r => [r.id_tratamiento, r.clinical_config == null ? copy(r) : materializedRow(r)])); this.trace = []; this.tick = 0; this.database = 'fictitious_crm'; this.clinics = [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }]; }
    async query(sql, values = []) {
        this.trace.push(sql.startsWith('UPDATE ') ? 'sql:update' : sql);
        if (sql.startsWith('SELECT DATABASE()')) return [[{ database_name: this.database }]];
        if (sql.includes('FROM Clinicas')) return [copy(this.clinics)];
        if (sql.includes('information_schema.TRIGGERS')) return [this.triggers || []];
        if (sql.includes('information_schema.TABLES')) return [[{ ENGINE: this.engine || 'InnoDB' }]];
        if (sql.includes('information_schema.STATISTICS')) return [this.missingIndex ? [] : [{ COLUMN_NAME: 'id_tratamiento', NON_UNIQUE: 0, SEQ_IN_INDEX: 1 }]];
        if (sql.includes('information_schema.COLUMNS')) return [[{ COLUMN_NAME: 'precio_base', DATA_TYPE: 'decimal', NUMERIC_SCALE: this.scale || 2 }, { COLUMN_NAME: 'clinical_config', DATA_TYPE: 'json' }, { COLUMN_NAME: 'updatedAt', DATA_TYPE: 'datetime' }]];
        if (sql.startsWith('SET TRANSACTION')) return [{}];
        if (sql.startsWith('START TRANSACTION')) { assert.equal(this.before, undefined); this.before = copy([...this.rows]); this.readOnly = sql.includes('READ ONLY'); return [{}]; }
        if (sql.startsWith('SELECT * FROM Tratamientos')) {
            const row = this.rows.get(values[0]); return [[...(row && row.clinica_id === values[1] ? [copy(row)] : [])]];
        }
        if (sql.startsWith('UPDATE Tratamientos')) {
            assert(this.before); assert.equal(this.readOnly, false); assert(!sql.includes('activo='));
            if (this.beforeUpdate) this.beforeUpdate();
            const id = values.at(-3), clinic = values.at(-2), timestamp = values.at(-1), row = this.rows.get(id);
            if (this.affectedRows === 0 || !row || row.clinica_id !== clinic || row.updatedAt !== timestamp) return [{ affectedRows: 0 }];
            let cursor = 0;
            if (sql.includes('precio_base=?')) row.precio_base = values[cursor++];
            if (sql.includes('clinical_config=?')) row.clinical_config = JSON.parse(values[cursor++]);
            row.updatedAt = `2030-01-03 12:10:${String(this.tick++).padStart(2, '0')}`;
            if (this.afterUpdate) this.afterUpdate(row);
            return [{ affectedRows: 1 }];
        }
        throw Error(`Unexpected fake SQL: ${sql}`);
    }
    async rollback() { this.trace.push('sql:rollback'); if (this.before) { this.rows = new Map(this.before); this.before = undefined; } }
    async commit() { this.trace.push('sql:commit'); assert(this.before); this.before = undefined; if (this.commitFailsAfterPersist) throw Error('SIMULATED_CONNECTION_LOSS'); }
}
function fakeJournal(connection) {
    return { entries: [], async append(entry) {
        connection.trace.push(`journal:${entry.stage}`);
        if (this.failStage === entry.stage) throw Error('SIMULATED_FSYNC_FAILURE');
        this.entries.push(copy(entry));
    } };
}
function authorization(plan, direction = 'forward') {
    const backup = { verified: true, target: 'crm', group_id: 29, clinic_ids: [66, 72], database: 'fictitious_crm',
        manifest_file_sha256: hash('fictional backup manifest'), backup_sha256: hash('fictional SQL backup'), generated_at: '2030-01-03T12:00:00.000Z' };
    const approval = { version: 'bs-catalog-operator-approval/1', plan_sha256: plan.plan_sha256, direction,
        target: 'crm', group_id: 29, clinic_ids: [66, 72], database: backup.database, field_whitelist: plan.field_whitelist,
        matrix_file_sha256: plan.matrix_file_sha256, snapshot_file_sha256: plan.snapshot_file_sha256,
        operator_identity: 'fictional reviewer', created_at: '2030-01-03T12:05:00.000Z', expires_at: '2030-01-03T13:00:00.000Z',
        backup_manifest_sha256: backup.manifest_file_sha256, commercial_or_visibility_only: true,
        preserve_activation_approvals_profiles_provenance_and_entitlements: true, gross_includes_provisional_vat_not_added_on_top: true,
        fiscal_draft_preparation_is_not_approval: true, hide_old_cliniccloud_only_new_offers: true, server_continuation_guard_verified: true,
        continuation_contract_release_sha256: hash('fictional released guard'), legacy_services_file_sha256: plan.legacy_services_file_sha256 };
    return { approval, backup };
}
function setup(input = fixture(), kind = 'commercial') {
    const plan = kind === 'visibility' ? buildBsCatalogVisibilityPlan(input) : buildBsCatalogMigrationPlan(input);
    const connection = new FakeConnection(input.preflight.snapshot.treatments), journal = fakeJournal(connection);
    const args = { plan, sourceInputs: input, store: createBsCatalogMigrationStore(connection, { readOnly: false }), journal,
        ...authorization(plan), now: NOW, attemptId: (() => { let n = 0; return () => `fictional-attempt-${n++}`; })() };
    return { input, plan, connection, journal, args };
}
test('default is entirely read-only and leaves rows, journal, holds, profiles and source approvals intact', async () => {
    const { args, connection, journal, plan } = setup(); const before = hash([...connection.rows]);
    const result = await executeBsCatalogMigration({ ...args, store: createBsCatalogMigrationStore(connection) });
    assert.equal(result.summary.written, 0); assert.equal(result.summary.would_write, plan.operations.length);
    assert.equal(result.summary.mode, 'read_only_dry_run'); assert.equal(hash([...connection.rows]), before);
    assert.equal(journal.entries.length, 0); assert.equal(connection.trace.some(s => s === 'sql:update' || s === 'sql:commit'), false);
});
test('commercial and visibility retain explicit preflight v1/v2 support without inventing alias or activation evidence', () => {
    for (const version of ['bs-catalog-preflight-readonly/1', 'bs-catalog-preflight-readonly/2']) {
        const input = fixture(); input.preflight.version = version;
        if (version.endsWith('/2')) input.preflight.snapshot.physical_aliases = [];
        refresh(input); const plan = buildBsCatalogMigrationPlan(input); assert.equal(verifyPlan(plan, input), true);
        assert.equal(plan.policy.activation_permitted, false); assert.equal(Object.hasOwn(plan, 'physical_aliases_verified'), false);
        const old = visibilityFixture(); old.preflight.version = version;
        if (version.endsWith('/2')) old.preflight.snapshot.physical_aliases = [];
        refresh(old); const hide = buildBsCatalogVisibilityPlan(old); assert.equal(verifyPlan(hide, old), true);
        assert.equal(hide.operations.length, 2); assert.equal(hide.policy.activation_permitted, false);
    }
    const input = fixture(); input.preflight.version = 'bs-catalog-preflight-readonly/3'; refresh(input);
    assert.throws(() => buildBsCatalogMigrationPlan(input), /BS_PLAN_PREFLIGHT_INVALID/);
});
test('rebuilding original inputs rejects a re-hashed plan, altered operation or enlarged whitelist before SQL', async () => {
    for (const mutate of [p => { p.operations[0].after.activo = 0; }, p => { p.field_whitelist.push('clinical_config.source_batch'); },
        p => { p.operations[0].after.precio_base = '85.00'; }]) {
        const { args, connection } = setup(), changed = copy(args.plan); mutate(changed);
        const { operation_sha256, ...op } = changed.operations[0]; changed.operations[0].operation_sha256 = hash(op);
        const { plan_sha256, ...body } = changed; changed.plan_sha256 = hash(body);
        await assert.rejects(executeBsCatalogMigration({ ...args, plan: changed }), /BS_CATALOG_/); assert.equal(connection.trace.length, 0);
    }
});
test('actual SQL caller applies only whitelisted columns with durable intent/readback before each commit', async () => {
    const { args, connection, plan, journal } = setup();
    const result = await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 2 }); assert.equal(result.summary.written, 2);
    assert.equal(connection.trace.filter(s => s === 'sql:commit').length, 2);
    const firstUpdate = connection.trace.indexOf('sql:update'), firstCommit = connection.trace.indexOf('sql:commit');
    assert(connection.trace.indexOf('journal:prepared') < firstUpdate);
    assert(connection.trace.indexOf('journal:written_before_commit') < firstCommit);
    assert(connection.trace.indexOf('journal:committed') > firstCommit);
    const held = connection.rows.get(10001);
    assert.equal(held.precio_base, '80.00'); assert.equal(held.activo, 0); assert.equal(held.clinical_config.catalog_status, 'draft');
    assert.equal(held.clinical_config.fiscal_mapping_pending, true); assert.equal(held.clinical_config.imported_price_review, undefined);
    for (const op of plan.operations.slice(0, 2)) {
        const actual = copy(connection.rows.get(op.treatment_id)); actual.updatedAt = op.after.updatedAt;
        assert.deepEqual(actual, materializedRow(op.after));
        assert.equal(journalState(journal.entries, plan, op).stage, 'committed');
    }
});
test('replay performs no duplicate write and maxOperations advances beyond prior completed rows', async () => {
    const { args, connection } = setup();
    await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 2 });
    const second = await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 1 });
    assert.equal(second.summary.no_write, 2); assert.equal(second.summary.written, 1);
    await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 200 });
    const count = connection.trace.filter(s => s === 'sql:update').length;
    const replay = await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 200 });
    assert.equal(replay.summary.written, 0); assert.equal(replay.summary.conflicts, 0);
    assert.equal(connection.trace.filter(s => s === 'sql:update').length, count);
});
test('exact committed receipts allow rollback/replay and later forward application without recovering old timestamps', async () => {
    const { args, connection } = setup(); const original = copy(connection.rows.get(10000));
    await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 1 });
    const inverse = { ...args, ...authorization(args.plan, 'rollback'), direction: 'rollback', dryRun: false, maxOperations: 1 };
    const result = await executeBsCatalogMigration(inverse); assert.equal(result.summary.written, 1);
    const actual = copy(connection.rows.get(10000)); assert.notEqual(actual.updatedAt, original.updatedAt);
    actual.updatedAt = original.updatedAt; assert.deepEqual(actual, original);
    const replay = await executeBsCatalogMigration(inverse); assert.equal(replay.summary.written, 0);
    const again = await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 1 }); assert.equal(again.summary.written, 1);
});
test('human edits to any column or unknown JSON before apply cause zero overwrites', async () => {
    for (const edit of [r => { r.descripcion = 'Later human edit'; }, r => { r.updatedAt = '2030-01-03 12:09:00'; },
        r => { r.clinical_config.booking_profile.phases[0].duration_minutes = 45; }, r => { r.clinical_config.new_unknown = true; }]) {
        const { args, connection } = setup(); edit(connection.rows.get(10000)); const observed = hash([...connection.rows]);
        await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /CAS_CONFLICT/);
        assert.equal(hash([...connection.rows]), observed); assert.equal(connection.trace.includes('sql:update'), false);
    }
});
test('rollback cannot overwrite later human changes, even timestamp-only changes', async () => {
    for (const edit of [r => { r.clinical_config.catalog_badge = 'Human badge'; }, r => { r.updatedAt = '2030-01-03 12:11:00'; },
        r => { r.clinical_config.clinic_owned_unknown_configuration.marker = 'human'; }]) {
        const { args, connection } = setup(); await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 1 });
        edit(connection.rows.get(10000)); const before = hash([...connection.rows]);
        await assert.rejects(executeBsCatalogMigration({ ...args, ...authorization(args.plan, 'rollback'), direction: 'rollback', dryRun: false }), /CAS_CONFLICT/);
        assert.equal(hash([...connection.rows]), before);
    }
});
test('rollback of a proposed-looking row without this plan committed receipt is rejected', async () => {
    const { args, connection, plan } = setup(); connection.rows.set(10000, materializedRow(plan.operations[0].after));
    await assert.rejects(executeBsCatalogMigration({ ...args, ...authorization(plan, 'rollback'), direction: 'rollback', dryRun: false }), /CAS_CONFLICT/);
    assert.equal(connection.trace.includes('sql:update'), false);
});
test('approval, source hashes, fiscal-hold acknowledgements, expiry, backup scope and database binding fail closed', async () => {
    for (const edit of [a => { a.approval.plan_sha256 = hash('wrong'); }, a => { a.approval.expires_at = NOW.toISOString(); },
        a => { a.approval.created_at = '2030-01-02T00:00:00Z'; }, a => { a.approval.fiscal_draft_preparation_is_not_approval = false; },
        a => { a.approval.field_whitelist.push('activo'); }, a => { a.backup.verified = false; }, a => { a.backup.database = 'other'; },
        a => { a.backup.generated_at = '2030-01-02T00:00:00Z'; }]) {
        const { args, connection } = setup(); edit(args);
        await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /BS_CATALOG_/); assert.equal(connection.trace.includes('sql:update'), false);
    }
});
test('SQL scope, triggers, transactional engine, precision and row clinic drift cannot be waived', async () => {
    for (const edit of [c => { c.database = 'other'; }, c => { c.clinics[0].grupoClinicaId = 30; }, c => { c.triggers = [{ TRIGGER_NAME: 'unreviewed' }]; },
        c => { c.engine = 'MyISAM'; }, c => { c.scale = 3; }, c => { c.missingIndex = true; }, c => { c.rows.get(10000).clinica_id = 66; }]) {
        const { args, connection } = setup(); edit(connection);
        await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /BS_CATALOG_/); assert.equal(connection.trace.includes('sql:update'), false);
    }
});
test('UPDATE count failure and unexpected stored JSON roll back this row, without touching other rows', async () => {
    for (const edit of [c => { c.affectedRows = 0; }, c => { c.afterUpdate = r => { r.clinical_config.human_property = 'unexpected'; }; }]) {
        const { args, connection, journal } = setup(); const before = hash([...connection.rows]); edit(connection);
        await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /BS_CATALOG_/);
        assert.equal(hash([...connection.rows]), before); assert.equal(journal.entries.at(-1).stage, 'aborted');
    }
});
test('the actual SQL adapter also rejects direct caller changes outside reviewed leaf patches', async () => {
    for (const edit of [value => { value.target.clinical_config.source_batch = 'forged'; },
        value => { value.target.activo = 0; }, value => { value.op.changes[0].path = 'clinical_config.booking_profile'; }]) {
        const { args, connection, plan } = setup(); await args.store.begin({ readOnly: false });
        const current = await args.store.readTreatment(10000, 72, { lock: true });
        const value = { op: copy(plan.operations[0]), current, target: materializedRow(plan.operations[0].after), direction: 'forward' }; edit(value);
        await assert.rejects(args.store.writeTreatment(value), /BS_CATALOG_STORAGE_PATCH_/);
        assert.equal(connection.trace.includes('sql:update'), false); await args.store.rollback();
    }
});
test('a mismatch on the second row stops the batch while its first committed receipt remains reversible', async () => {
    const { args, connection, journal, plan } = setup(); connection.rows.get(10001).nombre = 'Changed second row';
    await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /CAS_CONFLICT/);
    assert.equal(connection.trace.filter(s => s === 'sql:commit').length, 1);
    assert.equal(journalState(journal.entries, plan, plan.operations[0]).direction, 'forward');
    const rolledBack = await executeBsCatalogMigration({ ...args, ...authorization(plan, 'rollback'), direction: 'rollback', dryRun: true });
    assert.equal(rolledBack.summary.would_write, 1); assert.equal(rolledBack.summary.conflicts, 1);
});
test('journal failure before commit rolls back; uncertain commit/fsync outcomes block automatic replay and rollback', async () => {
    const beforeCommit = setup(); const original = hash([...beforeCommit.connection.rows]); beforeCommit.journal.failStage = 'written_before_commit';
    await assert.rejects(executeBsCatalogMigration({ ...beforeCommit.args, dryRun: false }), /SIMULATED_FSYNC_FAILURE/);
    assert.equal(hash([...beforeCommit.connection.rows]), original); assert.equal(beforeCommit.journal.entries.at(-1).stage, 'aborted');
    for (const edit of [s => { s.connection.commitFailsAfterPersist = true; }, s => { s.journal.failStage = 'committed'; }]) {
        const state = setup(); edit(state);
        await assert.rejects(executeBsCatalogMigration({ ...state.args, dryRun: false, maxOperations: 1 }), /INDETERMINATE_COMMIT/);
        assert.equal(state.journal.entries.at(-1).stage, 'written_before_commit');
        await assert.rejects(executeBsCatalogMigration({ ...state.args, dryRun: false }), /UNFINISHED_ATTEMPT/);
    }
});
test('journal chained receipts reject tampering, truncation and attempts to change committed receipt content', () => {
    const { plan } = setup(); const body = { plan_sha256: plan.plan_sha256, sequence: 1, previous_entry_sha256: null, stage: 'prepared' };
    const entry = { ...body, entry_sha256: hash(body) }, bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
    assert.equal(readJournalEntries(bytes, plan.plan_sha256).length, 1);
    assert.throws(() => readJournalEntries(Buffer.from(JSON.stringify(entry)), plan.plan_sha256), /TRUNCATED/);
    assert.throws(() => readJournalEntries(bytes, hash('wrong plan')), /INTEGRITY/);
    assert.throws(() => readJournalEntries(Buffer.from(`${JSON.stringify({ ...entry, stage: 'committed' })}\n`), plan.plan_sha256), /INTEGRITY/);
});
test('real journal persists private 0600 hash chain, reopens exactly and refuses a symlink', { skip: !fs.existsSync(PRIVATE_ROOT) }, async () => {
    const directory = fs.mkdtempSync(path.join(PRIVATE_ROOT, 'bs-catalog-journal-test-'));
    const filename = path.join(directory, 'owned-receipt.jsonl'), alias = path.join(directory, 'symlink.jsonl');
    const planSha = hash('fictional private durable plan'); let live;
    try {
        live = openBsCatalogJournal(filename, planSha);
        await live.append({ stage: 'prepared', operation_sha256: hash('fictional operation'), attempt_id: 'fictional-1', direction: 'forward' });
        await live.append({ stage: 'aborted', operation_sha256: hash('fictional operation'), attempt_id: 'fictional-1', direction: 'forward' });
        const expected = hash(live.entries); live.close(); live = undefined;
        assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
        live = openBsCatalogJournal(filename, planSha, { readOnly: true }); assert.equal(hash(live.entries), expected);
        await assert.rejects(live.append({ stage: 'prepared' }), /READ_ONLY_JOURNAL/); live.close(); live = undefined;
        fs.symlinkSync(filename, alias); assert.throws(() => openBsCatalogJournal(alias, planSha));
        assert.throws(() => openBsCatalogJournal(filename, hash('wrong plan')), /JOURNAL_INTEGRITY/);
    } finally {
        live?.close(); if (fs.existsSync(alias)) fs.unlinkSync(alias); if (fs.existsSync(filename)) fs.unlinkSync(filename); fs.rmdirSync(directory);
    }
});
test('visibility uses exact original full raw provenance, separates new/demos/historical/manual and leaves inactive/obsolete/draft unchanged', () => {
    const input = visibilityFixture(), before = hash(input), plan = buildBsCatalogVisibilityPlan(input);
    assert.equal(hash(input), before); assert.equal(plan.operations.length, 2); assert.equal(plan.summary.new_individual_sources_preserved, 167);
    assert.equal(plan.summary.original_legacy_sources_verified, 4); assert.equal(plan.summary.historical_references_preserved, 1);
    assert.deepEqual(plan.operations.map(o => o.treatment_id), [5000, 5001]); assert.equal(plan.pending.length, 1);
    for (const op of plan.operations) {
        const expected = copy(op.before); expected.clinical_config.booking_visibility = 'continuation_only';
        assert.deepEqual(op.after, expected); assert.equal(op.after.activo, op.before.activo);
        assert.equal(op.changes.length, 1); assert.equal(op.changes[0].path, 'clinical_config.booking_visibility');
    }
    assert.deepEqual(buildBsCatalogVisibilityPlan(input), plan);
});
test('visibility original identity cannot be replaced by same name, fake code, wrong account/batch or one changed raw cell', () => {
    for (const edit of [r => { r.clinical_config.source_batch = 'other'; }, r => { r.clinical_config.raw.idEmpresa = '999'; },
        r => { r.codigo = 'CCLOUD-999'; }, r => { r.clinical_config.raw.esbono = '99'; }, r => { r.clinical_config.source_reference = 'service:999'; }]) {
        const input = visibilityFixture(); edit(input.preflight.snapshot.treatments.find(r => r.id_tratamiento === 5000)); refresh(input);
        const plan = buildBsCatalogVisibilityPlan(input); assert.equal(plan.operations.some(o => o.treatment_id === 5000), false);
    }
    const input = visibilityFixture(); input.legacyServicesFileSha256 = hash('other source'); assert.throws(() => buildBsCatalogVisibilityPlan(input), /ORIGINAL_SOURCE/);
});
test('actual visibility SQL caller only adds continuation-only, preserves voucher identity/units and existing snapshots', async () => {
    const { args, connection, plan } = setup(visibilityFixture(), 'visibility');
    const purchases = [{ treatment_id: 5001, total_units: 5, available_units: 3, program_snapshot: { untouched: true } }];
    const appointments = [{ tratamiento_id: 5000, estado: 'programada', frozen_snapshot: { untouched: true } }];
    const unrelated = hash({ purchases, appointments });
    const result = await executeBsCatalogMigration({ ...args, dryRun: false }); assert.equal(result.summary.written, 2);
    for (const op of plan.operations) {
        const row = copy(connection.rows.get(op.treatment_id)); row.updatedAt = op.before.updatedAt;
        assert.deepEqual(row, materializedRow(op.after)); assert.equal(row.precio_base, op.before.precio_base);
    }
    assert.equal(hash({ purchases, appointments }), unrelated);
    assert.equal(connection.trace.some(s => /PatientVouchers|PatientProgramSessions|CitasPacientes/.test(s)), false);
    await executeBsCatalogMigration({ ...args, ...authorization(plan, 'rollback'), direction: 'rollback', dryRun: false });
    assert.equal(Object.hasOwn(connection.rows.get(5000).clinical_config, 'booking_visibility'), false);
});
test('visibility writes require explicit old-family authority and evidence of deployed continuation guards', async () => {
    for (const edit of [a => { a.hide_old_cliniccloud_only_new_offers = false; }, a => { a.server_continuation_guard_verified = false; },
        a => { delete a.continuation_contract_release_sha256; }, a => { a.legacy_services_file_sha256 = hash('different'); }]) {
        const { args, connection } = setup(visibilityFixture(), 'visibility'); edit(args.approval);
        await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /CONTINUATION_RELEASE/); assert.equal(connection.trace.length, 0);
    }
});
test('CLI remains offline by default and connects only after explicit live mode and prior approval/backup checks', () => {
    const cli = fs.readFileSync(path.join(__dirname, '../bs-catalog-migration-apply.js'), 'utf8');
    assert(cli.includes("const mode = o['--mode'] || 'dry-run'"));
    assert(cli.includes("const live = ['inspect', 'apply', 'rollback'].includes(mode)"));
    assert(cli.indexOf('verifyAuthorization({ plan, approval, backup') < cli.indexOf("connectOperatorDatabase('crm')"));
    assert(!cli.includes('dotenv.config')); assert(!cli.includes('require(\'../../app')); assert.equal(typeof verifyPlan, 'function');
});
