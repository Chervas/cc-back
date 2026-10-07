'use strict';

// Opt-in: owns a fresh mysqld, datadir and Unix socket. No application index,
// operator credentials, existing database, Redis, provider or TCP is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mysql = require('mysql2/promise');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { buildBsCatalogMigrationPlan } = require('../../lib/cliniccloud-import/bs-catalog-migration-plan');
const { buildBsCatalogVisibilityPlan } = require('../../lib/cliniccloud-import/bs-catalog-visibility-plan');
const { executeBsCatalogMigration, materializedRow, dataSha } = require('../../lib/cliniccloud-import/bs-catalog-migration-apply');
const { createBsCatalogMigrationStore } = require('../../lib/cliniccloud-import/bs-catalog-migration-store');
const fixtureFile = path.join(__dirname, 'bs_catalog_migration_apply.test.js'), fixtureRequire = createRequire(fixtureFile), fixtureModule = { exports: {} };
vm.runInNewContext(`${fs.readFileSync(fixtureFile, 'utf8')}\nmodule.exports = { fixture, visibilityFixture, authorization, refresh, fakeJournal, NOW };`, {
    require: name => name === 'node:test' ? () => {} : fixtureRequire(name), module: fixtureModule, __dirname,
});
const fixtures = fixtureModule.exports, copy = value => JSON.parse(JSON.stringify(value));
async function seed(connection, input, { configType = 'JSON', engine = 'InnoDB', primary = true, scale = 2 } = {}) {
    // Every target in this function belongs to this test's freshly-created DB.
    await connection.query('DROP TABLE IF EXISTS Tratamientos');
    await connection.query('DROP TABLE IF EXISTS Clinicas');
    await connection.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY,grupoClinicaId INT NOT NULL) ENGINE=InnoDB');
    await connection.query('INSERT INTO Clinicas VALUES(66,29),(72,29)');
    await connection.query(`CREATE TABLE Tratamientos (
        id_tratamiento INT NOT NULL ${primary ? 'PRIMARY KEY' : ''}, codigo VARCHAR(50) NULL,
        clinica_id INT NOT NULL, grupo_clinica_id INT NULL, origen VARCHAR(20) NOT NULL,
        nombre VARCHAR(255) NOT NULL, descripcion TEXT NULL, duracion_min INT NULL,
        sesiones_defecto INT NULL, precio_base DECIMAL(10,${scale}) NULL, activo TINYINT NOT NULL,
        createdAt DATETIME NULL, updatedAt DATETIME NULL, appointment_automation_template_key VARCHAR(255) NULL,
        clinical_config ${configType} NULL) ENGINE=${engine}`);
    const columns = ['id_tratamiento', 'codigo', 'clinica_id', 'grupo_clinica_id', 'origen', 'nombre', 'descripcion',
        'duracion_min', 'sesiones_defecto', 'precio_base', 'activo', 'createdAt', 'updatedAt', 'appointment_automation_template_key', 'clinical_config'];
    const values = input.preflight.snapshot.treatments.map(row => columns.map(key => key === 'clinical_config'
        ? row[key] == null ? null : JSON.stringify(row[key]) : row[key] ?? null));
    await connection.query(`INSERT INTO Tratamientos (${columns.join(',')}) VALUES ?`, [values]);
    input.preflight.snapshot.treatments = (await connection.query('SELECT * FROM Tratamientos ORDER BY id_tratamiento'))[0];
    fixtures.refresh(input); return input;
}
function journal(connection) {
    const events = [];
    return { entries: events, async append(entry) {
        if (this.failStage === entry.stage) throw Error('OWNED_JOURNAL_FSYNC_FAILURE');
        events.push(copy(entry));
    } };
}
function argsFor(input, connection, database, kind = 'commercial') {
    const plan = kind === 'commercial' ? buildBsCatalogMigrationPlan(input) : buildBsCatalogVisibilityPlan(input);
    const authorization = fixtures.authorization(plan); authorization.backup.database = database; authorization.approval.database = database;
    let attempt = 0;
    return { plan, sourceInputs: input, store: createBsCatalogMigrationStore(connection, { readOnly: false }),
        journal: journal(connection), ...authorization, now: new Date('2030-01-03T12:10:00Z'), attemptId: () => `owned-sql-attempt-${attempt++}` };
}
async function digestRows(connection) { return hash((await connection.query('SELECT * FROM Tratamientos ORDER BY id_tratamiento'))[0]); }
test('catalogue executor uses owned MySQL: DECIMAL/JSON/date strings, per-row CAS, replay, receipt rollback and strict scope/storage guards',
    { skip: process.env.BS_CATALOG_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
        await withIsolatedCampaignMysql(async ({ report }) => {
            const connection = await mysql.createConnection({ socketPath: path.join(report.root, 'mysql.sock'), user: 'root',
                database: report.database, dateStrings: true, timezone: 'Z', multipleStatements: false });
            let checks = 0;
            try {
                const oldCapture = fixtures.fixture(); oldCapture.preflight.version = 'bs-catalog-preflight-readonly/1';
                await seed(connection, oldCapture); const legacyArgs = argsFor(oldCapture, connection, report.database);
                assert.equal((await executeBsCatalogMigration({ ...legacyArgs, store: createBsCatalogMigrationStore(connection) })).summary.written, 0); checks++;
                const input = fixtures.fixture(); input.preflight.snapshot.treatments[1].clinical_config.price_profile = null;
                await seed(connection, input); let args = argsFor(input, connection, report.database);
                const baseline = await digestRows(connection);
                const dry = await executeBsCatalogMigration({ ...args, store: createBsCatalogMigrationStore(connection) });
                assert.equal(dry.summary.written, 0); assert.equal(await digestRows(connection), baseline); assert.equal(args.journal.entries.length, 0); checks++;
                const applied = await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 2 }); assert.equal(applied.summary.written, 2);
                const [held] = await connection.query('SELECT * FROM Tratamientos WHERE id_tratamiento=10001');
                assert.equal(held[0].precio_base, '80.00'); assert.equal(typeof held[0].updatedAt, 'string');
                assert.equal(held[0].clinical_config.catalog_status, 'draft'); assert.equal(held[0].clinical_config.fiscal_mapping_pending, true);
                assert.equal(held[0].activo, 0); assert.equal(held[0].clinical_config.imported_price_review, undefined); checks++;
                const afterTwo = await digestRows(connection);
                const replay = await executeBsCatalogMigration({ ...args, store: createBsCatalogMigrationStore(connection), dryRun: true });
                assert.equal(replay.summary.no_write, 2); assert.equal(await digestRows(connection), afterTwo); checks++;
                const inverseAuth = fixtures.authorization(args.plan, 'rollback'); inverseAuth.approval.database = report.database; inverseAuth.backup.database = report.database;
                const inverse = { ...args, ...inverseAuth, direction: 'rollback', dryRun: false };
                const undone = await executeBsCatalogMigration(inverse); assert.equal(undone.summary.written, 2);
                const [restored] = await connection.query('SELECT * FROM Tratamientos WHERE id_tratamiento=10001');
                assert.equal(restored[0].precio_base, null); assert.equal(restored[0].clinical_config.price_profile, null);
                assert.notEqual(restored[0].updatedAt, input.preflight.snapshot.treatments.find(r => r.id_tratamiento === 10001).updatedAt);
                assert.equal((await executeBsCatalogMigration(inverse)).summary.written, 0); checks++;
                assert.equal((await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 1 })).summary.written, 1);
                await connection.query('UPDATE Tratamientos SET updatedAt=DATE_ADD(updatedAt,INTERVAL 1 SECOND) WHERE id_tratamiento=10000');
                const humanTimestamp = await digestRows(connection);
                await assert.rejects(executeBsCatalogMigration(inverse), /CAS_CONFLICT/); assert.equal(await digestRows(connection), humanTimestamp); checks++;
                // A later unrelated JSON change is never hidden by a narrow
                // price/badge CAS. First-row commits remain explicit on failure.
                const driftInput = await seed(connection, fixtures.fixture()); args = argsFor(driftInput, connection, report.database);
                await connection.query("UPDATE Tratamientos SET clinical_config=JSON_SET(clinical_config,'$.human_later',true) WHERE id_tratamiento=10001");
                await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /CAS_CONFLICT/);
                assert.equal(args.journal.entries.filter(e => e.stage === 'committed').length, 1); checks++;
                // TEXT JSON behaves identically to the production JSON driver;
                // the receipt binds the canonical actual DECIMAL/date storage.
                const textInput = await seed(connection, fixtures.fixture(), { configType: 'TEXT' }); args = argsFor(textInput, connection, report.database);
                assert.equal(typeof textInput.preflight.snapshot.treatments[0].clinical_config, 'string');
                assert.equal((await executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 1 })).summary.written, 1);
                const textRollback = fixtures.authorization(args.plan, 'rollback'); textRollback.approval.database = report.database; textRollback.backup.database = report.database;
                assert.equal((await executeBsCatalogMigration({ ...args, ...textRollback, direction: 'rollback', dryRun: false })).summary.written, 1); checks++;
                // Exact original legacy family only. Other manual NULL JSON and
                // historical references are not normalized or touched by SQL.
                const old = await seed(connection, fixtures.visibilityFixture()); args = argsFor(old, connection, report.database, 'visibility');
                const protectedRows = (await connection.query('SELECT * FROM Tratamientos WHERE id_tratamiento NOT IN (5000,5001) ORDER BY id_tratamiento'))[0];
                assert.equal((await executeBsCatalogMigration({ ...args, dryRun: false })).summary.written, 2);
                assert.equal(hash((await connection.query('SELECT * FROM Tratamientos WHERE id_tratamiento NOT IN (5000,5001) ORDER BY id_tratamiento'))[0]), hash(protectedRows));
                const [visible] = await connection.query('SELECT * FROM Tratamientos WHERE id_tratamiento=5001'); assert.equal(visible[0].clinical_config.booking_visibility, 'continuation_only');
                assert.equal(dataSha(visible[0]), dataSha(args.plan.operations.find(o => o.treatment_id === 5001).after)); checks++;
                for (const variant of [{ engine: 'MyISAM' }, { primary: false }, { scale: 3 }]) {
                    const changed = await seed(connection, fixtures.fixture(), variant); args = argsFor(changed, connection, report.database);
                    const before = await digestRows(connection); await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /BS_CATALOG_/);
                    assert.equal(await digestRows(connection), before); assert.equal(args.journal.entries.length, 0); checks++;
                }
                const triggerInput = await seed(connection, fixtures.fixture()); args = argsFor(triggerInput, connection, report.database);
                await connection.query("CREATE TRIGGER catalogue_unreviewed BEFORE UPDATE ON Tratamientos FOR EACH ROW SET NEW.nombre=CONCAT(NEW.nombre,' altered')");
                await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /TRIGGERS_REQUIRE_REVIEW/); assert.equal(args.journal.entries.length, 0);
                await connection.query('DROP TRIGGER catalogue_unreviewed'); checks++;
                await connection.query('UPDATE Clinicas SET grupoClinicaId=30 WHERE id_clinica=66');
                await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /CLINIC_GROUP_DRIFT/); checks++;
                await connection.query('UPDATE Clinicas SET grupoClinicaId=29 WHERE id_clinica=66');
                args.approval.database = 'not_owned_database'; args.backup.database = 'not_owned_database';
                await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /DATABASE_SCOPE_CHANGED/); checks++;
                const uncertain = await seed(connection, fixtures.fixture()); args = argsFor(uncertain, connection, report.database);
                args.journal.failStage = 'committed';
                await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false, maxOperations: 1 }), /INDETERMINATE_COMMIT/);
                assert.equal(args.journal.entries.at(-1).stage, 'written_before_commit');
                const pending = await digestRows(connection);
                await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /UNFINISHED_ATTEMPT/); assert.equal(await digestRows(connection), pending); checks++;
                // Failure while fsyncing the pre-commit receipt rolls back, so a
                // successful database UPDATE alone never becomes a receipt.
                const precommit = await seed(connection, fixtures.fixture()); args = argsFor(precommit, connection, report.database);
                args.journal.failStage = 'written_before_commit'; const before = await digestRows(connection);
                await assert.rejects(executeBsCatalogMigration({ ...args, dryRun: false }), /OWNED_JOURNAL_FSYNC_FAILURE/);
                assert.equal(await digestRows(connection), before); assert.equal(args.journal.entries.at(-1).stage, 'aborted'); checks++;
                report.catalogueChecks = checks;
                report.checks.push('Owned Unix-socket MySQL only: actual DECIMAL/JSON-null/TEXT/dateStrings, read-only default, independent row transactions, replay, exact inverse receipts, timestamp/human drift, visibility-only protected rows, primary index/precision/InnoDB/trigger/group/database guards and uncertain durable journal');
            } finally { await connection.end(); }
        });
    });
