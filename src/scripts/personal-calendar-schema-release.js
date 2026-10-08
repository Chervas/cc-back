#!/usr/bin/env node
'use strict';

// Operator-only additive schema cut. No app/models, sessions, provider gates,
// grants or process restarts. MySQL DDL is not transactionally rollbackable.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const { newJournal } = require('./program-commercial-schema-release');
const ROOT = '/home/ubuntu/wt/back-dev';
const VERSION = 'personal-calendar-schema/1';
const MIGRATIONS = Object.freeze([
    Object.freeze({ name: '20261008123000-personal-calendar-undo-receipts.js', sha256: 'a08ebd6f64d1f9e522fedef103526bf2be2a14b9ded8c350f47d264519ad40d6' }),
    Object.freeze({ name: '20261008123100-add-personal-block-recurrence-until.js', sha256: '8caaf30631fa440f5988d3225017b8b13b2e646607bd56807141bedfca19d62b' }),
    Object.freeze({ name: '20261008133000-add-legacy-attention-confirmation.js', sha256: 'a812082bf08ba49aab4985c4dd4c7f90174857f0fc7ea478fc4335c533f63aed' }),
]);
const PARENTS = ['DoctorBloqueos', 'DoctorClinicas'];
const EXISTING = [...PARENTS, 'SequelizeMeta'];
const CREATED = ['PersonalCalendarRevisions', 'PersonalCalendarUndoReceipts'];
const TABLES = [...EXISTING, ...CREATED];
const NEW_COLUMNS = { DoctorBloqueos: 'recurrente_hasta', DoctorClinicas: 'allow_legacy_attention_confirmation' };
const fail = code => { throw Error(code); };
const isNewColumn = row => NEW_COLUMNS[row.TABLE_NAME] === row.COLUMN_NAME;

function source() {
    if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
        || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
        || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('PERSONAL_SCHEMA_COMMITTED_CANONICAL_DEV_REQUIRED');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) fail('PERSONAL_SCHEMA_SOURCE_INVALID');
    for (const migration of MIGRATIONS) {
        if (hash(readBytes(path.join(ROOT, 'migrations', migration.name))) !== migration.sha256) fail('PERSONAL_SCHEMA_REVIEWED_MIGRATION_CHANGED');
    }
    return { commit, migrations: MIGRATIONS };
}

async function capture(connection) {
    const query = async (sql, values = []) => (await connection.query(sql, values))[0];
    const [identity] = await query('SELECT DATABASE() AS database_name, CURRENT_USER() AS database_user, @@hostname AS server_name');
    const tables = await query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [TABLES]);
    if (EXISTING.some(name => !tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))) fail('PERSONAL_SCHEMA_PARENT_AND_METADATA_INNODB_REQUIRED');
    const columns = await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION', [TABLES]);
    const indexes = await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', [TABLES]);
    const foreignKeys = await query('SELECT TABLE_NAME,COLUMN_NAME,CONSTRAINT_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION', [TABLES]);
    const triggers = await query('SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME', [TABLES]);
    if (triggers.some(row => row.EVENT_OBJECT_TABLE === 'SequelizeMeta')) fail('PERSONAL_SCHEMA_METADATA_TRIGGERS_UNEXPECTED');
    const metadata = await query('SELECT name FROM SequelizeMeta ORDER BY name');
    const fingerprints = {};
    for (const name of PARENTS) {
        const rows = await query(`SELECT * FROM \`${name}\` ORDER BY id`);
        const omit = NEW_COLUMNS[name];
        fingerprints[name] = { count: rows.length, sha256: hash(rows.map(row => {
            const copy = { ...row }; delete copy[omit]; return copy;
        })), nondefault: rows.filter(row => omit === 'recurrente_hasta'
            ? row[omit] != null : row[omit] != null && Number(row[omit]) !== 0).length };
    }
    for (const name of CREATED) {
        fingerprints[name] = tables.some(row => row.TABLE_NAME === name)
            ? Number((await query(`SELECT COUNT(*) AS n FROM \`${name}\``))[0].n) : null;
    }
    return { identity_sha256: hash(identity), server_sha256: hash(identity.server_name), tables, columns, indexes,
        foreignKeys, triggers, metadata_names: metadata.map(row => row.name).sort(), fingerprints };
}

