'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const cut = require('../personal-calendar-schema-release');
const copy = value => JSON.parse(JSON.stringify(value));
const info = { commit: 'a'.repeat(40), migrations: cut.MIGRATIONS };
const roots = path.resolve(__dirname, '../../..');
const now = Date.now();

function initial() {
    return {
        identity_sha256: 'identity', server_sha256: hash('fake-host'),
        tables: ['DoctorBloqueos', 'DoctorClinicas', 'SequelizeMeta'].map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_bin' })),
        columns: ['DoctorBloqueos', 'DoctorClinicas', 'SequelizeMeta'].map(TABLE_NAME => ({ TABLE_NAME, COLUMN_NAME: TABLE_NAME === 'SequelizeMeta' ? 'name' : 'id', COLUMN_TYPE: TABLE_NAME === 'SequelizeMeta' ? 'varchar(255)' : 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', GENERATION_EXPRESSION: '', ORDINAL_POSITION: 1 })),
        indexes: [], foreignKeys: [], triggers: [], metadata_names: ['previous.js'],
        fingerprints: { DoctorBloqueos: { count: 2, sha256: 'blocks', nondefault: 0 }, DoctorClinicas: { count: 3, sha256: 'links', nondefault: 0 }, PersonalCalendarRevisions: null, PersonalCalendarUndoReceipts: null },
    };
}
const planFor = before => ({ version: cut.VERSION, target: 'crm', source_commit: info.commit, migrations: cut.MIGRATIONS,
    generated_at: new Date(now).toISOString(), before: copy(before) });
function fieldType(type) {
    if (type.key === 'INTEGER') return 'int';
    if (type.key === 'BIGINT') return 'bigint unsigned';
    if (type.key === 'DATE') return type.options?.length ? `datetime(${type.options.length})` : 'datetime';
    if (type.key === 'STRING') return `varchar(${type.options.length})`;
    if (type.key === 'UUID') return 'char(36)';
    if (type.key === 'JSON') return 'json';
    if (type.key === 'DATEONLY') return 'date';
    if (type.key === 'BOOLEAN') return 'tinyint(1)';
    throw Error('Unexpected fixture type ' + type.key);
}

// Real, hash-pinned migration up() bodies mutate only this RAM schema.
function fixture() {
    const state = initial(), calls = [], events = [];
    let priorMetadata;
    const index = (TABLE_NAME, INDEX_NAME, fields, unique) => fields.forEach((COLUMN_NAME, i) => state.indexes.push({ TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX: i + 1, NON_UNIQUE: unique ? 0 : 1, SUB_PART: null, INDEX_TYPE: 'BTREE' }));
    const column = (TABLE_NAME, COLUMN_NAME, specification, ordinal) => {
        state.columns.push({ TABLE_NAME, COLUMN_NAME, COLUMN_TYPE: fieldType(specification.type), IS_NULLABLE: specification.allowNull === true ? 'YES' : 'NO',
            COLUMN_DEFAULT: specification.defaultValue == null ? null : specification.defaultValue === false ? '0' : String(specification.defaultValue),
            EXTRA: '', GENERATION_EXPRESSION: '', ORDINAL_POSITION: ordinal });
        if (specification.primaryKey) index(TABLE_NAME, 'PRIMARY', [COLUMN_NAME], true);
        else if (specification.unique) index(TABLE_NAME, COLUMN_NAME, [COLUMN_NAME], true);
    };
    const qi = {
        createTable: async (name, columns) => {
            calls.push(['create', name]);
            state.tables.push({ TABLE_NAME: name, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_bin' });
            Object.entries(columns).forEach(([nameOfColumn, spec], i) => column(name, nameOfColumn, spec, i + 1));
            state.fingerprints[name] = 0;
        },
        addIndex: async (name, fields) => { calls.push(['index', name]); index(name, fields.join('_'), fields, false); },
        addColumn: async (name, field, specification) => {
            calls.push(['column', name, field]); column(name, field, specification, 2);
        },
    };
    const connection = {
        query: async (sql, values) => {
            calls.push([sql, values]);
            if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }]];
            if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
            if (sql.startsWith('INSERT INTO SequelizeMeta')) { assert(priorMetadata, 'Metadata INSERT must be inside its transaction'); state.metadata_names.push(values[0]); state.metadata_names.sort(); return [{ affectedRows: 1 }]; }
            throw Error('Unexpected offline query');
        },
        beginTransaction: async () => { calls.push(['begin']); priorMetadata = [...state.metadata_names]; },
        commit: async () => { calls.push(['commit']); priorMetadata = null; },
        rollback: async () => { calls.push(['rollback']); state.metadata_names = priorMetadata; priorMetadata = null; },
    };
    const apply = options => cut.applyPlan({ connection, plan: planFor(initial()), info, target: 'crm', journal: { append: async event => events.push(copy(event)) },
        captureState: async () => ({ ...copy(state), columns: copy(state.columns).sort((a, b) => a.TABLE_NAME.localeCompare(b.TABLE_NAME) || a.ORDINAL_POSITION - b.ORDINAL_POSITION) }),
        migrationInterfaceFactory: () => qi, ...options });
    return { state, calls, events, qi, connection, apply };
}
async function finalState() { const f = fixture(); await f.apply(); return f.state; }

test('the operator allows exactly the three reviewed migration byte hashes', () => {
    assert.equal(cut.MIGRATIONS.length, 3);
    for (const migration of cut.MIGRATIONS) assert.equal(hash(fs.readFileSync(path.join(roots, 'migrations', migration.name))), migration.sha256);
});

test('plans reject wrong source/target/order/hash, expiration, drift and any existing or partial DDL', () => {
    const before = initial(), plan = planFor(before);
    assert.doesNotThrow(() => cut.validateBefore(plan, before, info, 'crm', { now }));
    for (const change of [{ target: 'dev' }, { source_commit: 'b'.repeat(40) }, { migrations: [...cut.MIGRATIONS].reverse() },
        { migrations: [{ ...cut.MIGRATIONS[0], sha256: 'b'.repeat(64) }, ...cut.MIGRATIONS.slice(1)] },
        { generated_at: new Date(now + 1).toISOString() }, { generated_at: new Date(now - 7200001).toISOString() }]) {
        assert.throws(() => cut.validateBefore({ ...plan, ...change }, before, info, 'crm', { now }), /PLAN_INVALID/);
    }
    const drift = copy(before); drift.fingerprints.DoctorBloqueos.sha256 = 'changed';
    assert.throws(() => cut.validateBefore(plan, drift, info, 'crm', { now }), /PLAN_DRIFT/);
    for (const update of [s => s.tables.push({ TABLE_NAME: 'PersonalCalendarRevisions' }),
        s => s.columns.push({ TABLE_NAME: 'DoctorBloqueos', COLUMN_NAME: 'recurrente_hasta' }),
        s => s.columns.push({ TABLE_NAME: 'DoctorClinicas', COLUMN_NAME: 'allow_legacy_attention_confirmation' }),
        s => s.metadata_names.push(cut.MIGRATIONS[0].name)]) {
        const partial = copy(before); update(partial);
        assert.throws(() => cut.validateBefore(planFor(partial), partial, info, 'crm', { now }), /PARTIAL/);
    }
});

test('the exact created schema verifies precision, unsigned revisions, defaults and all indexes', async () => {
    const state = await finalState();
    assert.doesNotThrow(() => cut.verifySchema(state));
    const alterations = [
        s => s.columns.find(c => c.COLUMN_NAME === 'revision').COLUMN_TYPE = 'bigint',
        s => s.columns.find(c => c.COLUMN_NAME === 'expires_at').COLUMN_TYPE = 'datetime',
        s => s.columns.find(c => c.COLUMN_NAME === 'recurrente_hasta').IS_NULLABLE = 'NO',
        s => s.columns.find(c => c.COLUMN_NAME === 'allow_legacy_attention_confirmation').COLUMN_DEFAULT = '1',
        s => s.indexes.find(i => i.COLUMN_NAME === 'token_hash').NON_UNIQUE = 1,
        s => s.indexes.find(i => i.COLUMN_NAME === 'actor_user_id').SUB_PART = 2,
        s => s.foreignKeys.push({ TABLE_NAME: 'PersonalCalendarUndoReceipts' }),
        s => s.triggers.push({ EVENT_OBJECT_TABLE: 'PersonalCalendarRevisions' }),
        s => s.tables.find(table => table.TABLE_NAME === 'SequelizeMeta').ENGINE = 'MyISAM',
        s => s.triggers.push({ EVENT_OBJECT_TABLE: 'SequelizeMeta' }),
        s => { s.metadata_names = s.metadata_names.filter(name => name !== cut.MIGRATIONS[0].name); },
    ];
    for (const alter of alterations) { const changed = copy(state); alter(changed); assert.throws(() => cut.verifySchema(changed)); }
});

test('cut verification rejects changes in original availability, defaults, metadata, identities or new table contents', async () => {
    const before = initial(), after = await finalState();
    assert.doesNotThrow(() => cut.verifyAfter(before, after, { registered: true }));
    for (const change of [s => s.fingerprints.DoctorClinicas.sha256 = 'changed', s => s.fingerprints.DoctorBloqueos.count++,
        s => s.fingerprints.DoctorClinicas.nondefault = 1, s => s.fingerprints.DoctorBloqueos.nondefault = 1,
        s => s.fingerprints.PersonalCalendarRevisions = 1, s => s.identity_sha256 = 'other',
        s => s.columns.find(c => c.TABLE_NAME === 'DoctorClinicas' && c.COLUMN_NAME === 'id').COLUMN_TYPE = 'bigint',
        s => s.metadata_names.push('unreviewed.js')]) {
        const changed = copy(after); change(changed); assert.throws(() => cut.verifyAfter(before, changed, { registered: true }));
    }
});

test('backup is bound to target/server/database, full verified output and a two-hour window', () => {
    const plan = planFor(initial()), configuration = { database: 'fictitious_crm' };
    const backup = { database_target: 'crm', database_name: configuration.database, server_name: 'fake-host', full_gzip_verified: true, dump_completion_verified: true, generated_at: new Date(now).toISOString() };
    assert.doesNotThrow(() => cut.validateBackupManifest(backup, plan, configuration, 'crm', now));
    for (const change of [{ database_target: 'dev' }, { database_name: 'other' }, { server_name: 'other' }, { full_gzip_verified: false }, { dump_completion_verified: false },
        { generated_at: new Date(now + 1).toISOString() }, { generated_at: new Date(now - 7200001).toISOString() }]) {
        assert.throws(() => cut.validateBackupManifest({ ...backup, ...change }, plan, configuration, 'crm', now), /FRESH_TARGET_BACKUP/);
    }
});

test('the bounded adapter executes both actual column migrations as INSTANT ADD and refuses arbitrary DDL', async () => {
    const D = require('sequelize'), calls = [];
    class FakeSequelize { constructor() { this.connectionManager = {}; } getQueryInterface() { return { createTable: async (...args) => calls.push(['create', ...args]), addIndex: async (...args) => calls.push(['index', ...args]) }; } }
    FakeSequelize.DATEONLY = D.DATEONLY; FakeSequelize.BOOLEAN = D.BOOLEAN;
    const qi = cut.boundedQueryInterface({ query: async sql => calls.push(sql) }, FakeSequelize);
    for (const migration of cut.MIGRATIONS.slice(1)) await require(path.join(roots, 'migrations', migration.name)).up(qi, D);
    assert.equal(calls.length, 2); assert(calls.every(sql => sql.endsWith(', ALGORITHM=INSTANT')));
    await assert.rejects(qi.addColumn('DoctorClinicas', 'allow_legacy_attention_confirmation', { type: D.BOOLEAN, allowNull: false, defaultValue: true }), /UNEXPECTED_DDL/);
    await assert.rejects(qi.addColumn('Pacientes', 'name', { type: D.DATEONLY, allowNull: true, defaultValue: null }), /UNEXPECTED_DDL/);
    await assert.rejects(qi.createTable('CitasPacientes', {}), /UNEXPECTED_DDL/);
    await assert.rejects(qi.addIndex('PersonalCalendarUndoReceipts', ['before_state']), /UNEXPECTED_DDL/);
    assert.equal(calls.length, 2);
});

test('both DEV writers must be stopped; the check reads only unit state', () => {
    const commands = [], inactive = (bin, args) => { commands.push([bin, args]); return 'inactive\n'; };
    assert.doesNotThrow(() => cut.assertDevStopped(inactive));
    assert.equal(commands.length, 2); assert(commands.every(([bin, args]) => bin === 'systemctl' && args[0] === 'show' && args[1] === '--property=ActiveState'));
    for (const active of ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service']) {
        assert.throws(() => cut.assertDevStopped((_bin, args) => args.at(-1) === active ? 'active' : 'inactive'), /STOP_DEV_WRITERS/);
    }
});

test('apply runs the three real migration bodies and registers exactly their names in one late transaction', async () => {
    const f = fixture(), result = await f.apply();
    assert.equal(result.status, 'applied_verified');
    assert.deepEqual(f.state.metadata_names, ['previous.js', ...cut.MIGRATIONS.map(m => m.name)].sort());
    assert.equal(f.calls.filter(c => c[0] === 'begin').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'commit').length, 1);
    const firstInsert = f.calls.findIndex(c => c[0].startsWith('INSERT INTO SequelizeMeta'));
    const finalDDL = f.calls.findIndex(c => c[0] === 'column' && c[1] === 'DoctorClinicas');
    assert(firstInsert > finalDDL);
    assert.deepEqual(f.events.filter(e => e.phase === 'migration_started').map(e => e.migration), cut.MIGRATIONS.map(m => m.name));
    assert.equal(f.events[0].phase, 'before_ddl'); assert.equal(f.events.at(-1).phase, 'verified');
});

test('changed plans and an occupied mutex stop before any DDL or migration registration', async () => {
    const f = fixture(), plan = planFor(initial()); plan.source_commit = 'wrong';
    await assert.rejects(f.apply({ plan }), /PLAN_INVALID/);
    assert.equal(f.calls.some(c => ['create', 'column', 'begin'].includes(c[0])), false);
    const busy = fixture(); busy.connection.query = async () => [[{ acquired: 0 }]];
    await assert.rejects(busy.apply(), /ANOTHER_OPERATOR/);
    assert.equal(busy.events.length, 0);
});

test('MyISAM metadata or metadata triggers reject the cut before any DDL', async () => {
    for (const alter of [state => { state.tables.find(table => table.TABLE_NAME === 'SequelizeMeta').ENGINE = 'MyISAM'; },
        state => state.triggers.push({ EVENT_OBJECT_TABLE: 'SequelizeMeta', TRIGGER_NAME: 'unreviewed' })]) {
        const f = fixture(); alter(f.state);
        await assert.rejects(f.apply({ plan: planFor(f.state) }), /INNODB_REQUIRED|METADATA_TRIGGERS/);
        assert.equal(f.calls.some(c => ['create', 'column', 'begin'].includes(c[0])), false);
    }
});

test('the connection closes even when closing the private journal throws', async () => {
    let closed = false;
    await assert.rejects(cut.closeResources({ end: async () => { closed = true; } }, { close: () => { throw Error('synthetic journal close'); } }), /journal close/);
    assert.equal(closed, true);
});

test('concurrent availability drift fails after DDL without registering any migration', async () => {
    const f = fixture(), original = f.qi.addColumn;
    f.qi.addColumn = async (...args) => { await original(...args); f.state.fingerprints.DoctorClinicas.sha256 = 'concurrent edit'; };
    await assert.rejects(f.apply(), /EXISTING_AVAILABILITY_CHANGED/);
    assert.deepEqual(f.state.metadata_names, ['previous.js']);
    assert.equal(f.events.at(-1).phase, 'failed_preserve_additive_schema');
});

test('a partial DDL failure preserves evidence and a second attempt is rejected before additional DDL', async () => {
    const f = fixture();
    await assert.rejects(f.apply({ loadMigration: migration => migration.name === cut.MIGRATIONS[2].name
        ? { up: async () => { throw Error('synthetic instant add rejected'); } }
        : require(path.join(roots, 'migrations', migration.name)) }), /synthetic instant/);
    assert.deepEqual(f.state.metadata_names, ['previous.js']);
    const count = f.calls.filter(c => ['create', 'column'].includes(c[0])).length;
    await assert.rejects(f.apply(), /PARTIAL/);
    assert.equal(f.calls.filter(c => ['create', 'column'].includes(c[0])).length, count);
});

test('a metadata commit failure rolls back registrations and retains the additive schema for inspection', async () => {
    const f = fixture(); f.connection.commit = async () => { throw Error('synthetic commit failure'); };
    await assert.rejects(f.apply(), /synthetic commit/);
    assert.deepEqual(f.state.metadata_names, ['previous.js']);
    assert.equal(f.calls.filter(c => c[0] === 'rollback').length, 1);
    assert.equal(f.state.fingerprints.PersonalCalendarUndoReceipts, 0);
    assert.equal(f.events.at(-1).phase, 'failed_preserve_additive_schema');
});
