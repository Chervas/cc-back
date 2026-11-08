'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const contract = require('../../../ops/security/schema-contract.json');
const native = require('./fixtures/legal_acceptance_mysql_schema.json');
const { effectiveContract, compare } = require('../../lib/securitySchemaContract');
const P = require('../../lib/legalAcceptanceSchemaPreflight');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function legalContract(env) {
    const selected = effectiveContract(contract, env);
    return { tables: selected.tables[P.TABLE] ? { [P.TABLE]: selected.tables[P.TABLE] } : {},
        migrations: selected.migrations.filter(row => row.name === P.MIGRATION) };
}
test('legal schema is required solely for the API and leaves all unrelated feature requirements unchanged', () => {
    const group = contract.featureGroups[P.GROUP];
    assert.deepEqual(group, { enabledWhenAll: { RUNTIME_ROLE: 'api' }, tables: [P.TABLE], migrations: [P.MIGRATION] });
    const previous = structuredClone(contract);
    delete previous.featureGroups[P.GROUP]; delete previous.tables[P.TABLE];
    previous.migrations = previous.migrations.filter(row => row.name !== P.MIGRATION);
    for (const env of [{ RUNTIME_ROLE: 'api' }, { RUNTIME_ROLE: 'gateway' }, {},
        { RUNTIME_ROLE: 'gateway', AUTH_DELEGATION_ENABLED: 'true', DB_TLS_REQUIRED: 'true', META_MARKETING_BROKER_ENABLED: 'true' }]) {
        const actual = effectiveContract(contract, env);
        assert.equal(Boolean(actual.tables[P.TABLE]), env.RUNTIME_ROLE === 'api');
        assert.equal(P.selected(contract, env), env.RUNTIME_ROLE === 'api');
        delete actual.featureGroups[P.GROUP]; delete actual.tables[P.TABLE];
        actual.migrations = actual.migrations.filter(row => row.name !== P.MIGRATION);
        actual.disabledFeatureGroups = (actual.disabledFeatureGroups || []).filter(name => name !== P.GROUP);
        assert.deepEqual(actual, effectiveContract(previous, env));
    }
});
test('release contract is pinned to the owned MySQL native schema including declaration snapshot and exact unique index', () => {
    const file = path.join(__dirname, 'fixtures/legal_acceptance_mysql_schema.json');
    assert.equal(hash(fs.readFileSync(file)), 'b2de824c95f0424e952ca548eeb125a5772db24efa80fcc506eb16359e74ea6c');
    const expected = contract.tables[P.TABLE];
    assert.equal(expected.ENGINE, native.tables[0].ENGINE);
    assert.equal(expected.TABLE_COLLATION, native.tables[0].TABLE_COLLATION);
    assert.deepEqual(expected.columns, native.columns.map(({ TABLE_NAME, ...column }) => column));
    assert.deepEqual(expected.indexes.flatMap(index => index.columns), native.indexes.map(({ TABLE_NAME, ...column }) => column));
    assert.deepEqual(expected.foreignKeys, []);
    assert.equal(expected.columns.find(row => row.COLUMN_NAME === 'authority_declaration_text').COLUMN_TYPE, 'text');
    assert.equal(expected.columns.find(row => row.COLUMN_NAME === 'authority_declaration_sha256').COLUMN_TYPE, 'varchar(64)');
    const pin = contract.migrations.find(row => row.name === P.MIGRATION);
    assert.equal(pin.sha256, hash(fs.readFileSync(path.resolve(__dirname, '../../../migrations', P.MIGRATION))));
});
test('schema absence blocks API publication while gateway has no dependency on legal data or migration', () => {
    const missing = { defaults: {}, tables: [], columns: [], indexes: [], checks: [], foreignKeys: [], migrations: [] };
    const api = compare(missing, legalContract({ RUNTIME_ROLE: 'api' }));
    assert.equal(api.compatible, false);
    assert.ok(api.issues.some(row => row.table === P.TABLE && row.reason === 'missing_table'));
    assert.deepEqual(api.missingMigrations, [P.MIGRATION]);
    assert.equal(compare(missing, legalContract({ RUNTIME_ROLE: 'gateway' })).compatible, true);
    const observed = { ...structuredClone(native), migrations: [P.MIGRATION] };
    assert.equal(compare(observed, legalContract({ RUNTIME_ROLE: 'api' })).compatible, true);
    observed.columns = observed.columns.filter(row => row.COLUMN_NAME !== 'authority_declaration_sha256');
    assert.equal(compare(observed, legalContract({ RUNTIME_ROLE: 'api' })).compatible, false);
});
test('append-only grant proof performs metadata reads and requires SELECT+INSERT without UPDATE/DELETE', async () => {
    for (const [grant, missing] of [
        ['GRANT SELECT, INSERT ON `fixture`.`LegalDocumentAcceptances` TO FICTITIOUS_PRIVATE_ACCOUNT', []],
        ['GRANT ALL PRIVILEGES ON `fixture`.* TO FICTITIOUS_PRIVATE_ACCOUNT', []],
        ['GRANT SELECT ON `fixture`.`LegalDocumentAcceptances` TO FICTITIOUS_PRIVATE_ACCOUNT', ['INSERT']],
        ['GRANT UPDATE, DELETE ON `fixture`.`LegalDocumentAcceptances` TO FICTITIOUS_PRIVATE_ACCOUNT', ['SELECT', 'INSERT']],
        ['GRANT SELECT, INSERT ON `another`.* TO FICTITIOUS_PRIVATE_ACCOUNT', ['SELECT', 'INSERT']],
        ['GRANT SELECT, INSERT ON `fixture`.`Usuarios` TO FICTITIOUS_PRIVATE_ACCOUNT', ['SELECT', 'INSERT']],
        ['GRANT INSERT (`document_slug`) ON `fixture`.`LegalDocumentAcceptances` TO FICTITIOUS_PRIVATE_ACCOUNT', ['SELECT', 'INSERT']],
    ]) {
        const queries = [];
        const report = await P.check(async sql => {
            queries.push(sql); return sql.startsWith('SELECT') ? [{ database_name: 'fixture' }] : [{ Grant: grant }];
        });
        assert.deepEqual(report.required, ['SELECT', 'INSERT']);
        assert.deepEqual(report.missing, missing);
        assert.equal(report.compatible, missing.length === 0);
        assert.deepEqual(queries, ['SELECT DATABASE() AS database_name', 'SHOW GRANTS FOR CURRENT_USER']);
        assert.ok(!JSON.stringify(report).includes('FICTITIOUS_PRIVATE_ACCOUNT'));
    }
});
