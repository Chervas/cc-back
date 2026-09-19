'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadBusinessProfileJobs } = require('./business_profile_jobs.fixture');
module.exports = async ({ models, report, broker, local, consumer, resolved, request, setRead, setWritesEnabled, setAfter, writes }) => {
  let matched = async () => {}, reads = 0;
  const { metaSyncJobs: jobs } = loadBusinessProfileJobs({ models,
    broker: { ...broker, binding: require('../../../services/businessProfileBroker.service').binding },
    legacyHttp: { get: () => { throw Error('LEGACY_FORBIDDEN'); } }, matching: id => matched(id) });
  const snapshot = () => models.ClinicBusinessLocation.findByPk(51);
  const context = await broker.prepare(await snapshot(), () => { throw Error('LEGACY_FORBIDDEN'); }, new Map());
  const parent = 'accounts/123/locations/456';
  const review = (reply, id = 'business_1') => ({ name: parent + '/reviews/' + id,
    reviewId: id, starRating: 'FIVE', updateTime: '2026-09-19T00:00:00Z',
    ...(reply ? { reviewReply: { comment: reply, updateTime: '2026-09-19T01:00:00Z' } } : {}) });
  const response = data => { reads++; return { data }; };
  const reply = comment => ({ operationId: randomUUID(), comment });
  const publish = () => local.publishPhoto(resolved, { operationId: randomUUID(), publicMediaAssetId: 111 }, { request });
  const hours = () => local.updateSpecialHours(resolved, { operationId: randomUUID(), timeZone: 'Europe/Madrid',
    periods: [{ id: 'spring', label: 'Cierre primavera', kind: 'closed', startDate: '2027-03-01', endDate: '2027-03-01' }] }, { request });
  const sync = async (family, mapping = null, ctx = context) => {
    const method = { reviews: '_syncBusinessProfileReviews', media: '_syncBusinessProfileMedia', details: '_syncBusinessProfileLocationDetails' }[family];
    return jobs[method](mapping || await snapshot(), ctx);
  };
  const cacheReview = () => models.BusinessProfileReview.findByPk(91);
  async function delayed(family, data, action, mapping, ctx) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    setRead(async () => { entered(); await wait; return response(data); });
    const pending = sync(family, mapping, ctx);
    // Attach rejection before unblocking the fictitious provider.
    const rejected = assert.rejects(pending, { code: 'business_profile_sync_superseded' });
    await started;
    try { await action(); } finally { release(); }
    await rejected;
  }
  await delayed('reviews', { reviews: [review(null)], totalReviewCount: 1 }, async () => {
    await local.updateReviewReply(resolved, 91, reply('Nuevo mientras se lee Google'), { request });
  });
  assert.equal((await cacheReview()).reply_comment, 'Nuevo mientras se lee Google');
  await delayed('reviews', { reviews: [review('Viejo')], totalReviewCount: 1 }, async () => {
    await local.deleteReviewReply(resolved, 91, { operationId: randomUUID() }, { request });
  });
  assert.equal((await cacheReview()).has_reply, false);
  // Interleave after page commit/matching and before the authoritative prune.
  setRead(() => response({ reviews: [review(null, 'ordering_new')], totalReviewCount: 1 }));
  matched = async () => { matched = async () => {}; await local.updateReviewReply(resolved, 91, reply('Conservar al podar'), { request }); };
  await assert.rejects(sync('reviews'), { code: 'business_profile_sync_superseded' });
  assert.equal((await cacheReview()).reply_comment, 'Conservar al podar');
  report.checks.push('actual paginated sync cannot undo a later reply/delete or prune a review after a mutation between page commit and matching; no SQL transaction spans provider wait');

  await delayed('media', { mediaItems: [] }, publish);
  let location = await snapshot(); assert.equal(location.raw_payload.clinicaclick_media_items.length, 2);
  const media = location.raw_payload.clinicaclick_media_items;
  setRead(() => response({ mediaItems: media })); assert.equal(await sync('media'), 2);
  await delayed('details', { specialHours: { specialHourPeriods: [] } }, hours);
  location = await snapshot(); assert.equal(location.raw_payload.clinicaclick_special_hours_plan.periods[0].label, 'Cierre primavera');
  assert.equal(location.raw_payload.specialHours.specialHourPeriods[0].startDate.year, 2027);
  assert.equal(location.raw_payload.marker, 'preserve'); assert.equal(location.raw_payload.clinicaclick_media_items.length, 2);
  const alias = await models.ClinicBusinessLocation.findByPk(52);
  const aliasContext = await broker.prepare(alias, () => { throw Error('LEGACY_FORBIDDEN'); }, new Map());
  await delayed('media', { mediaItems: [] }, publish, alias, aliasContext);
  assert.equal((await snapshot()).raw_payload.clinicaclick_media_items.length, 3);
  report.checks.push('actual photo/hours writers invalidate older media/details observations atomically; global location coordination also protects another local mapping/account alias');

  const lost = reply('ACK perdido durante sync');
  await delayed('reviews', { reviews: [review(null)], totalReviewCount: 1 }, async () => {
    setAfter(() => { setAfter(null); throw Object.assign(Error('FICTITIOUS_ACK_LOST'), { code: 'broker_unavailable' }); });
    await assert.rejects(local.updateReviewReply(resolved, 91, lost, { request }), { code: 'broker_unavailable' });
  });
  const before = reads, count = writes();
  setWritesEnabled(false);
  await assert.rejects(sync('reviews'), { code: 'business_profile_sync_mutation_pending' });
  assert.equal(reads, before);
  setRead(() => response({ mediaItems: (media) })); await sync('media'); // different family progresses
  setWritesEnabled(true);
  await consumer.recover({ clinicId: 72, operationId: lost.operationId, request });
  assert.equal(writes(), count); assert.equal((await cacheReview()).reply_comment, lost.comment);
  setRead(() => response({ reviews: [review(lost.comment)], totalReviewCount: 1 }));
  await sync('reviews');
  report.checks.push('uncertain mutation blocks only its cache family before any read, even with writer gate off; status-only recovery reopens sync without another provider mutation');

  const second = await models.BusinessProfileReview.create({ clinica_id: 71, business_location_id: 51,
    review_name: parent + '/reviews/second_pending', raw_payload: {} });
  const pair = [reply('Pendiente uno'), reply('Pendiente dos')];
  setAfter(() => { throw Object.assign(Error('FICTITIOUS_ACK_LOST'), { code: 'broker_unavailable' }); });
  const attempts = await Promise.allSettled(pair.map((input, index) => local.updateReviewReply(resolved, index ? second.id : 91, input, { request })));
  setAfter(null);
  assert(attempts.every(result => result.status === 'rejected' && result.reason.code === 'broker_unavailable'));
  const cacheKey = require('../../../../services/integrations-broker/src/google-business-profile-write-contract').hash('locations/456/cache/reviews');
  assert.equal((await models.BusinessProfileCacheState.findByPk(cacheKey)).pending_count, 2);
  const afterAttempts = writes();
  await consumer.recover({ clinicId: 72, operationId: pair[0].operationId, request });
  assert.equal((await models.BusinessProfileCacheState.findByPk(cacheKey)).pending_count, 1);
  await assert.rejects(sync('reviews'), { code: 'business_profile_sync_mutation_pending' });
  await consumer.recover({ clinicId: 72, operationId: pair[1].operationId, request });
  assert.equal((await models.BusinessProfileCacheState.findByPk(cacheKey)).pending_count, 0);
  assert.equal(writes(), afterAttempts);
  await consumer.recover({ clinicId: 72, operationId: pair[0].operationId, request });
  assert.equal((await models.BusinessProfileCacheState.findByPk(cacheKey)).pending_count, 0);
  report.checks.push('two concurrent distinct review intents retain a count of two; recovering one leaves sync blocked; last recovery releases it once and historical recovery never decrements again');

  await models.BusinessProfileReview.bulkCreate(Array.from({ length: 601 }, (_, index) => ({
    clinica_id: 71, business_location_id: 51, review_name: parent + '/reviews/stale_' + index,
  })));
  const statements = [], logging = models.sequelize.options.logging;
  models.sequelize.options.logging = statement => statements.push(statement);
  try {
    setRead(() => response({ reviews: [review(pair[0].comment)], totalReviewCount: 1 }));
    await sync('reviews');
  } finally { models.sequelize.options.logging = logging; }
  const pruningReads = statements.filter(statement => /SELECT `id`, `review_name`/.test(statement));
  assert.equal(pruningReads.length, 2); assert(pruningReads.every(statement => /LIMIT 500/.test(statement)));
  assert.equal(statements.filter(statement => /DELETE FROM `BusinessProfileReviews`/.test(statement)).length, 2);
  assert.equal(await models.BusinessProfileReview.count(), 1); assert(await cacheReview());
  report.checks.push('authoritative prune of 602 absent reviews uses two keyset batches capped at 500, each guarded by the observation transaction; live review preserved');

  const newest = [{ name: parent + '/media/newest' }];
  await delayed('media', { mediaItems: [] }, async () => {
    setRead(() => response({ mediaItems: newest })); await sync('media');
  });
  assert.deepEqual((await snapshot()).raw_payload.clinicaclick_media_items, newest);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  setRead(async () => { entered(); await waiting; return response({ mediaItems: [] }); });
  const revoked = assert.rejects(sync('media'), { code: 'broker_binding_invalid' });
  await started; await models.ClinicBusinessLocation.update({ is_active: false }, { where: { id: 51 } }); release(); await revoked;
  await models.ClinicBusinessLocation.update({ is_active: true }, { where: { id: 51 } });
  assert.deepEqual((await snapshot()).raw_payload.clinicaclick_media_items, newest);
  const rows = await models.BusinessProfileCacheState.findAll({ raw: true });
  assert.equal(rows.length, 3); assert(rows.every(row => row.pending_count === 0));
  const [plan] = await models.sequelize.query('EXPLAIN SELECT * FROM BusinessProfileCacheStates WHERE resource_key = ?', { replacements: [rows[0].resource_key] });
  assert.equal(plan[0].key, 'PRIMARY');
  await assert.rejects(require('../../../../migrations/20260919210000-create-business-profile-cache-coordination').down(models.sequelize.getQueryInterface()), /Preserve/);
  report.checks.push('newest concurrent observation wins; mapping revocation discards delayed response; only three bounded state rows per location, indexed primary-key lookup, destructive down refused');
};
