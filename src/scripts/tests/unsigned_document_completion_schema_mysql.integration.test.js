'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const operator = require('../unsigned-document-completion-schema-release');
const migration = require('../../../migrations/20261017180000-add-unsigned-document-completion');

test('unsigned completion schema release appends original enums online, backs up before DDL, preserves all rows and records only this migration', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async owned => {
  const { sql } = owned;
  const Package = require('../../../models/consentsignaturepackage')(sql, DataTypes);
  const Document = require('../../../models/patientconsentdocument')(sql, DataTypes);
  await sql.sync();
  await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
  await sql.query("INSERT INTO SequelizeMeta(name) VALUES('prior-owned-fixture.js')");
  await Package.create({ public_id: 'pkg_owned_schema', paciente_id: 1, clinica_id: 72, status: 'signed', required_count: 1, signed_count: 1 });
  await Document.create({ public_id: 'doc_owned_schema', paciente_id: 1, clinica_id: 72, title: 'Documento ficticio intacto', status: 'signed',
    signed_at: new Date('2025-01-01'), snapshot_json: { signature_evidence: { method: 'owned_test', preserved: true } }, snapshot_html: '<p>Conservar</p>' });
  // Reconstruct the actual original DB shape before release: no completed
  // enum, unchanged nullable/default/index/other columns and existing evidence.
  await migration.down(sql.getQueryInterface());
  const connection = await require('mysql2/promise').createConnection({ socketPath: sql.options.dialectOptions.socketPath,
    user: 'root', database: 'campaign_optimization_qa', dateStrings: true });
  try {
    const beforeRows = JSON.stringify({ docs: await Document.findAll({ raw: true }), packages: await Package.findAll({ raw: true }) });
    const before = await operator.capture(connection);
    for (const [table, type] of Object.entries(operator.TYPES)) assert.equal(before.columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === 'status').COLUMN_TYPE, type);
    const info = { commit: 'owned-fixture-not-production', pins: {} };
    const plan = { schema_version: operator.VERSION, target: 'dev', migration: operator.NAME, source: info, generated_at: new Date().toISOString(), before };
    const entries = []; let backup = null;
    const receipt = await operator.execute({ connection, target: 'dev', plan, approvedHash: operator.hash(plan), info,
      backupPath: 'owned-memory-only', saveBackup: (_path, value) => { backup = value; },
      journal: { append: async entry => { assert(backup, 'Durable before image is required before every DDL intent'); entries.push(entry); } } });
    assert.equal(receipt.status, 'applied_verified'); assert.equal(receipt.business_dml, false);
    assert(backup.before.ddl.PatientConsentDocuments.includes('CREATE TABLE'));
    assert.equal(entries.filter(row => row.phase === 'ddl_complete').length, 2);
    assert.equal(JSON.stringify({ docs: await Document.findAll({ raw: true }), packages: await Package.findAll({ raw: true }) }), beforeRows);
    const [metadata] = await connection.query('SELECT name FROM SequelizeMeta ORDER BY name');
    assert.deepEqual(metadata.map(row => row.name).sort(), ['prior-owned-fixture.js', operator.NAME].sort());
    const already = await operator.capture(connection);
    const retryPlan = { ...plan, before: already, generated_at: new Date().toISOString() };
    const retried = await operator.execute({ connection, target: 'dev', plan: retryPlan, approvedHash: operator.hash(retryPlan), info,
      saveBackup: () => {}, journal: { append: async entry => { assert.notEqual(entry.phase, 'ddl_intent', 'Reviewed already-expanded schema is an idempotent no-DDL verification'); } } });
    assert.equal(retried.status, 'applied_verified');
    await assert.rejects(() => operator.execute({ connection, target: 'dev', plan, approvedHash: operator.hash(plan), info,
      saveBackup: () => assert.fail('A stale plan must fail before backup or DDL'), journal: { append: async () => assert.fail() } }), /SCHEMA_DRIFT/);
    // Standard migration entrypoint also works against both original enums.
    await migration.down(sql.getQueryInterface()); await migration.up(sql.getQueryInterface());
    assert.equal(JSON.stringify({ docs: await Document.findAll({ raw: true }), packages: await Package.findAll({ raw: true }) }), beforeRows);
    owned.report.checks.push('Original enums rebuilt in owned schema; actual online append-only DDL, full columns preserved, signed data byte-identical, backup before DDL, durable migration record, idempotent replay, stale-plan refusal and standard up/down verified; no app/models index bootstrap or external connection');
  } finally { await connection.end(); }
}));
