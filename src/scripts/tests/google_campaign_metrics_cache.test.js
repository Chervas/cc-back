'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { collectGoogleCampaignMetrics, persistGoogleCampaignMetrics } = require('../../services/googleCampaignMetricsCache.service');

const account = { id: 11, customerId: '1234567890', googleConnectionId: 2, assignmentScope: 'group',
  grupoClinicaId: 5, clinicaId: 36, isActive: true, loginCustomerId: '9876543210' };
const now = new Date('2026-09-12T01:00:00Z');
const resource = (id = '456') => ({ customer: { id: account.customerId }, campaign: { id, name: `Campaign ${id}`, status: 'ENABLED' } });
const metricRow = (id = '456', cost = '1000000', group = null) => ({ ...resource(id),
  ...(group ? { adGroup: { id: group, name: 'Group' } } : {}),
  segments: { date: '2026-09-10', adNetworkType: 'SEARCH', device: 'MOBILE' },
  metrics: { impressions: '10', clicks: '2', costMicros: cost, conversions: '0.5', interactions: '2' } });

function source() {
  const calls = [];
  const data = { metadata: [{ customer: { id: account.customerId, currencyCode: 'EUR', timeZone: 'Europe/Madrid', manager: false } }],
    inventory: [resource(), resource('457')], campaigns: [metricRow(), metricRow('457', '2000000')], groups: [metricRow('456', '1000000', '800')] };
  const args = { account, accessToken: 'test-token', loginCustomerId: account.loginCustomerId,
    start: '2026-09-09', end: '2026-09-10', now: () => now, clock: () => +now,
    read: async options => {
      calls.push(options);
      return structuredClone(/FROM customer/.test(options.query) ? data.metadata
        : !/segments.date/.test(options.query) ? data.inventory
          : /FROM ad_group /.test(options.query) ? data.groups : data.campaigns);
    } };
  return { args, data, calls };
}

function database() {
  const writes = []; const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    sequelize: { transaction: async fn => fn(tx) },
    ClinicGoogleAdsAccount: { findAll: async options => { assert.equal(options.lock, 'UPDATE'); return [account]; } },
    GoogleConnectionAssignment: { findAll: async options => { assert.equal(options.lock, 'UPDATE'); return [{ googleConnectionId: 2, status: 'active' }]; } },
    Clinica: { findAll: async () => [{ id_clinica: 59 }, { id_clinica: 19 }] },
    ExternalCampaignAssignment: { findAll: async () => [{ provider: 'google_ads', customer_id: account.customerId, campaign_id: '456', clinica_id: 59, status: 'active' }] },
    GoogleAdsInsightsDaily: {
      findOne: async () => null,
      destroy: async options => { assert.equal(options.transaction, tx); writes.push({ type: 'delete', options }); },
      bulkCreate: async (rows, options) => { assert.equal(options.transaction, tx); writes.push({ type: 'insert', rows }); },
    },
  };
  return { models, writes };
}

test('complete collection reconciles Search groups, retains PMax totals and explicitly covers zero days', async () => {
  const f = source(); const snapshot = await collectGoogleCampaignMetrics(f.args);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => call.customerId === account.customerId && call.apiVersion === 'v24' && /^SELECT /.test(call.query)));
  assert.ok(f.calls.filter(call => /metrics\./.test(call.query)).every(call => /metrics.cost_micros/.test(call.query) && /REMOVED/.test(call.query)));
  assert.equal(snapshot.rows.length, 4);
  assert.equal(snapshot.rows.reduce((sum, row) => sum + row.costMicros, 0), 3000000);
  assert.equal(snapshot.rows.find(row => row.campaignId === '456' && row.date === '2026-09-10').adGroupId, '800');
  assert.equal(snapshot.rows.find(row => row.campaignId === '457' && row.date === '2026-09-10').adGroupId, '');
  assert.equal(snapshot.rows.filter(row => row.date === '2026-09-09').every(row => row.costMicros === 0), true);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
});

