'use strict';

// Actual report functions on a fictional, owned MySQL socket. Native private
// answers must not become website form counters or a synthetic 'Sin página'.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DataTypes: D, Op, literal, QueryTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const FormSubmissionEvent = sql.define('FormSubmissionEvent', {
    id: { type: D.INTEGER, autoIncrement: true, primaryKey: true }, clinic_id: D.INTEGER,
    page_url: D.STRING, form_id: D.STRING, form_name: D.STRING, form_selector: D.STRING,
    source_detail: D.STRING, submitted_at: D.DATE, fields_json: D.JSON,
  }, { tableName: 'FormSubmissionEvents', timestamps: false });
  sql.define('LeadIntake', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    page_url: D.STRING, landing_url: D.STRING, source: D.STRING, archived_at: D.DATE, created_at: D.DATE,
  }, { tableName: 'LeadIntakes', timestamps: false });
  sql.define('WhatsAppWebOrigin', { id: { type: D.INTEGER, primaryKey: true }, clinic_id: D.INTEGER,
    page_url: D.STRING, used_at: D.DATE, used_conversation_id: D.INTEGER, used_message_id: D.INTEGER, createdAt: D.DATE,
  }, { tableName: 'WhatsAppWebOrigins', timestamps: false });
  await sql.sync();
  const at = new Date('2030-01-01T12:00:00Z');
  await FormSubmissionEvent.bulkCreate([
    { clinic_id: 1, page_url: 'https://example.invalid/form', source_detail: 'web_form', submitted_at: at },
    { clinic_id: 1, page_url: null, source_detail: null, submitted_at: at },
    { clinic_id: 1, page_url: 'https://example.invalid/legacy', source_detail: 'metaxleadgen:42', submitted_at: at },
    { clinic_id: 1, page_url: null, form_id: '501', form_name: 'Native private form', source_detail: 'meta_leadgen:101', submitted_at: at,
      fields_json: { provider: 'meta_leadgen', fields: [{ values: ['NEVER_IN_REPORT'] }] } },
    { clinic_id: 2, page_url: null, form_id: '502', form_name: 'Native private form', source_detail: 'meta_leadgen:102', submitted_at: at,
      fields_json: { provider: 'meta_leadgen', fields: [{ values: ['NEVER_IN_REPORT'] }] } },
    { clinic_id: 2, page_url: 'https://example.invalid/other', source_detail: 'web_form', submitted_at: at },
  ]);
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/marketingReports.controller.js'), 'utf8');
  const functions = [
    source.slice(source.indexOf('function buildSequelizeDateWhere('), source.indexOf('function scopedRawOrEffectiveSql(')),
    source.slice(source.indexOf('async function aggregateForms('), source.indexOf('async function aggregateWhatsappWebOrigins(')),
    source.slice(source.indexOf('async function aggregateWebPages('), source.indexOf('async function aggregateBusinessProfile(')),
  ].join('\n');
  assert.ok(functions.includes('async function aggregateForms('));
  const { aggregateForms, aggregateWebPages } = vm.runInNewContext(`${functions}; ({aggregateForms,aggregateWebPages})`, {
    Op, literal, FormSubmissionEvent, sequelize: sql, QueryTypes, WebPageDaily: null,
    loadReportLeads: () => { throw Error('unexpected lead load'); }, isCommercialLead: () => true,
    normalizeUrlKey: value => value, toNumber: value => Number(value) || 0,
    shortUrl: value => value, ratioPct: (part, whole) => whole ? part * 100 / whole : 0,
  });
  const range = { start: new Date('2030-01-01T00:00:00Z'), endExclusive: new Date('2030-01-02T00:00:00Z'),
    startSql: '2030-01-01 00:00:00', endExclusiveSql: '2030-01-02 00:00:00', startLabel: '2030-01-01', endLabel: '2030-01-01' };
  assert.equal(await aggregateForms({ clinicIds: [1] }, range), 3);
  assert.equal(await aggregateForms({ clinicIds: [2] }, range), 1);
  assert.equal(await aggregateForms({ isAll: true }, range), 4);
  const pages = await aggregateWebPages({ clinicIds: [1] }, range, [], []);
  assert.equal(pages.reduce((count, row) => count + row.formularios, 0), 3);
  assert.equal(pages.find(row => row.url === 'Sin página').formularios, 1);
  assert.doesNotMatch(JSON.stringify(pages), /NEVER_IN_REPORT/);
  assert.equal(await FormSubmissionEvent.count(), 6);
  report.checks.push('Actual website aggregateForms excludes native Meta events while retaining legacy NULL source and exact-prefix near misses, with clinic/all scope counts');
  report.checks.push('Actual aggregateWebPages raw SQL excludes native Meta from Sin página/form counts; legacy web evidence remains and no private fields leave the query');
  const automationSource = fs.readFileSync(path.resolve(__dirname, '../../controllers/automationsV2.controller.js'), 'utf8');
  const handlerSource = automationSource.slice(automationSource.indexOf('exports.getRecentFormMatches ='),
    automationSource.indexOf('exports.validateTemplateGraph ='));
  assert.ok(handlerSource.startsWith('exports.getRecentFormMatches ='));
  const context = { exports: {}, Op, literal, FormSubmissionEvent,
    resolveAccess: async () => ({ user_id: 1, is_admin: true, clinic_ids: new Set([1]), group_ids: new Set() }),
    parseTemplateScopeQuery: () => ({ group_id: null, clinic_ids: [1] }),
    parseIntOrNull: value => Number.parseInt(value, 10) || null,
    cleanString: value => value == null ? null : String(value).trim() || null,
    resolveClinicIdsForGroup: () => { throw Error('unexpected group lookup'); },
    console: { error() { throw Error('recent form handler failed'); } },
  };
  vm.runInNewContext(handlerSource, context);
  let result;
  await context.exports.getRecentFormMatches({ query: { clinic_ids: '1' } }, {
    json(value) { result = value; return this; },
    status() { throw Error('unexpected recent form response status'); },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.items.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_IN_REPORT|Native private form|"501"|"502"/);
  report.checks.push('Actual recent-form suggestion handler returns only scoped legacy/web metadata; native Meta responses cannot suggest a web wait trigger that they do not emit');
  report.externalCalls = 0;
  report.pool = { inUse: sql.connectionManager.pool.using, waiting: sql.connectionManager.pool.waiting };
  assert.equal(report.pool.inUse, 0); assert.equal(report.pool.waiting, 0);
}).catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