function assertUnapplied(state) {
    if (EXISTING.some(name => !state.tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))) fail('PERSONAL_SCHEMA_PARENT_AND_METADATA_INNODB_REQUIRED');
    if (state.triggers.some(row => row.EVENT_OBJECT_TABLE === 'SequelizeMeta')) fail('PERSONAL_SCHEMA_METADATA_TRIGGERS_UNEXPECTED');
    if (state.metadata_names.some(name => MIGRATIONS.some(migration => migration.name === name))
        || state.tables.some(row => CREATED.includes(row.TABLE_NAME)) || state.columns.some(isNewColumn)) fail('PERSONAL_SCHEMA_EXISTING_OR_PARTIAL_REQUIRES_REVIEW');
}
function validColumn(column, type, nullable, defaultValue = null) {
    return column && column.COLUMN_TYPE.toLowerCase() === type && column.IS_NULLABLE === (nullable ? 'YES' : 'NO')
        && (defaultValue === null ? column.COLUMN_DEFAULT === null : String(column.COLUMN_DEFAULT) === String(defaultValue))
        && !column.EXTRA && !column.GENERATION_EXPRESSION;
}
function verifySchema(state, { registered = true } = {}) {
    for (const name of TABLES) if (!state.tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB')) fail('PERSONAL_SCHEMA_TABLE_VERIFICATION_FAILED');
    const find = (table, column) => state.columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === column);
    if (!validColumn(find('DoctorBloqueos', 'recurrente_hasta'), 'date', true)
        || !validColumn(find('DoctorClinicas', 'allow_legacy_attention_confirmation'), 'tinyint(1)', false, 0)) fail('PERSONAL_SCHEMA_ADDED_COLUMN_VERIFICATION_FAILED');
    const expected = {
        PersonalCalendarRevisions: { doctor_id: ['int', false], revision: ['bigint unsigned', false, 0], created_at: ['datetime', false], updated_at: ['datetime', false] },
        PersonalCalendarUndoReceipts: { id: ['char(36)', false], token_hash: ['varchar(64)', false], actor_user_id: ['int', false],
            doctor_ids: ['json', false], revisions: ['json', false], before_state: ['json', false], after_state: ['json', false],
            post_sha256: ['varchar(64)', false], expires_at: ['datetime(3)', false], consumed_at: ['datetime(3)', true],
            created_at: ['datetime', false], updated_at: ['datetime', false] },
    };
    for (const [table, fields] of Object.entries(expected)) {
        if (hash(state.columns.filter(row => row.TABLE_NAME === table).map(row => row.COLUMN_NAME).sort()) !== hash(Object.keys(fields).sort())) fail('PERSONAL_SCHEMA_CREATED_COLUMN_SET_INVALID');
        for (const [column, definition] of Object.entries(fields)) if (!validColumn(find(table, column), ...definition)) fail('PERSONAL_SCHEMA_CREATED_COLUMN_VERIFICATION_FAILED');
        const groups = new Map();
        for (const row of state.indexes.filter(row => row.TABLE_NAME === table)) {
            if (row.SUB_PART != null || row.INDEX_TYPE !== 'BTREE') fail('PERSONAL_SCHEMA_INDEX_VERIFICATION_FAILED');
            if (!groups.has(row.INDEX_NAME)) groups.set(row.INDEX_NAME, []);
            groups.get(row.INDEX_NAME).push(row);
        }
        const signatures = [...groups].map(([name, rows]) => ({ primary: name === 'PRIMARY', unique: rows.every(row => Number(row.NON_UNIQUE) === 0),
            fields: rows.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX).map(row => row.COLUMN_NAME).join(',') }));
        const wanted = table === 'PersonalCalendarRevisions' ? [{ primary: true, unique: true, fields: 'doctor_id' }]
            : [{ primary: true, unique: true, fields: 'id' }, { primary: false, unique: true, fields: 'token_hash' },
                { primary: false, unique: false, fields: 'expires_at' }, { primary: false, unique: false, fields: 'actor_user_id,created_at' }];
        const ordered = rows => rows.sort((a, b) => a.fields.localeCompare(b.fields));
        if (hash(ordered(signatures)) !== hash(ordered(wanted))) fail('PERSONAL_SCHEMA_INDEX_VERIFICATION_FAILED');
    }
    if (state.foreignKeys.some(row => CREATED.includes(row.TABLE_NAME)) || state.triggers.some(row => CREATED.includes(row.EVENT_OBJECT_TABLE))) fail('PERSONAL_SCHEMA_CREATED_CONSTRAINTS_UNEXPECTED');
    if (state.triggers.some(row => row.EVENT_OBJECT_TABLE === 'SequelizeMeta')) fail('PERSONAL_SCHEMA_METADATA_TRIGGERS_UNEXPECTED');
    if (MIGRATIONS.some(migration => state.metadata_names.includes(migration.name) !== registered)) fail('PERSONAL_SCHEMA_MIGRATION_METADATA_CHANGED');
}