test('all conversions and their values survive the scheduled metrics path without being confused with primary conversions', async () => {
  const f = source();
  for (const row of [f.data.campaigns[0], f.data.groups[0]]) {
    Object.assign(row.metrics, { allConversions: '2.5', allConversionsValue: '240.5', conversionsValue: '30.5' });
  }
  const snapshot = await collectGoogleCampaignMetrics(f.args); const d = database();
  await persistGoogleCampaignMetrics({ models: d.models, account, snapshot, now });
  const saved = d.writes[1].rows.find(row => row.adGroupId === '800');
  assert.equal(saved.allConversions, 2.5); assert.equal(saved.allConversionsValue, 240.5);
  assert.equal(saved.conversions, 0.5); assert.equal(saved.conversionsValue, 30.5);
  assert.ok(f.calls.filter(row => /metrics\./.test(row.query)).every(row => row.query.includes('metrics.all_conversions_value')));
});

test('paginated reader errors, duplicate rows and inconsistent totals never become partial snapshots', async () => {
  const f = source(); f.args.read = async () => { throw Error('GOOGLE_ADS_SEARCH_INCOMPLETE'); };
  await assert.rejects(collectGoogleCampaignMetrics(f.args), /INCOMPLETE/);
  for (const kind of ['costMicros', 'clicks', 'impressions', 'conversions', 'interactions']) {
    const f = source(); f.data.groups[0].metrics[kind] = '999';
    await assert.rejects(collectGoogleCampaignMetrics(f.args), /unreconciled/);
  }
  const duplicate = source(); duplicate.data.campaigns.push(duplicate.data.campaigns[0]);
  await assert.rejects(collectGoogleCampaignMetrics(duplicate.args), /duplicate_metrics/);
  const orphan = source(); orphan.data.campaigns = [];
  await assert.rejects(collectGoogleCampaignMetrics(orphan.args), /unreconciled/);
});

test('invalid scope, dates, inventory changes, metadata and segment omissions fail closed', async () => {
  for (const mutate of [
    f => { f.data.metadata[0].customer.id = '9999999999'; },
    f => { f.data.metadata[0].customer.manager = true; },
    f => { f.data.metadata[0].customer.timeZone = 'invalid'; },
    f => { f.data.inventory[0].customer.id = '9999999999'; },
    f => { f.data.inventory.push(f.data.inventory[0]); },
    f => { f.data.inventory = []; },
    f => { f.data.groups[0].campaign.status = 'PAUSED'; },
    f => { f.data.campaigns[0].campaign.id = '999'; },
    f => { f.data.campaigns[0].segments.date = '2026-09-08'; },
    f => { delete f.data.campaigns[0].segments.device; },
    f => { f.data.groups[0].adGroup.id = '1 OR 1'; },
    f => { f.data.campaigns[0].metrics.costMicros = Number.MAX_SAFE_INTEGER + 1; },
    f => { f.data.campaigns[0].metrics.costMicros = 'NaN'; },
    f => { f.args.end = '2026-09-12'; },
    f => { f.args.start = '2026-01-01'; },
    f => { f.args.account = { ...account, isActive: false }; },
  ]) {
    const f = source(); mutate(f);
    await assert.rejects(collectGoogleCampaignMetrics(f.args), /google_campaign_cache_|google_ad_cache_/);
  }
});

test('a complete empty metrics response preserves inventory coverage, not a provider failure', async () => {
  const f = source(); f.data.campaigns = []; f.data.groups = [];
  const snapshot = await collectGoogleCampaignMetrics(f.args);
  assert.equal(snapshot.rows.length, 4); assert.ok(snapshot.rows.every(row => row.costMicros === 0 && row.adGroupId === ''));
});

test('a genuinely empty account can complete without inventing campaigns or metric rows', async () => {
  const f = source(); f.data.inventory = []; f.data.campaigns = []; f.data.groups = [];
  const snapshot = await collectGoogleCampaignMetrics(f.args);
  assert.equal(snapshot.rows.length, 0); assert.equal(snapshot.inventory.length, 0);
  const d = database(); const result = await persistGoogleCampaignMetrics({ models: d.models, account, snapshot, now });
  assert.equal(result.skipped, false); assert.equal(result.rows, 0); assert.equal(d.writes[0].type, 'delete');
  assert.equal(d.writes.length, 1);
});

