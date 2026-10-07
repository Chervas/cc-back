'use strict';

// Owns a fresh mysqld/datadir/Unix socket with TCP and application/provider
// connections forbidden by the existing launcher. All rows are fictitious.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { writePrivateJson, PRIVATE_ROOT } = require('../../lib/cliniccloud-import/io');
const { materializedRow, dataSha } = require('../../lib/cliniccloud-import/bs-catalog-migration-apply');
const { readPrivateBytes, readJournalEntries } = require('../../lib/cliniccloud-import/bs-catalog-migration-journal');
const { createBsPhysicalProfileMigrationStore: storeFor, openBsPhysicalProfileMigrationJournal: openJournal,
    executeBsPhysicalProfileMigration: execute, recoverBsPhysicalProfileMigration: recover } = require('../../lib/cliniccloud-import/bs-physical-profile-migration-apply');
const { fixture, inputFor, authorization, buildBsPhysicalProfileMigrationPlan: build, NOW, copy } = require('./helpers/owned-bs-physical-migration-fixture');
const TABLES = ['Tratamientos', 'Clinicas', 'Instalaciones', 'InstallationPhysicalAliases', 'DoctorClinicas',
    'BookingEquipment', 'BookingEquipmentClinics', 'BookingEquipmentRoomPolicies', 'CitasPacientes'];
