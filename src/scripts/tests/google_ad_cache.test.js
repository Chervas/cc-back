'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { buildAdQuery, normalizeAd, daysBetween, readAdPages, syncGoogleAdCache, persistAdSnapshot } = require('../../services/googleAdCache.service');
const { loadGoogleWorkspaceAds } = require('../../services/googleAdWorkspaceRead.service');
const account = { id: 1, customerId: '123-456-7890', isActive: true, assignmentScope: 'clinic', clinicaId: 1, googleConnectionId: 2 };
const observedAt = new Date('2026-09-11T02:00:00.123Z');
function providerRow(groupId = '800') {
  return { customer: { id: '1234567890' }, campaign: { id: '456', name: 'Campana', status: 'ENABLED' }, adGroup: { id: groupId, name: 'Grupo', status: 'ENABLED' },
    adGroupAd: { status: 'ENABLED', ad: { id: '700', name: 'Anuncio', type: 'RESPONSIVE_SEARCH_AD',
      finalUrls: ['https://www.example.com/cita'], responsiveSearchAd: { headlines: [{ text: 'Primera visita' }], descriptions: [{ text: 'Solicita cita' }] } } },
    segments: { date: '2026-09-10', device: 'MOBILE', adNetworkType: 'SEARCH' }, metrics: { costMicros: '2500000', impressions: '4', clicks: '1' } };
}
function fixture() {
  const calls = []; const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    sequelize: { transaction: async fn => { calls.push('transaction'); return fn(tx); } },
    ClinicGoogleAdsAccount: { findByPk: async (_id, opts) => { assert.equal(opts.lock, 'UPDATE'); return account; } },
    GoogleConnectionAssignment: { findAll: async opts => { assert.equal(opts.transaction, tx); assert.equal(opts.lock, 'UPDATE'); return [{ googleConnectionId: 2, status: 'active' }]; } },
    Clinica: { findAll: async opts => { assert.equal(opts.transaction, tx); assert.equal(opts.lock, 'UPDATE'); return [{ id_clinica: 1, grupoClinicaId: null }]; } },
    ExternalCampaignAssignment: { findAll: async () => [] },
    GoogleAdsAdSyncDay: { findAll: async () => [], bulkCreate: async (rows, opts) => { assert.equal(opts.transaction, tx); calls.push(['coverage', rows]); } },
    GoogleAdsAdInventory: { findOne: async () => null, update: async () => calls.push('inventoryMissing'), bulkCreate: async rows => calls.push(['inventory', rows]) },
    GoogleAdsAdInsightsDaily: { destroy: async opts => calls.push(['delete', opts]), bulkCreate: async rows => calls.push(['metrics', rows]) },
  };
  const args = { models, account, inventoryRows: [providerRow()], metricRows: [providerRow()], start: '2026-09-09', end: '2026-09-10', observedAt };
  return { models, calls, args };
}

test('inventory query has no segments or metrics, includes paused/removed ads, and metrics use exact date scope', () => {
  const inventory = buildAdQuery({ inventory: true });
  assert.ok(!/segments\.|metrics\./.test(inventory)); assert.match(inventory, /REMOVED/);
  assert.match(buildAdQuery({ start: '2026-09-01', end: '2026-09-10', campaignId: '456' }), /campaign.id = 456/);
  for (const campaignId of ['1 OR 1=1', '0', '0700', '', '../id']) assert.throws(() => buildAdQuery({ inventory: true, campaignId }));
  for (const [start, end] of [['2026-02-30', '2026-03-01'], ['2026-01-01', '2025-12-31'], ['2020-01-01', '2026-01-01']]) assert.throws(() => daysBetween(start, end));
});

test('normalization preserves exact group/ad identity and real creative content', () => {
  const value = normalizeAd(providerRow(), account);
  assert.equal(value.customerId, '1234567890'); assert.equal(value.adGroupId, '800'); assert.equal(value.adId, '700');
  assert.deepEqual(value.headlines, ['Primera visita']); assert.equal(value.displayUrl, 'www.example.com/cita');
  assert.throws(() => normalizeAd(providerRow(), account, '999'), /scope_mismatch/);
  assert.throws(() => normalizeAd({ ...providerRow(), customer: { id: '999' } }, account), /scope_mismatch/);
  const missing = providerRow(); delete missing.adGroup.id;
  assert.throws(() => normalizeAd(missing, account), /invalid_id/);
});