function validatePlan(plan, info, target, { now = Date.now(), fresh = true } = {}) {
    if (plan?.version !== VERSION || plan.target !== target || plan.source_commit !== info.commit
        || hash(plan.migrations) !== hash(MIGRATIONS) || hash(info.migrations) !== hash(MIGRATIONS)
        || !Number.isFinite(Date.parse(plan.generated_at)) || Date.parse(plan.generated_at) > now
        || fresh && now - Date.parse(plan.generated_at) > 7200000) fail('PERSONAL_SCHEMA_PLAN_INVALID_OR_EXPIRED');
    assertUnapplied(plan.before);
}
function validateBefore(plan, current, info, target, options) {
    validatePlan(plan, info, target, options);
    assertUnapplied(current);
    if (hash(current) !== hash(plan.before)) fail('PERSONAL_SCHEMA_PLAN_DRIFT');
}
function validateBackupManifest(backup, plan, configuration, target, now = Date.now()) {
    if (backup.database_target !== target || backup.database_name !== configuration.database || hash(backup.server_name) !== plan.before.server_sha256
        || backup.full_gzip_verified !== true || backup.dump_completion_verified !== true
        || !Number.isFinite(Date.parse(backup.generated_at)) || Date.parse(backup.generated_at) > now
        || now - Date.parse(backup.generated_at) > 7200000) fail('PERSONAL_SCHEMA_FRESH_TARGET_BACKUP_REQUIRED');
}
function verifyAfter(before, after, { registered = false } = {}) {
    verifySchema(after, { registered });
    for (const name of PARENTS) {
        const a = before.fingerprints[name], b = after.fingerprints[name];
        if (a.count !== b.count || a.sha256 !== b.sha256 || b.nondefault !== 0) fail('PERSONAL_SCHEMA_EXISTING_AVAILABILITY_CHANGED');
    }
    if (CREATED.some(name => after.fingerprints[name] !== 0)) fail('PERSONAL_SCHEMA_CREATED_TABLES_NOT_EMPTY');
    for (const part of ['tables', 'indexes', 'foreignKeys', 'triggers']) {
        const filter = row => EXISTING.includes(row.TABLE_NAME || row.EVENT_OBJECT_TABLE);
        if (hash(before[part].filter(filter)) !== hash(after[part].filter(filter))) fail('PERSONAL_SCHEMA_EXISTING_METADATA_CHANGED');
    }
    if (hash(before.columns) !== hash(after.columns.filter(row => EXISTING.includes(row.TABLE_NAME) && !isNewColumn(row)))
        || before.identity_sha256 !== after.identity_sha256) fail('PERSONAL_SCHEMA_EXISTING_METADATA_CHANGED');
    const expected = registered ? [...before.metadata_names, ...MIGRATIONS.map(m => m.name)].sort() : before.metadata_names;
    if (hash(after.metadata_names) !== hash(expected)) fail('PERSONAL_SCHEMA_MIGRATION_METADATA_CHANGED');
}

