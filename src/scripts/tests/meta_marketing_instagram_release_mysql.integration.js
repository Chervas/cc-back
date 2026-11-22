'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const P = require('../../lib/rdsSchemaMigrationPolicy');
const { migrationInterface } = require('../../lib/rdsSchemaMigration');
const { snapshot, compare } = require('../../lib/securitySchemaContract');
const contract = require('../../../ops/security/schema-contract.json');

const table = 'MetaMarketingInstagramExtensions';
const name = '20261122200000-create-meta-marketing-instagram-extensions.js';
const feature = 'meta_marketing_instagram_extension';
const source = path.resolve(__dirname, '../../..');
const available = { META_MARKETING_INSTAGRAM_EXTENSION_ENABLED: 'true' };
const targetOnly = requirements => ({ tables: { [table]: requirements.contract.tables[table] }, migrations: [requirements.contract.migrations.find(row => row.name === name)] });

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const disabled = P.effectiveRequirements({ contract }, [], {}, 'staging');
  assert(disabled.contract.disabledFeatureGroups.includes(feature));
  assert(!Object.hasOwn(disabled.contract.tables, table));
  const enabled = P.effectiveRequirements({ contract }, [], available, 'staging');
  assert(enabled.scope.runtimeFeatureGroups.includes(feature));
  const selected = P.effectiveRequirements({ contract }, [name], {}, 'staging');
  assert(selected.scope.selectedFeatureGroups.includes(feature));
  assert.deepEqual(targetOnly(selected), targetOnly(enabled));

  await sql.getQueryInterface().createTable('SequelizeMeta', { name: { type: Sequelize.STRING(255), primaryKey: true } });
  const pins = P.migrationFiles(source, [name]);
  assert.equal(pins.find(pin => pin.path === 'migrations/' + name).sha256, targetOnly(selected).migrations[0].sha256);
  const { migration, facade } = P.loadMigration(source, name, pins, Sequelize);
  const raw = await sql.connectionManager.getConnection();
  const events = [];
  const guard = migrationInterface({ admin: { raw, identity: { database: report.database, engineVersion: report.mysql } },
    aws: { assertFresh() {} }, journal: event => events.push(event), migrationName: name, Sequelize });
  try {
    await migration.up(guard.queryInterface, facade);
  } finally {
    await guard.restore();
    await sql.connectionManager.releaseConnection(raw);
  }
  assert.deepEqual(events.map(event => event.event), ['statement_request','statement_ack']);
  assert.equal(events[0].sqlSha256, events[1].sqlSha256);
  assert.equal(events[1].warnings, 0);
  await sql.query('INSERT INTO SequelizeMeta(name) VALUES (?)', { replacements: [name] });
  const schema = await snapshot((query, values) => sql.query(query, { replacements: values, type: Sequelize.QueryTypes.SELECT }));
  const differences = compare(schema, targetOnly(selected));
  assert.equal(differences.compatible, true, JSON.stringify(differences.issues));
  assert.deepEqual(schema.tables.map(row => row.TABLE_NAME), [table, 'SequelizeMeta']);
  report.checks.push('The selective RDS plan accepts exactly one acknowledged CREATE on an owned socket-only MySQL and verifies all schema metadata.');

  const model = require('../../../models/metamarketinginstagramextension')(sql, Sequelize.DataTypes);
  const now = new Date();
  const row = { flow_id: randomUUID(), scope_key: 'clinic:77', reserved_scope: 'clinic:77', enrollment_id: randomUUID(),
    authority_hash: '1'.repeat(64), structure_hash: '2'.repeat(64), connection_ref: 'fictitious-connection',
    state_hash: '3'.repeat(64), code_hash: '4'.repeat(64), actor_user_id: 10, session_ref: randomUUID(),
    session_expires_at: now, requested_at: now, expires_at: now, status: 'awaiting' };
  const first = await model.create(row);
  const retry = { ...row, flow_id: randomUUID(), state_hash: '5'.repeat(64), code_hash: null };
  await assert.rejects(model.create(retry), { name: 'SequelizeUniqueConstraintError' });
  await first.update({ status: 'cancelled', reserved_scope: null, cancelled_at: now });
  const second = await model.create(retry);
  await assert.rejects(second.update({ code_hash: row.code_hash }), { name: 'SequelizeUniqueConstraintError' });
  assert.equal(await model.count(), 2);
  report.checks.push('Scope reservation serializes retries, cancellation keeps its history, and replayed provider codes remain unique.');
}).catch(error => { console.error(error); process.exitCode = 1; });
