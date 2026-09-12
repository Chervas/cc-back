'use strict';
const assert = require('node:assert/strict');
const { QueryTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { collectMetadata } = require('../../lib/databaseEncryptionMetadata');
withIsolatedCampaignMysql(async ({ sql, report }) => {
  const value = await collectMetadata({ query: text => sql.query(text, { type: QueryTypes.SELECT }) });
  assert.equal(value.checks.engine.status, 'verified');
  assert.equal(value.checks.variables.status, 'verified');
  assert.equal(value.checks.schemaDefault.status, 'verified');
  assert.equal(value.checks.tablespaces.status, 'verified');
  assert.equal(value.checks.schemaFootprint.status, 'verified');
  assert.equal(value.checks.sessionTls.data.encrypted, false);
  assert.equal(value.diagnosticTransport, 'unix_socket');
  assert(value.findings.includes('unencrypted_tablespaces_observed'));
  assert(value.findings.includes('redo_encryption_disabled'));
  assert.equal(value.completeEncryptionAssessment, false);
  report.checks.push('ten actual metadata SQL statements on isolated MySQL', 'unencrypted baseline identified without clinical rows',
    'UNIX socket distinguished from application TLS', 'provider volume and backups remain unverified');
  report.metadata = value;
}).catch(() => { process.exitCode = 1; });
