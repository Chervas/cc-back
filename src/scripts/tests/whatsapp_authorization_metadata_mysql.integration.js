'use strict';
const assert = require('node:assert/strict');
const { QueryTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { attributes } = require('../../services/whatsappAuthorizationPhoneMetadata.service');

// Exercise every generated JSON_EXTRACT on synthetic data in a private MySQL
// process. No application models, host database, credentials or provider calls.
withIsolatedCampaignMysql(async ({ sql, report }) => {
  const selected = attributes().filter(Array.isArray);
  const generated = sql.getQueryInterface().queryGenerator.selectQuery('qa_phone_metadata', { attributes: selected });
  assert(!generated.includes('$$'), 'JSON paths must keep a single root dollar');
  assert.equal((generated.match(/JSON_EXTRACT\(`additionalData`, '\$\.[A-Za-z_.]+'\)/g) || []).length, selected.length);
  const query = generated.replace('FROM `qa_phone_metadata`', 'FROM (SELECT CAST(:payload AS JSON) AS `additionalData`) AS `qa_phone_metadata`');
  assert.notEqual(query, generated);
  const rows = await sql.query(query, { type: QueryTypes.SELECT, replacements: { payload: JSON.stringify({
    nameStatus: 'APPROVED', profileDescription: 'Fictitious public profile', registration: { status: 'CONNECTED', requiresPin: true },
    whatsappHealth: { state: 'healthy', can_send: true }, routing: { secondary_purposes: ['bulk_campaigns'] },
    accessToken: 'FICTITIOUS_NEVER_SELECTED', nestedPrivate: { password: 'FICTITIOUS_NEVER_SELECTED' },
  }) } });
  assert.equal(rows.length, 1);
  const value = key => { const v = rows[0]['wa_local_' + key]; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
  assert.equal(value('name_status'), 'APPROVED');
  assert.equal(value('profile_description'), 'Fictitious public profile');
  assert.equal(value('registration_status'), 'CONNECTED');
  assert.equal(value('registration_requires_pin'), true);
  assert.equal(value('health_can_send'), true);
  assert.deepEqual(value('routing_purposes'), ['bulk_campaigns']);
  assert.equal(value('profile_website'), null);
  assert.equal(Object.keys(rows[0]).length, selected.length);
  assert(!JSON.stringify(rows).includes('FICTITIOUS_NEVER_SELECTED'));
  report.checks.push('Every allowlisted JSON path executes through real Sequelize-generated MySQL SQL with one root dollar',
    'Scalar, nested, boolean, array and missing metadata decode correctly; private JSON leaves are not selected');
}).catch(() => { process.exitCode = 1; });