function boundedQueryInterface(connection, Sequelize) {
    const sequelize = new Sequelize({ dialect: 'mysql', logging: false });
    sequelize.connectionManager.getConnection = async () => connection.connection;
    sequelize.connectionManager.releaseConnection = async () => {};
    const real = sequelize.getQueryInterface();
    return {
        createTable: async (table, columns) => {
            if (!CREATED.includes(table)) fail('PERSONAL_SCHEMA_UNEXPECTED_DDL');
            await real.createTable(table, columns, { engine: 'InnoDB' });
        },
        addIndex: async (table, fields) => {
            if (table !== 'PersonalCalendarUndoReceipts' || !['expires_at', 'actor_user_id,created_at'].includes(fields?.join(','))) fail('PERSONAL_SCHEMA_UNEXPECTED_DDL');
            await real.addIndex(table, fields);
        },
        addColumn: async (table, column, specification) => {
            if (column !== NEW_COLUMNS[table] || Object.keys(specification || {}).sort().join(',') !== 'allowNull,defaultValue,type') fail('PERSONAL_SCHEMA_UNEXPECTED_DDL');
            if (table === 'DoctorBloqueos' && specification.type === Sequelize.DATEONLY && specification.allowNull === true && specification.defaultValue === null) {
                await connection.query('ALTER TABLE `DoctorBloqueos` ADD COLUMN `recurrente_hasta` DATE NULL DEFAULT NULL, ALGORITHM=INSTANT');
            } else if (table === 'DoctorClinicas' && specification.type === Sequelize.BOOLEAN && specification.allowNull === false && specification.defaultValue === false) {
                await connection.query('ALTER TABLE `DoctorClinicas` ADD COLUMN `allow_legacy_attention_confirmation` TINYINT(1) NOT NULL DEFAULT 0, ALGORITHM=INSTANT');
            } else fail('PERSONAL_SCHEMA_UNEXPECTED_DDL');
        },
    };
}

function assertDevStopped(command = execFileSync) {
    for (const service of ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service']) {
        const state = command('systemctl', ['show', '--property=ActiveState', '--value', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (!['inactive', 'failed'].includes(state)) fail('PERSONAL_SCHEMA_STOP_DEV_WRITERS_FIRST');
    }
}
async function closeResources(connection, journal) {
    try { journal?.close(); } finally { await connection.end(); }
}

async function applyPlan({ connection, plan, info, target, journal, captureState = capture,
    migrationInterfaceFactory = boundedQueryInterface, loadMigration = migration => require(path.join(ROOT, 'migrations', migration.name)) }) {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [`cc-personal-calendar-schema:${target}`]);
    if (Number(lock.acquired) !== 1) fail('PERSONAL_SCHEMA_ANOTHER_OPERATOR_ACTIVE');
    let transaction = false;
    try {
        const current = await captureState(connection);
        validateBefore(plan, current, info, target);
        await journal.append({ phase: 'before_ddl', target, source_commit: info.commit, migrations: MIGRATIONS,
            before_sha256: hash(current), plan_sha256: hash(plan) });
        const Sequelize = require('sequelize');
        const qi = migrationInterfaceFactory(connection, Sequelize);
        for (const migration of MIGRATIONS) {
            // Recheck bytes immediately before executing each reviewed module.
            if (hash(readBytes(path.join(ROOT, 'migrations', migration.name))) !== migration.sha256) fail('PERSONAL_SCHEMA_REVIEWED_MIGRATION_CHANGED');
            await journal.append({ phase: 'migration_started', migration: migration.name, migration_sha256: migration.sha256 });
            await loadMigration(migration).up(qi, Sequelize);
            await journal.append({ phase: 'migration_ddl_completed', migration: migration.name });
        }
        verifyAfter(current, await captureState(connection));
        await journal.append({ phase: 'ddl_verified_before_metadata' });
        await connection.beginTransaction(); transaction = true;
        for (const migration of MIGRATIONS) await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [migration.name]);
        verifyAfter(current, await captureState(connection), { registered: true });
        await journal.append({ phase: 'metadata_verified_before_commit' });
        await connection.commit(); transaction = false;
        verifyAfter(current, await captureState(connection), { registered: true });
        await journal.append({ phase: 'verified', target, source_commit: info.commit, availability_rows_unchanged: true,
            new_tables_empty: true, limits_null: true, legacy_permissions_disabled: true, configuration_changed: false, process_restarted: false });
        return { status: 'applied_verified', target, source_commit: info.commit, migrations: MIGRATIONS.map(m => m.name), business_data_written: false };
    } catch (error) {
        if (transaction) await connection.rollback();
        await journal.append({ phase: 'failed_preserve_additive_schema', instruction: 'Inspect the journal and schema. No retry, down migration or database restore over subsequent writes.' });
        throw error;
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [`cc-personal-calendar-schema:${target}`]);
    }
}