function automaticDatabase() {
  const f = database(); f.issues = []; f.resolved = []; f.group = { id_grupo: 5, ads_assignment_mode: 'automatic', ads_assignment_delimiter: '**' };
  f.models.GrupoClinica = { findByPk: async (id, options) => { assert.equal(id, 5); assert.equal(options.lock, 'UPDATE'); return f.group; } };
  f.models.Clinica.findAll = async () => [{ id_clinica: 59, nombre_clinica: 'Sede A', grupoClinicaId: 5 }, { id_clinica: 19, nombre_clinica: 'Sede B', grupoClinicaId: 5 }];
  f.models.AdAttributionIssue = { findOrCreate: async options => { assert.ok(options.transaction); f.issues.push(options); return [{}, true]; },
    update: async (patch, options) => { assert.ok(options.transaction); f.resolved.push({ patch, options }); } };
  return f;
}

test('scheduled metrics preserve reviewed and archived decisions ahead of automatic matching', async () => {
  const f = source(); f.data.inventory[0].campaign.name = '**Sede B**'; f.data.groups[0].adGroup.name = '**Sede B**';
  const snapshot = await collectGoogleCampaignMetrics(f.args);
  for (const status of ['active', 'archived']) {
    const d = automaticDatabase(); d.models.ExternalCampaignAssignment.findAll = async () => [{ campaign_id: '456', clinica_id: 59, status, match_kind: 'manual' }];
    await persistGoogleCampaignMetrics({ models: d.models, account, snapshot, now, useGroupAttribution: true });
    const rows = d.writes[1].rows.filter(row => row.campaignId === '456');
    assert.ok(rows.every(row => row.clinicaId === (status === 'active' ? 59 : null)));
    assert.ok(rows.every(row => row.clinicMatchSource === (status === 'active' ? 'reviewed_campaign' : 'reviewed_campaign_archived')));
    assert.equal(d.resolved.filter(row => row.options.where.entity_id === '456').length, status === 'active' ? 1 : 0);
  }
});

test('automatic attribution retains explicit name delimiters, group precedence and scoped issue records', async () => {
  const f = source(); f.data.inventory[0].campaign.name = '**Sede B**'; f.data.groups[0].adGroup.name = '**Sede A**';
  f.data.inventory[1].campaign.name = '**Sede desconocida**';
  const snapshot = await collectGoogleCampaignMetrics(f.args); const d = automaticDatabase();
  d.models.ExternalCampaignAssignment.findAll = async () => [];
  await persistGoogleCampaignMetrics({ models: d.models, account, snapshot, now, useGroupAttribution: true });
  const rows = d.writes[1].rows;
  assert.equal(rows.find(row => row.adGroupId === '800').clinicaId, 59);
  assert.equal(rows.find(row => row.campaignId === '456' && row.adGroupId === '').clinicaId, 19);
  assert.ok(rows.filter(row => row.campaignId === '457').every(row => row.clinicaId === null));
  assert.equal(d.issues.length, 1); assert.equal(d.issues[0].where.customer_id, account.customerId);
  assert.equal(d.issues[0].defaults.grupo_clinica_id, 5);
  assert.ok(d.resolved.every(row => row.options.where.customer_id === account.customerId));
});

test('manual groups and operator metric-only repair never enable automatic clinic matching', async () => {
  const f = source(); f.data.inventory[0].campaign.name = '**Sede B**';
  const snapshot = await collectGoogleCampaignMetrics(f.args);
  for (const useGroupAttribution of [false, true]) {
    const d = automaticDatabase(); if (useGroupAttribution) d.group.ads_assignment_mode = 'manual';
    d.models.ExternalCampaignAssignment.findAll = async () => [];
    await persistGoogleCampaignMetrics({ models: d.models, account, snapshot, now, useGroupAttribution });
    assert.ok(d.writes[1].rows.every(row => row.clinicaId === null)); assert.equal(d.issues.length, 0); assert.equal(d.resolved.length, 0);
  }
});

test('collection timeouts and Madrid midnight prevent saving a mixed observation', async () => {
  const f = source(); let time = +now; f.args.clock = () => time;
  const read = f.args.read; f.args.read = async options => { const rows = await read(options); time += 30000; return rows; };
  await assert.rejects(collectGoogleCampaignMetrics(f.args), /timeout/);
  const midnight = source(); let count = 0;
  midnight.args.now = () => new Date(++count > 2 ? '2026-09-12T22:00:01Z' : '2026-09-12T21:59:59Z');
  await assert.rejects(collectGoogleCampaignMetrics(midnight.args), /incomplete/);
});