async function seed(connection, h) {
    // This connection is admitted only by the owned-socket launcher guard.
    for (const table of TABLES) await connection.query(`DROP TABLE IF EXISTS ${table}`);
    await connection.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY,grupoClinicaId INT NOT NULL,equipment_booking_enabled TINYINT NOT NULL) ENGINE=InnoDB');
    await connection.query('INSERT INTO Clinicas VALUES(66,29,0),(72,29,0)');
    await connection.query('CREATE TABLE Tratamientos(id_tratamiento INT PRIMARY KEY,clinica_id INT NOT NULL,codigo VARCHAR(50),nombre VARCHAR(255),activo TINYINT,precio_base DECIMAL(10,2),clinical_config JSON,updatedAt DATETIME(6)) ENGINE=InnoDB');
    await connection.query('INSERT INTO Tratamientos VALUES ?', [h.snapshot.treatments.map(row => [row.id_tratamiento,
        row.clinica_id, row.codigo, row.nombre, row.activo, '91.25', JSON.stringify(row.clinical_config), '2030-01-03 12:00:00.000001'])]);
    await connection.query('CREATE TABLE Instalaciones(id INT PRIMARY KEY,clinica_id INT,activo TINYINT,nombre VARCHAR(255),profesionales_permitidos JSON) ENGINE=InnoDB');
    await connection.query('INSERT INTO Instalaciones VALUES ?', [h.snapshot.installations.map(row => [row.id, row.clinica_id,
        row.activo, row.nombre, row.profesionales_permitidos == null ? null : JSON.stringify(row.profesionales_permitidos)])]);
    await connection.query('CREATE TABLE InstallationPhysicalAliases(installation_id INT PRIMARY KEY,canonical_installation_id INT,group_id INT,created_at DATETIME,updated_at DATETIME) ENGINE=InnoDB');
    await connection.query('INSERT INTO InstallationPhysicalAliases VALUES ?', [h.snapshot.physical_aliases.map(row => [row.installation_id, row.canonical_installation_id, row.group_id, null, null])]);
    await connection.query('CREATE TABLE DoctorClinicas(id INT PRIMARY KEY,doctor_id INT,clinica_id INT,rol_en_clinica VARCHAR(50),activo TINYINT,recibe_citas TINYINT,agenda_flexible TINYINT,allow_overlap_confirmation TINYINT) ENGINE=InnoDB');
    await connection.query('INSERT INTO DoctorClinicas VALUES ?', [h.snapshot.professionals.map(row => [row.id, row.doctor_id,
        row.clinica_id, null, row.activo, row.recibe_citas, 0, 0])]);
    await connection.query('CREATE TABLE BookingEquipment(id INT PRIMARY KEY,owner_clinic_id INT,group_id INT,family_key VARCHAR(50),name VARCHAR(255),status VARCHAR(30),mobility VARCHAR(30),home_installation_id INT,turnaround_minutes INT,attention_policy JSON) ENGINE=InnoDB');
    await connection.query('INSERT INTO BookingEquipment VALUES ?', [h.snapshot.equipment.map(row => [row.id, row.owner_clinic_id,
        row.group_id, row.family_key, row.name, row.status, row.mobility, row.home_installation_id, row.turnaround_minutes, JSON.stringify(row.attention_policy)])]);
    await connection.query('CREATE TABLE BookingEquipmentClinics(equipment_id INT,clinic_id INT,PRIMARY KEY(equipment_id,clinic_id)) ENGINE=InnoDB');
    await connection.query('INSERT INTO BookingEquipmentClinics VALUES ?', [h.snapshot.equipment_memberships.map(row => [row.equipment_id, row.clinic_id])]);
    await connection.query('CREATE TABLE BookingEquipmentRoomPolicies(installation_id INT PRIMARY KEY,mode VARCHAR(30),equipment_ids JSON) ENGINE=InnoDB');
    await connection.query('CREATE TABLE CitasPacientes(id_cita INT PRIMARY KEY,tratamiento_id INT,estado VARCHAR(30),import_metadata JSON) ENGINE=InnoDB');
    await connection.query('INSERT INTO CitasPacientes VALUES(1,100,\'pendiente\',?),(2,101,\'realizada\',?)',
        [JSON.stringify({ booking: { profile: { frozen: 'historical 47 min' }, duration_selection: { duration_minutes: 47 } } }),
            JSON.stringify({ source: 'fictitious historic clinical note preserved' })]);
    h.snapshot.treatments = (await connection.query('SELECT * FROM Tratamientos ORDER BY id_tratamiento'))[0];
    Object.assign(h.snapshot, await storeFor(connection).readPhysicalResources());
    h.reseal(); return inputFor(h);
}
async function rows(connection) { return (await connection.query('SELECT * FROM Tratamientos ORDER BY id_tratamiento'))[0]; }
async function appointments(connection) { return hash((await connection.query('SELECT * FROM CitasPacientes ORDER BY id_cita'))[0]); }
test('physical missing-profile writer: owned MySQL full-row CAS, durable replay, concurrent writers, lost-response recovery and conditional rollback',
    { skip: process.env.BS_PHYSICAL_PROFILE_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
        await withIsolatedCampaignMysql(async ({ report }) => {
            const config = { socketPath: path.join(report.root, 'mysql.sock'), user: 'root', database: report.database,
                dateStrings: true, timezone: 'Z', multipleStatements: false };
            const connection = await mysql.createConnection(config), other = await mysql.createConnection(config);
            const artifactRoot = fs.mkdtempSync(path.join(PRIVATE_ROOT, 'bs-physical-writer-owned-'));
            fs.chmodSync(artifactRoot, 0o700);
            const journals = [], checks = [], journalFiles = [];
            const setup = input => {
                const plan = build(input), filename = path.join(artifactRoot, `journal-${journalFiles.length + 1}.jsonl`);
                journalFiles.push(filename); const journal = openJournal(filename, plan.plan_sha256); journals.push(journal);
                return { plan, sourceInputs: input, store: storeFor(connection, { readOnly: false }), journal,
                    ...authorization(plan, report.database), now: NOW };
            };
            try {
                let input = await seed(connection, fixture()), args = setup(input);
                assert.equal(args.store.writeTreatment, undefined);
                const baseline = await rows(connection), appointmentBefore = await appointments(connection);
                const dry = await execute({ ...args, store: storeFor(connection) });
                assert.equal(dry.summary.would_write, 1); assert.equal(dry.summary.written, 0);
                assert.equal(hash(await rows(connection)), hash(baseline)); assert.equal(args.journal.entries.length, 0);
                checks.push('Default dry-run uses READ ONLY and creates no profile or journal event.');
                const applied = await execute({ ...args, dryRun: false }); assert.equal(applied.summary.written, 1);
                const actual = (await rows(connection))[0];
                assert.equal(actual.activo, 0); assert.equal(actual.clinical_config.catalog_status, 'draft');
                assert.equal(actual.precio_base, '91.25'); assert.equal(actual.clinical_config.booking_profile.phases[0].duration_minutes, null);
                assert.deepEqual(actual.clinical_config.other_clinic_decision, { preserve: 'sí' });
                assert.equal(await appointments(connection), appointmentBefore);
                assert.equal(hash((await rows(connection)).slice(1)), hash(baseline.slice(1)));
                assert.equal(args.journal.entries.at(-1).stage, 'committed');
                assert.equal(readJournalEntries(readPrivateBytes(args.journal.filename), args.plan.plan_sha256).length, 3);
                const replay = await execute({ ...args, dryRun: false }); assert.equal(replay.summary.written, 0); assert.equal(replay.summary.no_write, 1);
                checks.push('JSON/DECIMAL/DATETIME(6) real: exactly one missing profile; all166 existing profiles, activation, price, source and appointment snapshots untouched; durable three-stage fsync journal and replay no-op.');
                const inverse = { ...args, ...authorization(args.plan, report.database, 'rollback'), direction: 'rollback', dryRun: false };
                assert.equal((await execute(inverse)).summary.written, 1); assert.equal((await execute(inverse)).summary.written, 0);
                assert.equal(dataSha((await rows(connection))[0]), dataSha(baseline[0]));
                assert.equal(Object.hasOwn((await rows(connection))[0].clinical_config, 'booking_profile'), false);
                assert.equal(await appointments(connection), appointmentBefore);
                checks.push('Rollback restores absent profile by exact committed receipt; rollback replay no-op; historic appointments remain frozen.');

                input = await seed(connection, fixture({ explicitNull: true })); args = setup(input);
                await execute({ ...args, dryRun: false });
                await execute({ ...args, ...authorization(args.plan, report.database, 'rollback'), direction: 'rollback', dryRun: false });
                assert.equal((await rows(connection))[0].clinical_config.booking_profile, null);
                checks.push('Explicit JSON null is restored as null, never confused with absent key.');

                input = await seed(connection, fixture()); args = setup(input);
                await connection.query("UPDATE Tratamientos SET clinical_config=JSON_SET(clinical_config,'$.human_later','preserved') WHERE id_tratamiento=100");
                const humanBefore = hash(await rows(connection));
                await assert.rejects(execute({ ...args, dryRun: false }), /BS_PHYSICAL_CAS_CONFLICT_STOP/);
                assert.equal(hash(await rows(connection)), humanBefore); assert.equal(args.journal.entries.length, 0);
                checks.push('Later unrelated JSON edit blocks forward CAS with zero overwrite and no journal intent.');

                input = await seed(connection, fixture()); args = setup(input); await execute({ ...args, dryRun: false });
                await connection.query('UPDATE Tratamientos SET updatedAt=DATE_ADD(updatedAt,INTERVAL 1 SECOND) WHERE id_tratamiento=100');
                const editedAfter = hash(await rows(connection));
                await assert.rejects(execute({ ...args, ...authorization(args.plan, report.database, 'rollback'), direction: 'rollback', dryRun: false }), /CAS_CONFLICT/);
                assert.equal(hash(await rows(connection)), editedAfter);
                checks.push('Timestamp-only human edit blocks conditional rollback; no state is overwritten.');

                input = await seed(connection, fixture()); args = setup(input);
                await connection.query("UPDATE BookingEquipment SET status='maintenance' WHERE id=5");
                const resourceDriftRows = hash(await rows(connection));
                await assert.rejects(execute({ ...args, dryRun: false }), /RESOURCE_DRIFT_STOP/);
                assert.equal(hash(await rows(connection)), resourceDriftRows); assert.equal(args.journal.entries.length, 0);
                checks.push('Physical inventory drift is detected under shared locks before an intent or write.');

                input = await seed(connection, fixture()); args = setup(input);
                let release, prepared;
                const hold = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { prepared = resolve; });
                const originalAppend = args.journal.append;
                args.journal.append = async event => { const value = await originalAppend(event);
                    if (event.stage === 'prepared') { prepared(); await hold; } return value; };
                // This second real connection opens its handle before the first
                // commit; reload under the executor lock must refresh it later.
                const staleJournal = openJournal(args.journal.filename, args.plan.plan_sha256); journals.push(staleJournal);
                const contender = { ...args, store: storeFor(other, { readOnly: false }), journal: staleJournal };
                const first = execute({ ...args, dryRun: false }); await reached;
                await assert.rejects(execute({ ...contender, dryRun: false }), /EXECUTOR_ALREADY_RUNNING/);
                release(); assert.equal((await first).summary.written, 1);
                assert.equal((await execute({ ...contender, dryRun: false })).summary.written, 0);
                assert.equal(readJournalEntries(readPrivateBytes(args.journal.filename), args.plan.plan_sha256).length, 3);
                checks.push('Two real MySQL connections run concurrently: one commits, the second fails global GET_LOCK without writing; stale journal handle reloads and later replay is no-op with a valid chain.');

                input = await seed(connection, fixture()); args = setup(input);
                const historicalBeforeLost = await appointments(connection), commit = args.store.commit;
                args.store.commit = async () => { await commit(); throw Error('OWNED_CONNECTION_RESPONSE_LOST_AFTER_COMMIT'); };
                await assert.rejects(execute({ ...args, dryRun: false }), /INDETERMINATE_COMMIT_REQUIRES_REVIEW/);
                assert.equal(args.journal.entries.at(-1).stage, 'written_before_commit');
                args.store = storeFor(connection, { readOnly: false });
                await assert.rejects(execute({ ...args, dryRun: false }), /UNFINISHED_ATTEMPT_REQUIRES_REVIEW/);
                await assert.rejects(recover(args), /SCOPED_APPROVAL/);
                const recoveryApproval = { ...args.approval, recover_indeterminate_commit: true };
                const recovered = await recover({ ...args, approval: recoveryApproval });
                assert.deepEqual(recovered.recovered, [{ treatment_id: 100, decision: 'committed' }]); assert.equal(recovered.profile_writes, 0);
                assert.equal((await execute({ ...args, dryRun: false })).summary.written, 0);
                const rollbackAfterLost = { ...args, ...authorization(args.plan, report.database, 'rollback'), direction: 'rollback', dryRun: false };
                const rollbackCommit = rollbackAfterLost.store.commit;
                rollbackAfterLost.store.commit = async () => { await rollbackCommit(); throw Error('OWNED_ROLLBACK_RESPONSE_LOST'); };
                await assert.rejects(execute(rollbackAfterLost), /INDETERMINATE_COMMIT_REQUIRES_REVIEW/);
                rollbackAfterLost.store = storeFor(connection, { readOnly: false });
                await assert.rejects(recover({ ...rollbackAfterLost, ...authorization(args.plan, report.database),
                    direction: 'forward', approval: { ...args.approval, recover_indeterminate_commit: true } }), /RECOVERY_DIRECTION_APPROVAL_MISMATCH/);
                assert.equal((await recover({ ...rollbackAfterLost,
                    approval: { ...rollbackAfterLost.approval, recover_indeterminate_commit: true } })).recovered[0].decision, 'committed');
                assert.equal((await execute(rollbackAfterLost)).summary.written, 0);
                assert.equal(await appointments(connection), historicalBeforeLost);
                checks.push('Real committed UPDATE with lost COMMIT response remains blocked; fresh approved recovery seals receipt without SQL writes, replay no-op and exact rollback preserve appointments. Lost rollback response also recovers; forward approval cannot recover rollback.');

                input = await seed(connection, fixture()); args = setup(input);
                const beforeFailure = hash(await rows(connection)), append = args.journal.append;
                args.journal.append = async event => { if (event.stage === 'written_before_commit') throw Error('OWNED_PRECOMMIT_FSYNC_FAILURE'); return append(event); };
                await assert.rejects(execute({ ...args, dryRun: false }), /OWNED_PRECOMMIT_FSYNC_FAILURE/);
                assert.equal(hash(await rows(connection)), beforeFailure); assert.equal(args.journal.entries.at(-1).stage, 'aborted');
                checks.push('Pre-commit durable-receipt failure rolls back actual InnoDB UPDATE and marks attempt aborted.');
                report.physicalMigrationChecks = checks.length; report.checks.push(...checks);
                const evidence = { version: 'bs-physical-profile-owned-mysql-evidence/1', database: report.database,
                    mysql: report.mysql, owned_mysql_root: report.root, checks, journals: journalFiles,
                    real_database_or_provider_connections: 0, activation_changed: false, v5_candidates_applied: false,
                    appointment_snapshots_changed: false, success: true };
                const output = path.join(artifactRoot, 'evidence.json'); writePrivateJson(output, evidence);
                report.physicalEvidence = output;
            } finally { for (const journal of journals) journal.close(); await other.end(); await connection.end(); }
        });
    });