async function run(args) {
    const options = parseArgs(args, ['--mode', '--target', '--private-output', '--plan', '--approved-plan-sha256', '--backup-manifest', '--private-journal']);
    const mode = options['--mode'], target = options['--target'];
    if (!['prepare', 'check', 'apply', 'verify'].includes(mode) || !['dev', 'crm'].includes(target)) fail('PERSONAL_SCHEMA_EXPLICIT_MODE_TARGET_REQUIRED');
    const info = source(), configuration = databaseOptions(target);
    const configurationHash = hash(configuration);
    const connection = await connectOperatorDatabase(target);
    let journal;
    try {
        await connection.query('SET SESSION lock_wait_timeout=10');
        if (mode !== 'apply') {
            if (!options['--private-output']) fail('PERSONAL_SCHEMA_PRIVATE_OUTPUT_REQUIRED');
            await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            let state;
            try { state = await capture(connection); } finally { await connection.rollback(); }
            if (mode === 'prepare') {
                assertUnapplied(state);
                const plan = { version: VERSION, target, source_commit: info.commit, migrations: MIGRATIONS,
                    generated_at: new Date().toISOString(), configuration_sha256: configurationHash, before: state };
                writePrivateJson(options['--private-output'], plan);
                return { status: 'prepared', target, source_commit: info.commit, migrations: MIGRATIONS.map(m => m.name), plan_sha256: hash(plan), business_data_written: false };
            }
            verifySchema(state);
            if (mode === 'verify') {
                if (!options['--plan']) fail('PERSONAL_SCHEMA_VERIFICATION_PLAN_REQUIRED');
                const plan = privateJson(options['--plan']);
                validatePlan(plan, info, target, { fresh: false });
                if (plan.configuration_sha256 !== configurationHash) fail('PERSONAL_SCHEMA_TARGET_CONFIGURATION_CHANGED');
                verifyAfter(plan.before, state, { registered: true });
            }
            writePrivateJson(options['--private-output'], { status: mode === 'check' ? 'compatible' : 'verified', target,
                source_commit: info.commit, migrations: MIGRATIONS, state, business_data_written: false });
            return { status: mode === 'check' ? 'compatible' : 'verified', target, source_commit: info.commit, business_data_written: false };
        }
        if (!options['--plan'] || !options['--backup-manifest'] || !options['--private-journal']) fail('PERSONAL_SCHEMA_APPROVED_PLAN_BACKUP_JOURNAL_REQUIRED');
        const plan = privateJson(options['--plan']), backup = privateJson(options['--backup-manifest']);
        validatePlan(plan, info, target);
        if (options['--approved-plan-sha256'] !== hash(plan)) fail('PERSONAL_SCHEMA_APPROVED_PLAN_HASH_REQUIRED');
        if (plan.configuration_sha256 !== configurationHash) fail('PERSONAL_SCHEMA_TARGET_CONFIGURATION_CHANGED');
        validateBackupManifest(backup, plan, configuration, target);
        await validateBackup(options['--backup-manifest']);
        if (target === 'dev') assertDevStopped();
        if (fs.existsSync(options['--private-journal'])) fail('PERSONAL_SCHEMA_NEW_JOURNAL_REQUIRED');
        journal = newJournal(options['--private-journal'], hash(plan));
        await journal.append({ phase: 'backup_verified', backup_manifest_sha256: hash(backup), backup_sha256: backup.backup.sha256 });
        return await applyPlan({ connection, plan, info, target, journal });
    } finally { await closeResources(connection, journal); }
}

if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(/^PERSONAL_SCHEMA_[A-Z_]+$/.test(error.message) ? error.message : 'PERSONAL_SCHEMA_FAILED_INSPECT_PRIVATE_JOURNAL');
    process.exitCode = 1;
});
module.exports = { VERSION, MIGRATIONS, source, capture, assertUnapplied, verifySchema, validatePlan, validateBefore,
    validateBackupManifest, verifyAfter, boundedQueryInterface, assertDevStopped, closeResources, applyPlan, run };