test('all pages are read using the shared client without provider mutations', async () => {
  const calls = [];
  const rows = await readAdPages({ account, accessToken: 'private', loginCustomerId: '123', query: 'SELECT ad_group_ad.ad.id FROM ad_group_ad',
    request: async (method, path, options) => { calls.push(options); assert.equal(method, 'POST'); assert.match(path, /googleAds:search$/);
      return calls.length === 1 ? { results: [providerRow()], nextPageToken: 'next' } : { results: [providerRow('801')] }; } });
  assert.equal(rows.length, 2); assert.equal(calls[1].data.pageToken, 'next');
  assert.equal(calls[0].loginCustomerId, '123');
});

test('malformed and repeated pagination fails instead of treating a partial response as complete', async () => {
  for (const response of [null, [], { results: 'bad' }, { error: { code: 500 } }, { partialFailureError: { code: 3 } },
    { nextPageToken: 1 }, { nextPageToken: 'loop' }]) {
    await assert.rejects(readAdPages({ account, query: 'SELECT', request: async () => response }), /google_ad_cache_/);
  }
  assert.deepEqual(await readAdPages({ account, query: 'SELECT', request: async () => ({}) }), []);
});

test('a later page/quota failure preserves all cached rows and coverage', async () => {
  const f = fixture(); let count = 0;
  await assert.rejects(syncGoogleAdCache({ ...f.args, request: async () => {
    count++; if (count === 1) return { results: [providerRow()] };
    if (count === 2) return { results: [providerRow()], nextPageToken: 'next' };
    throw Object.assign(new Error('quota'), { code: 'GOOGLE_ADS_PAUSED' });
  } }), { code: 'GOOGLE_ADS_PAUSED' });
  assert.deepEqual(f.calls, []);
});

test('nightly refresh bootstraps both 30-day periods only when account-wide coverage is missing', async () => {
  for (const filled of [false, true]) {
    const f = fixture(); const queries = [];
    f.models.GoogleAdsAdSyncDay.findAll = async options => options.attributes && filled
      ? daysBetween('2026-07-13', '2026-09-10').map(date => ({ date })) : [];
    const result = await syncGoogleAdCache({ ...f.args, start: '2026-09-04', ensureHistory: true, now: () => observedAt,
      request: async (_method, _path, options) => { queries.push(options.data.query); return {}; } });
    assert.equal(result.days, filled ? 7 : 60);
    assert.equal(queries.length, filled ? 2 : 10);
    assert.match(queries[1], filled ? /2026-09-04/ : /2026-07-13/);
  }
});

test('complete snapshot preserves creatives and clinic ownership without generating assignments', async () => {
  const f = fixture(); const metric = providerRow(); delete metric.adGroupAd.ad.responsiveSearchAd;
  f.args.metricRows = [metric];
  const result = await persistAdSnapshot(f.args); assert.equal(result.metricRows, 1); assert.equal(result.days, 2);
  const rows = f.calls.find(row => row[0] === 'metrics')[1];
  assert.equal(rows[0].clinicaId, 1); assert.equal(rows[0].costMicros, 2500000); assert.equal(rows[0].observedAt, observedAt);
  assert.deepEqual(rows[0].headlines, ['Primera visita']);
  assert.deepEqual(f.calls.find(row => row[0] === 'coverage')[1].map(row => row.date), ['2026-09-09', '2026-09-10']);
});

test('complete empty window clears stale metrics and records successful zero-activity dates', async () => {
  const f = fixture(); f.args.metricRows = []; f.args.inventoryRows = [];
  const result = await persistAdSnapshot(f.args); assert.equal(result.metricRows, 0);
  assert.equal(f.calls.filter(row => row[0] === 'delete').length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'coverage').length, 1);
  assert.equal(f.calls.filter(row => row[0] === 'metrics').length, 0);
});

test('invalid identities, duplicate segments, out-of-window dates and invalid metrics never open a write transaction', async () => {
  for (const mutate of [f => f.args.metricRows.push(providerRow()), f => f.args.inventoryRows.push(providerRow()),
    f => { f.args.metricRows[0].segments.date = '2026-08-01'; }, f => { f.args.metricRows[0].metrics.costMicros = 'bad'; },
    f => { f.args.metricRows[0].metrics.clicks = false; }, f => { f.args.metricRows[0].adGroup.id = null; }]) {
    const f = fixture(); mutate(f); await assert.rejects(persistAdSnapshot(f.args), /google_ad_cache_/); assert.deepEqual(f.calls, []);
  }
});

