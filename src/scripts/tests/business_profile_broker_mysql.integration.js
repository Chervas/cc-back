'use strict';
const assert = require('node:assert/strict'); const { randomBytes } = require('node:crypto');
const { DataTypes: D } = require('sequelize'); const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  for (const [name, key] of [['Clinicas', 'id_clinica'], ['GoogleConnections', 'id'], ['ClinicMetaAssets', 'id']]) {
    await qi.createTable(name, { [key]: { type: D.INTEGER, primaryKey: true } });
  }
  await sql.query('INSERT INTO Clinicas VALUES (71), (72)'); await sql.query('INSERT INTO GoogleConnections VALUES (81)');
  await require('../../../migrations/20250915103000-create-clinicbusinesslocations').up(qi, require('sequelize'));
  const migration = require('../../../migrations/20260913000000-add-business-profile-broker-read-binding');
  await migration.up(qi);
  models.BusinessProfileBrokerBinding = require('../../../models/businessprofilebrokerbinding')(sql, D);
  models.ClinicBusinessLocation = require('../../../models/clinicbusinesslocation')(sql, D);
  models.BusinessProfileDailyMetric = require('../../../models/businessprofiledailymetric')(sql, D);
  await require('../../../migrations/20250915103100-create-businessprofiledailymetrics').up(qi, require('sequelize'));
  await require('../../../migrations/20260715151000-dedupe-business-profile-daily-metrics').up(qi, require('sequelize'));
  for (const [name, file] of [['BusinessProfileReview', 'businessprofilereview'], ['BusinessProfilePost', 'businessprofilepost'], ['SyncLog', 'synclog']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  const location = await models.ClinicBusinessLocation.create({ id: 51, clinica_id: 71, google_connection_id: 81, location_id: 'locations/456', raw_payload: { keepExisting: 'FICTITIOUS_EXISTING' } });
  assert.equal(location.broker_read_connection_ref, null);
  await assert.rejects(location.update({ broker_read_connection_ref: 'connection:test' })); await location.reload();
  assert.equal(location.broker_read_connection_ref, null);
  await location.update({ broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:456' });
  await models.BusinessProfileBrokerBinding.create({ external_location_id: '456', connection_ref: 'connection:test', asset_ref: 'gbp:123:456', clinica_id: 71, google_connection_id: 81 });
  await assert.rejects(migration.down(qi), /Managed GBP bindings/);
  report.checks.push('Additive migration defaults to legacy, rejects half binding, blocks rollback with managed rows');
  let enabled = true; let providerCalls = 0; let tokenReads = 0; let legacyCalls = 0; let mode = 'complete'; const matching = []; const logs = [];
  const parent = 'accounts/123/locations/456';
  const contract = require('../../../services/integrations-broker/src/google-business-profile-contract');
  const { createGoogleBusinessProfileOperations } = require('../../../services/integrations-broker/src/google-business-profile');
  const { cursorCodec } = require('../../../services/integrations-broker/src/provider-cursor');
  const operations = createGoogleBusinessProfileOperations({ cursor: cursorCodec(randomBytes(32)), http: async request => {
    providerCalls++; assert.equal(request.token.toString(), 'FICTITIOUS_ACCESS_SENTINEL');
    const path = new URL('https://' + request.hostname + request.path);
    if (path.pathname.includes('fetchMultiDailyMetrics')) return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [
      { date: { year: 2026, month: 9, day: 1 }, value: '0' }, { date: { year: 2026, month: 9, day: 2 } }] } }] }] };
    if (path.pathname.endsWith('/reviews')) {
      const next = path.searchParams.has('pageToken'); if (mode === 'failed-page' && next) throw Error('FICTITIOUS_PROVIDER_FAILURE');
      const reviewId = next ? 'review-second' : 'review-first';
      return { reviews: [{ reviewId, reviewer: { displayName: 'FICTITIOUS_REVIEWER' }, starRating: 'FIVE', comment: 'FICTITIOUS_PUBLIC_REVIEW', updateTime: '2026-09-12T12:00:00.000Z' }], totalReviewCount: 2,
        nextPageToken: next ? undefined : 'FICTITIOUS_RAW_PAGE' };
    }
    if (path.pathname.endsWith('/localPosts')) return { localPosts: [{ name: parent + '/localPosts/post-one', summary: 'FICTITIOUS_POST', media: [{ googleUrl: 'https://example.invalid/photo.jpg' }] }] };
    if (path.pathname.endsWith('/media')) return { mediaItems: [{ name: parent + '/media/photo-one', googleUrl: 'https://example.invalid/photo.jpg' }] };
    if (path.pathname.endsWith('/VoiceOfMerchantState')) return { hasVoiceOfMerchant: true };
    assert.equal(path.pathname, '/v1/locations/456'); return { name: 'locations/456', title: 'FICTITIOUS_LOCATION', categories: { primaryCategory: { displayName: 'FICTITIOUS_CATEGORY' } }, metadata: { hasVoiceOfMerchant: true }, arbitrarySecret: 'FICTITIOUS_ACCESS_SENTINEL' };
  } });
  const api = require('../../services/businessProfileBroker.service');
  const service = api.createBusinessProfileBroker({ enabled: () => enabled, loadLocation: id => models.ClinicBusinessLocation.findByPk(id),
    loadManagedBinding: id => models.BusinessProfileBrokerBinding.findByPk(id), client: {
    async execute(command) {
      assert.equal(command.tenantRef, 'clinic:71'); assert.equal(command.assetRef, 'gbp:123:456'); assert.equal(command.connectionRef, 'connection:test');
      const operation = operations[command.operation]; operation.validate(command.payload);
      const data = await operation.execute({ ...command, principalId: 'qa-jobs', policyVersion: 'qa-v1', binding: { connectionRef: command.connectionRef }, secret: Buffer.from('FICTITIOUS_ACCESS_SENTINEL'), signal: new AbortController().signal });
      return { data: operation.project(data) };
    },
  } });
  const { metaSyncJobs: jobs } = loadBusinessProfileJobs({ models, broker: { ...service, binding: api.binding }, logs,
    legacyHttp: { get: async () => { legacyCalls++; throw Error('LEGACY_HTTP_FORBIDDEN'); } }, matching: async id => matching.push(id) });
  jobs._ensureGoogleAccessToken = async () => { tokenReads++; throw Error('LEGACY_TOKEN_FORBIDDEN'); };
  const metric = { clinica_id: 71, business_location_id: 51, metric_type: 'CALL_CLICKS', metric_subtype: '', date: '2026-09-02', value: 13 };
  await models.BusinessProfileDailyMetric.create(metric);
  await models.BusinessProfileReview.create({ clinica_id: 71, business_location_id: 51, review_name: 'stale-review', comment: 'FICTITIOUS_STALE' });
  const result = await jobs.executeBusinessProfileSync({ clinicId: 71, startDate: '2026-09-01', endDate: '2026-09-02' });
  assert.equal(result.status, 'completed', JSON.stringify(result.report)); assert.equal(result.report.reviews, 2); assert.equal(result.report.posts, 1); assert.equal(result.report.media, 1);
  assert.equal(tokenReads, 0); assert.equal(legacyCalls, 0); assert.equal(providerCalls, 7); assert.equal(matching.length, 2);
  await location.reload(); assert.equal(location.location_name, 'FICTITIOUS_LOCATION'); assert.equal(location.is_verified, true); assert.equal(location.raw_payload.keepExisting, 'FICTITIOUS_EXISTING');
  assert.equal(location.raw_payload.accountName, 'accounts/123'); assert.equal(location.raw_payload.arbitrarySecret, undefined);
  assert.equal(location.raw_payload.clinicaclick_media_items.length, 1); assert.equal(location.broker_read_connection_ref, 'connection:test');
  report.checks.push('Actual full job uses all six broker operations, opaque pagination, existing caches and internal matching contract without tokens');
  const metrics = await models.BusinessProfileDailyMetric.findAll({ order: [['date', 'ASC']], raw: true });
  assert.equal(metrics.length, 2); assert.equal(metrics[0].value, 0); assert.equal(metrics[1].value, 13);
  assert.equal(await models.BusinessProfileReview.count({ where: { review_name: 'stale-review' } }), 0);
  assert.equal(await models.BusinessProfileReview.count({ where: { review_name: 'review-first' } }), 1);
  report.checks.push('Missing metric does not overwrite consolidated value; complete reviews remove stale cache while preserving provider reviewId');
  await models.BusinessProfileReview.create({ clinica_id: 71, business_location_id: 51, review_name: 'stale-review' });
  const context = await service.prepare(location, jobs._ensureGoogleAccessToken, new Map());
  mode = 'failed-page'; await assert.rejects(jobs._syncBusinessProfileReviews(location, context));
  assert.equal(await models.BusinessProfileReview.count({ where: { review_name: 'stale-review' } }), 1);
  mode = 'complete'; await jobs._syncBusinessProfileReviews(location, context, { maxPages: 1 });
  assert.equal(await models.BusinessProfileReview.count({ where: { review_name: 'stale-review' } }), 1);
  const incremental = await jobs.executeBusinessProfileReviewsSync({ clinicId: 71, maxPages: 5 });
  assert.equal(incremental.status, 'completed'); assert.equal(await models.BusinessProfileReview.count({ where: { review_name: 'stale-review' } }), 1);
  report.checks.push('Failed/truncated pagination and incremental job never delete stale review rows');
  enabled = false; const beforeDisabled = providerCalls;
  const disabled = await jobs.executeBusinessProfileReviewsSync({ clinicId: 71 }); assert.equal(disabled.status, 'failed');
  assert.equal(providerCalls, beforeDisabled); assert.equal(tokenReads, 0); assert.equal(legacyCalls, 0);
  enabled = true; await location.update({ clinica_id: 72 });
  await assert.rejects(service.read(location, context, 'details', {}), { code: 'broker_binding_invalid' }); assert.equal(providerCalls, beforeDisabled);
  report.checks.push('Persisted cohort fails closed when disabled or reassigned; no fallback or double provider execution');
  for (const row of await models.SyncLog.findAll({ raw: true })) assert(!JSON.stringify(row).includes('FICTITIOUS_ACCESS_SENTINEL'));
  assert(!JSON.stringify(logs).includes('FICTITIOUS_ACCESS_SENTINEL'));
  report.checks.push('Job logs and status rows contain no provider credential sentinel');
  const deletable = await models.ClinicBusinessLocation.create({ id: 52, clinica_id: 71, google_connection_id: 81, location_id: 'locations/999',
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:999' });
  await models.BusinessProfileBrokerBinding.create({ external_location_id: '999', connection_ref: 'connection:test', asset_ref: 'gbp:123:999', clinica_id: 71, google_connection_id: 81 });
  await deletable.destroy(); assert(await models.BusinessProfileBrokerBinding.findByPk('999'));
  const recreated = await models.ClinicBusinessLocation.create({ id: 53, clinica_id: 71, google_connection_id: 81, location_id: 'locations/999' });
  await assert.rejects(service.prepare(recreated, jobs._ensureGoogleAccessToken, new Map()), { code: 'broker_binding_invalid' });
  assert.equal(tokenReads, 0); await recreated.destroy();
  report.checks.push('Independent registry survives mapping deletion and blocks a recreated legacy row before any token load');
  await location.update({ broker_read_connection_ref: null, broker_read_asset_ref: null });
  await assert.rejects(migration.down(qi), /Managed GBP bindings/);
  // Explicit rollback of exclusively fictitious registry records with all work drained.
  await models.BusinessProfileBrokerBinding.destroy({ where: {} });
  await migration.down(qi); await migration.up(qi); await location.reload();
  assert.equal(location.broker_read_connection_ref, null); assert.equal(location.location_name, 'FICTITIOUS_LOCATION');
  assert.equal(await models.BusinessProfileDailyMetric.count(), 2);
  report.checks.push('Fictitious drained rollback and reapply preserve domain rows and leave markers inactive');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