test('writer locks owners and replaces only that account/window without inventory, OAuth or ad writer dependencies', async () => {
  const snapshot = await collectGoogleCampaignMetrics(source().args); const f = database();
  const result = await persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now });
  assert.equal(result.rows, 4); assert.equal(f.writes.length, 2);
  assert.deepEqual(f.writes[0].options.where.customerId[Op.in], ['1234567890', '123-456-7890']);
  assert.deepEqual(f.writes[0].options.where.date[Op.between], [snapshot.start, snapshot.end]);
  const rows = f.writes[1].rows;
  assert.equal(rows.find(row => row.campaignId === '456' && row.clicks > 0).averageCpcMicros, 500000);
  assert.equal(rows.filter(row => row.campaignId === '456').every(row => row.clinicaId === 59), true);
  assert.equal(rows.filter(row => row.campaignId === '457').every(row => row.clinicaId === null), true);
});

test('revoked/changed ownership, another group, expired snapshots and payload edits cannot replace cache', async () => {
  const snapshot = await collectGoogleCampaignMetrics(source().args);
  for (const patch of [{ isActive: false }, { googleConnectionId: 99 }, { grupoClinicaId: 9 }, { assignmentScope: 'clinic' }]) {
    const f = database(); f.models.ClinicGoogleAdsAccount.findAll = async () => [{ ...account, ...patch }];
    await assert.rejects(persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now }), /google_campaign_cache_/);
    assert.equal(f.writes.length, 0);
  }
  const f = database();
  f.models.ClinicGoogleAdsAccount.findAll = async () => [account, { ...account, id: 12, grupoClinicaId: 9 }];
  await assert.rejects(persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now }), /shared_outside_scope/);
  await assert.rejects(persistGoogleCampaignMetrics({ models: f.models, account, snapshot: { ...snapshot, rows: [] }, now }), /invalid_snapshot/);
  await assert.rejects(persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now: new Date(+now + 300001) }), /invalid_snapshot/);
  assert.equal(f.writes.length, 0);
});

test('newer or equal cache prevents an older response from erasing it', async () => {
  const snapshot = await collectGoogleCampaignMetrics(source().args);
  for (const date of [now, new Date(+now + 1000)]) {
    const f = database(); f.models.GoogleAdsInsightsDaily.findOne = async () => ({ updated_at: date });
    const result = await persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now });
    assert.equal(result.reason, 'newer_snapshot'); assert.equal(f.writes.length, 0);
  }
});

test('revoked grants, out-of-scope assignments and backup errors leave the cache untouched', async () => {
  const snapshot = await collectGoogleCampaignMetrics(source().args);
  for (const grants of [[], [{ googleConnectionId: 2, status: 'revoked' }], [{ googleConnectionId: 3, status: 'active' }]]) {
    const f = database(); f.models.GoogleConnectionAssignment.findAll = async () => grants;
    await assert.rejects(persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now }), /grant_changed/);
    assert.equal(f.writes.length, 0);
  }
  const f = database(); f.models.Clinica.findAll = async () => [{ id_clinica: 99 }];
  await assert.rejects(persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now }), /assignment_outside_scope/);
  assert.equal(f.writes.length, 0);
  const backup = database();
  await assert.rejects(persistGoogleCampaignMetrics({ models: backup.models, account, snapshot, now,
    beforeReplace: async () => { throw Error('backup_failed'); } }), /backup_failed/);
  assert.equal(backup.writes.length, 0);
  const expired = database(); let time = now;
  await assert.rejects(persistGoogleCampaignMetrics({ models: expired.models, account, snapshot, now: () => time,
    beforeReplace: async () => { time = new Date(+now + 300001); } }), /invalid_snapshot/);
  assert.equal(expired.writes.length, 0);
});

test('shared group mappings use one owner and respect archive/ambiguous assignment decisions', async () => {
  const snapshot = await collectGoogleCampaignMetrics(source().args); const f = database();
  f.models.ClinicGoogleAdsAccount.findAll = async () => [account, { ...account, id: 20, assignmentScope: 'clinic', clinicaId: 59 }];
  f.models.ExternalCampaignAssignment.findAll = async () => [
    { campaign_id: '456', clinica_id: 59, status: 'archived' },
    { campaign_id: '457', clinica_id: 59, status: 'active' }, { campaign_id: '457', clinica_id: 19, status: 'active' },
  ];
  await persistGoogleCampaignMetrics({ models: f.models, account, snapshot, now });
  assert.ok(f.writes[1].rows.every(row => row.clinicaId === null));
});