test('campaign refresh does not clear other campaigns, reviewed archive overrides account clinic', async () => {
  const f = fixture(); f.args.campaignId = '456';
  f.models.ExternalCampaignAssignment.findAll = async () => [{ campaign_id: '456', status: 'archived', clinica_id: 1 }];
  await persistAdSnapshot(f.args);
  assert.equal(f.calls.find(row => row[0] === 'delete')[1].where.campaignId, '456');
  assert.equal(f.calls.find(row => row[0] === 'metrics')[1][0].clinicaId, null);
  assert.equal(f.calls.find(row => row[0] === 'coverage')[1][0].campaignId, '456');
});

test('revoked mappings and newer observations fence stale refreshes', async () => {
  for (const change of [{ isActive: false }, { customerId: '999' }, { googleConnectionId: 99 },
    { assignmentScope: 'group' }, { clinicaId: 2 }, { grupoClinicaId: 9 }]) {
    const f = fixture(); f.models.ClinicGoogleAdsAccount.findByPk = async () => ({ ...account, ...change });
    await assert.rejects(persistAdSnapshot(f.args), /account_changed/); assert.deepEqual(f.calls, ['transaction']);
  }
  const f = fixture(); f.models.GoogleAdsAdSyncDay.findAll = async () => [{ observedAt: '2026-09-11T02:00:01Z' }];
  assert.equal((await persistAdSnapshot(f.args)).reason, 'newer_snapshot'); assert.deepEqual(f.calls, ['transaction']);
});

test('missing, revoked, ambiguous and replaced grants cannot change inventory, metrics or coverage', async () => {
  for (const grants of [[], [{ googleConnectionId: 2, status: 'revoked' }], [{ googleConnectionId: 2, status: 'disconnected' }],
    [{ googleConnectionId: 2, status: 'reauthorization_required' }], [{ googleConnectionId: 3, status: 'active' }],
    [{ googleConnectionId: 2, status: 'active' }, { googleConnectionId: 2, status: 'active' }]]) {
    const f = fixture(); f.models.GoogleConnectionAssignment.findAll = async () => grants;
    await assert.rejects(persistAdSnapshot(f.args), /grant_changed/);
    assert.deepEqual(f.calls, ['transaction']);
  }
});

test('clinic inheritance needs an absent direct grant and unchanged group membership', async () => {
  const f = fixture(); f.args.account = { ...account, grupoClinicaId: 5 };
  f.models.ClinicGoogleAdsAccount.findByPk = async () => f.args.account;
  f.models.Clinica.findAll = async () => [{ id_clinica: 1, grupoClinicaId: 5 }];
  const queries = [];
  f.models.GoogleConnectionAssignment.findAll = async options => {
    queries.push(options.where); return options.where.assignmentScope === 'group' ? [{ googleConnectionId: 2, status: 'active' }] : [];
  };
  await persistAdSnapshot(f.args); assert.equal(queries.length, 2); assert.equal(queries[1].grupoClinicaId, 5);
  f.calls.length = 0; queries.length = 0;
  f.models.GoogleConnectionAssignment.findAll = async options => {
    queries.push(options.where); return [{ googleConnectionId: 2, status: options.where.assignmentScope === 'clinic' ? 'revoked' : 'active' }];
  };
  await assert.rejects(persistAdSnapshot(f.args), /grant_changed/); assert.equal(queries.length, 1); assert.deepEqual(f.calls, ['transaction']);
  f.models.GoogleConnectionAssignment.findAll = async () => [{ googleConnectionId: 2, status: 'active' }];
  f.models.Clinica.findAll = async () => [{ id_clinica: 1, grupoClinicaId: 9 }];
  await assert.rejects(persistAdSnapshot(f.args), /assignment_outside_scope/); assert.deepEqual(f.calls, ['transaction', 'transaction']);
});

test('out-of-scope clinic assignments cannot be persisted and reviewed archives still take precedence', async () => {
  for (const clinics of [[], [{ id_clinica: 1, grupoClinicaId: null }]]) {
    const f = fixture(); f.models.Clinica.findAll = async () => clinics;
    f.models.ExternalCampaignAssignment.findAll = async options => {
      assert.equal(options.lock, 'UPDATE'); assert.deepEqual(options.where.customer_id[Op.in], ['1234567890', '123-456-7890']);
      return [{ campaign_id: '456', status: 'active', clinica_id: 2 }];
    };
    await assert.rejects(persistAdSnapshot(f.args), /assignment_outside_scope/); assert.deepEqual(f.calls, ['transaction']);
  }
});

test('a scoped backup hook runs under the lock before any change and a failure aborts the refresh', async () => {
  const f = fixture(); f.args.campaignId = '456';
  const backup = async ({ transaction, inventoryWhere, metricWhere, coverageWhere }) => {
    assert.equal(transaction.LOCK.UPDATE, 'UPDATE'); assert.deepEqual(f.calls, ['transaction']);
    for (const where of [inventoryWhere, metricWhere, coverageWhere]) {
      assert.equal(where.clinicGoogleAdsAccountId, 1); assert.equal(where.customerId, '1234567890'); assert.equal(where.campaignId, '456');
    }
    assert.deepEqual(metricWhere.date[Op.in], ['2026-09-09', '2026-09-10']);
    assert.deepEqual(coverageWhere.date[Op.in], ['2026-09-09', '2026-09-10']);
    throw Error('backup_failed');
  };
  await assert.rejects(persistAdSnapshot({ ...f.args, beforeReplace: backup }), /backup_failed/);
  assert.deepEqual(f.calls, ['transaction']);
});

test('group accounts retain reviewed clinic attribution and do not apply the representative clinic to every ad', async () => {
  const f = fixture(); f.args.account = { ...account, assignmentScope: 'group', grupoClinicaId: 5 };
  f.models.ClinicGoogleAdsAccount.findByPk = async () => f.args.account;
  f.models.GoogleConnectionAssignment.findAll = async options => {
    assert.deepEqual(options.where, { assignmentScope: 'group', grupoClinicaId: 5 });
    return [{ googleConnectionId: 2, status: 'active' }];
  };
  f.models.Clinica.findAll = async options => {
    assert.deepEqual(options.where, { grupoClinicaId: 5 }); return [{ id_clinica: 1, grupoClinicaId: 5 }, { id_clinica: 2, grupoClinicaId: 5 }];
  };
  f.models.ExternalCampaignAssignment.findAll = async () => [{ campaign_id: '456', status: 'active', clinica_id: 2 }];
  await persistAdSnapshot(f.args);
  assert.equal(f.calls.find(row => row[0] === 'metrics')[1][0].clinicaId, 2);
});

test('backup query customization cannot change the writer account or date window', async () => {
  const f = fixture();
  await persistAdSnapshot({ ...f.args, beforeReplace: async ({ inventoryWhere, metricWhere, coverageWhere }) => {
    inventoryWhere.customerId = '9999999999'; metricWhere.customerId = '9999999999';
    metricWhere.date[Op.in].push('2020-01-01'); coverageWhere.date[Op.in].push('2020-01-02');
  } });
  const deletion = f.calls.find(row => row[0] === 'delete')[1].where;
  assert.equal(deletion.customerId, '1234567890'); assert.deepEqual(deletion.date[Op.in], ['2026-09-09', '2026-09-10']);
  assert.equal(f.calls.find(row => row[0] === 'coverage')[1].length, 2);
  assert.equal(f.calls.find(row => row[0] === 'metrics')[1][0].customerId, '1234567890');
});

test('an explicitly authorized clinic mapping does not need to inherit its group', async () => {
  const f = fixture(); let grantQueries = 0;
  f.models.GoogleConnectionAssignment.findAll = async () => { grantQueries++; return [{ googleConnectionId: 2, status: 'active' }]; };
  f.models.Clinica.findAll = async () => [{ id_clinica: 1, grupoClinicaId: 5 }];
  await persistAdSnapshot(f.args); assert.equal(grantQueries, 1);
  assert.equal(f.calls.find(row => row[0] === 'metrics')[1][0].clinicaId, 1);
});

function readFixture() {
  const inventory = [{ ...normalizeAd(providerRow(), account), present: true, observedAt }];
  const coverage = []; const rows = [];
  const models = { GoogleAdsAdInventory: { findAll: async () => inventory }, GoogleAdsAdSyncDay: { findAll: async () => coverage },
    GoogleAdsAdInsightsDaily: { findAll: async () => rows } };
  const args = { models, googleWhere: [{ customerId: '1234567890', campaignId: '456' }], dateWhere: { [Op.between]: ['2026-09-09', '2026-09-10'] } };
  return { inventory, coverage, rows, args };
}
test('fresh inventory without any complete metric query is not zero-activity evidence', async () => {
  const f = readFixture(); const ads = await loadGoogleWorkspaceAds(f.args);
  assert.equal(ads.length, 1); assert.equal(ads[0].inventory, true); assert.equal(ads[0].spend, undefined);
});
test('unnamed search ads use their real first headline, never a simulated creative', async () => {
  const f = readFixture(); f.inventory[0].adName = null;
  assert.equal((await loadGoogleWorkspaceAds(f.args))[0].title, 'Primera visita');
});
test('effective ad status includes paused and removed parents, without changing stored provider state', async () => {
  for (const patch of [{ campaignStatus: 'PAUSED' }, { adGroupStatus: 'PAUSED' }, { campaignStatus: 'REMOVED' }, { adGroupStatus: 'REMOVED' }]) {
    const f = readFixture(); Object.assign(f.inventory[0], patch);
    const ads = await loadGoogleWorkspaceAds(f.args);
    assert.equal(ads[0].status, Object.values(patch)[0]); assert.equal(f.inventory[0].adStatus, 'ENABLED');
  }
});
test('only checked dates become zero metrics; current inventory never refreshes old metrics', async () => {
  const f = readFixture(); f.coverage.push({ customerId: '1234567890', campaignId: '', date: '2026-09-10', observedAt });
  f.rows.push({ ...f.inventory[0], date: '2026-09-09', observedAt: null, costMicros: 2500000, updated_at: '2026-09-01' });
  const ads = await loadGoogleWorkspaceAds(f.args);
  assert.equal(ads.length, 3); assert.equal(ads[1].spend, 2.5); assert.equal(ads[1].metricsUpdatedAt, '2026-09-01');
  assert.equal(ads[2].spend, 0); assert.equal(ads[2].metricsUpdatedAt, observedAt); assert.equal(ads[2].date, '2026-09-10');
});
test('new complete zero query supersedes obsolete metrics from another mapping of the same account', async () => {
  const f = readFixture(); f.coverage.push({ customerId: '1234567890', campaignId: '', date: '2026-09-10', observedAt });
  f.rows.push({ ...f.inventory[0], date: '2026-09-10', observedAt: null, costMicros: 2500000, updated_at: '2026-09-01' });
  const ads = await loadGoogleWorkspaceAds(f.args); assert.equal(ads.length, 2); assert.equal(ads[1].spend, 0);
});
test('campaign-specific date coverage cannot leak to another campaign in an aggregate', async () => {
  const f = readFixture(); f.args.googleWhere.push({ customerId: '1234567890', campaignId: '457' });
  f.inventory.push({ ...f.inventory[0], campaignId: '457' });
  f.coverage.push({ customerId: '1234567890', campaignId: '456', date: '2026-09-10', observedAt });
  const ads = await loadGoogleWorkspaceAds(f.args); assert.equal(ads.length, 3);
  assert.equal(ads.filter(ad => !ad.inventory && ad.campaign_id === '457').length, 0);
});

test('a more recent paused campaign prevents old enabled ad metadata from appearing active', async () => {
  const f = readFixture();
  f.inventory[0].deliveryObservation = { schemaVersion: 1, observedAt: observedAt.toISOString(),
    primaryStatus: 'ELIGIBLE', approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED', primaryStatusReasons: [] };
  const ads = await loadGoogleWorkspaceAds(f.args);
  const { aggregateReport, reportPeriod } = require('../../services/campaignWorkspaceReport.service');
  const { externalCampaignIdentityKey } = require('../../services/externalCampaignAssignmentTargets.service');
  const campaign = { provider: 'google_ads', account_id: '1234567890', campaign_id: '456', paused: true, assigned: true,
    clinicId: 1, currency: 'EUR' };
  campaign.id = externalCampaignIdentityKey(campaign);
  const report = aggregateReport({ campaigns: [campaign], ads, period: reportPeriod(30, observedAt), now: observedAt });
  assert.equal(report.rows[0].ads[0].status, 'PAUSED'); assert.equal(report.rows[0].ads[0].active, false);
  assert.equal(report.rows[0].ads[0].current.spend, null, 'inventory without metrics is still unknown');
});
