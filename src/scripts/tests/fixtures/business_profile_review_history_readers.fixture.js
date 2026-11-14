'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), D = require('sequelize');

module.exports = async ({ sql, models, report, target, old, unrelated, account, oldId }) => {
  // This fixture changes fictitious observations only inside the harness-owned
  // mysqld. Neither the ordinary application DB nor a provider is admissible.
  assert.equal(process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST, '1');
  assert.equal(sql.config.database, 'campaign_optimization_qa');
  assert.equal(sql.options.dialectOptions.socketPath, path.join(report.root, 'mysql.sock'));
  const activity = require('../../../services/reviewActivityReport.service');
  const Overview = require('../../../services/reviewOverview.service');
  models.Sequelize = D;
  const Reviews = models.BusinessProfileReview;
  const baseline = await Reviews.findAll({ raw: true, order: [['id', 'ASC']] });
  const sourceId = Number(old.id), headId = Number(target.id), otherId = Number(unrelated.id);
  const sourceClinic = Number(old.clinica_id), destination = Number(target.clinica_id);
  const currentIds = id => Number(id) === destination ? [headId] : Number(id) === sourceClinic ? [otherId] : [];
  const now = new Date('2026-11-13T12:00:00Z');
  const single = { clinicIds: [destination], locationIds: [headId], locationOwners: { [headId]: [destination] },
    userId: 901, period: '30d', now, resolveEffectiveMappingIds: async () => [headId],
    resolveEffectiveMappingIdsForClinic: async id => currentIds(id) };
  const group = { ...single, clinicIds: [sourceClinic, destination], locationIds: [otherId, headId],
    locationOwners: { [otherId]: [sourceClinic], [headId]: [destination] }, userId: 9 };
  const readActivity = async options => { activity.invalidate(); return activity.readReport(models, options); };
  let temporaryList, temporaryItemId, addedClinicUrl = false;

  // Metadata is real. Overview's public aggregate SQL is executed natively;
  // unrelated private readers are stubbed, with their original clinic scope
  // asserted instead of creating synthetic patient tables for this fixture.
  const overview = async (clinicIds = [destination], userId = 901) => {
    const allowed = clinicIds.slice().sort((a,b) => a-b), privateScopes = [];
    const db = { ...models, sequelize: {
      transaction: (...args) => sql.transaction(...args),
      query: async (statement, options) => {
        if (statement.includes('BusinessProfileReviews') && statement.includes('total_reviews')) return sql.query(statement, options);
        const ids = Array.from(options.replacements?.clinicIds || []).sort((a,b) => a-b);
        assert.deepEqual(ids, allowed, 'historical public inventory must not widen private reader scopes');
        privateScopes.push(ids);
        return [];
      },
    } };
    const resolveProfile = async clinic => {
      const mapping = Number(clinic.id_clinica) === destination ? target : unrelated;
      return { location: null, alias: false, links: { business_location_id: Number(mapping.id),
        location_id: mapping.location_id, location_name: 'FICTITIOUS_PUBLIC_PROFILE' } };
    };
    const service = Overview.createService({ db, resolveProfile,
      projectPublicHistory: args => Overview.publicHistoryForOverview(db, resolveProfile, args),
      queues: async () => [], automation: async () => null, now: () => now,
      ratingSummary: row => ({ total_reviews: Number(row.total_reviews),
        average: Number(row.rating_sum) / Number(row.total_reviews) }) });
    const result = await service.overview({ scope: clinicIds.length === 1 ? 'clinic' : 'group',
      groupId: clinicIds.length === 1 ? null : 5, clinicIds }, { userId, scopeRaw: clinicIds.join(','), period: '30d' });
    assert(privateScopes.length > 0);
    assert.equal(result.private_ratings_summary.total, 0);
    assert.equal(result.historical.requests_sent, 0);
    assert.equal(result.historical.attributed_reviews, 0);
    assert.equal(result.provider_requests, 0);
    return result;
  };
  const createReview = values => Reviews.create({ first_seen_at: new Date('2026-11-01T00:00:00Z'),
    last_seen_at: new Date('2026-11-12T12:00:00Z'), google_missing_at: null, ...values });

  try {
    const clinicColumns = await sql.getQueryInterface().describeTable('Clinicas');
    if (!clinicColumns.url_ficha_local) {
      await sql.getQueryInterface().addColumn('Clinicas', 'url_ficha_local', { type: D.STRING(2048), allowNull: true });
      addedClinicUrl = true;
    }
    await Reviews.destroy({ where: {}, force: true });
    const original = await createReview({ clinica_id: sourceClinic, business_location_id: sourceId,
      review_name: `accounts/${account}/locations/${oldId}/reviews/fictitious-review`, star_rating: 5,
      create_time: new Date('2026-11-01T12:00:00Z') });
    await createReview({ clinica_id: sourceClinic, business_location_id: sourceId,
      review_name: `accounts/${account}/locations/${oldId}/reviews/FICTITIOUS_NATIVE_HISTORY_ONLY`, star_rating: 4,
      create_time: new Date('2026-11-02T12:00:00Z') });
    await createReview({ clinica_id: sourceClinic, business_location_id: otherId,
      review_name: `accounts/${account}/${unrelated.location_id}/reviews/fictitious-review`, star_rating: 1,
      create_time: new Date('2026-11-03T12:00:00Z') });

    assert.equal(await Reviews.count({ where: { business_location_id: headId } }), 0);
    const noOwnRows = await overview();
    assert.equal(noOwnRows.google_profiles[0].business_location_id, headId);
    assert.equal(noOwnRows.google_profiles[0].rating.total_reviews, 2);
    assert.equal(noOwnRows.google_profiles[0].rating.average, 4.5);
    assert.equal(noOwnRows.current.google_reviews_total, 2);
    const noOwnActivity = await readActivity(single);
    assert.equal(noOwnActivity.totals.google_reviews_total, 2);
    assert.equal(noOwnActivity.totals.requests_sent, 0);
    assert.equal(noOwnActivity.totals.google_reviews_attributed, 0, 'source private match is unavailable to destination-only actor');

    const sharedTail = await readActivity(group);
    assert.equal(sharedTail.totals.google_reviews_total, 3, 'same review tail on a distinct asset remains a separate observation');
    assert.equal(sharedTail.totals.google_reviews_attributed, 1, 'authorized source match is joined once across its accepted lineage');
    const mixedOverview = await overview([sourceClinic, destination], 9);
    assert.equal(mixedOverview.current.google_reviews_total, 3);
    assert.equal(mixedOverview.google_profiles.find(row => row.business_location_id === headId).rating.total_reviews, 2);
    assert.equal(mixedOverview.google_profiles.find(row => row.business_location_id === otherId).rating.total_reviews, 1);

    // Global UNIQUE(review_name) still permits a normalized bare-tail copy.
    // Such overlap must use the accepted current head, without double counting.
    const current = await createReview({ clinica_id: destination, business_location_id: headId,
      review_name: 'fictitious-review', star_rating: 2, create_time: new Date('2026-11-01T12:00:00Z'),
      last_seen_at: new Date('2026-11-13T10:00:00Z') });
    const overlap = await overview();
    assert.equal(overlap.current.google_reviews_total, 2);
    assert.equal(overlap.google_profiles[0].rating.average, 3, 'head score 2 overrides predecessor score 5, retaining the other historical score 4');
    assert.equal((await readActivity(single)).totals.google_reviews_total, 2);
    const overlapGroup = await readActivity(group);
    assert.equal(overlapGroup.totals.google_reviews_total, 3);
    assert.equal(overlapGroup.totals.google_reviews_attributed, 1);

    await current.update({ google_missing_at: new Date('2026-11-13T11:00:00Z') });
    const missingHead = await overview();
    assert.equal(missingHead.current.google_reviews_total, 1, 'a current tombstone cannot be resurrected by the visible predecessor copy');
    assert.equal(missingHead.google_profiles[0].rating.average, 4);
    const missingActivity = await readActivity(single);
    assert.equal(missingActivity.totals.google_reviews_total, 2);
    assert.equal(missingActivity.totals.google_reviews_missing, 1);
    assert.equal((await original.reload()).google_missing_at, null, 'readers must not rewrite the origin observation');
    const missingMixed = await overview([sourceClinic, destination], 9);
    assert.equal(missingMixed.current.google_reviews_total, 2);

    // Exercise the legacy no-current-mapping fallback with a real matching
    // observation. An empty providerLocationIds list must not turn it into an
    // additional orphan match, which would count the same review twice.
    await current.update({ google_missing_at: null });
    temporaryList = await models.MarketingPatientList.create({ clinica_id: destination, objective_id: 'mass_sends',
      criteria: { review_request: true }, status: 'paused' });
    const [nextRows] = await sql.query('SELECT COALESCE(MAX(id),0)+100 next_id FROM MarketingPatientListItems');
    temporaryItemId = Number(nextRows[0].next_id);
    await sql.query("INSERT INTO MarketingPatientListItems(id,list_id,clinica_id,sent_at,paciente_id,phone) VALUES(?,?,?,'2026-11-12 12:00:00',99902,'FICTITIOUS')",
      { replacements: [temporaryItemId, temporaryList.id, destination] });
    await sql.query("INSERT INTO MarketingPatientContactEvents(list_id,item_id,event_type,occurred_at,created_at,payload) VALUES(?,?,'google_review_matched','2026-11-12 13:00:00','2026-11-12 13:00:00',?)",
      { replacements: [temporaryList.id, temporaryItemId, JSON.stringify({ review_name: 'fictitious-review', business_location_id: headId })] });
    const noMappings = await readActivity({ ...single, locationIds: [], locationOwners: {} });
    assert.equal(noMappings.totals.google_reviews_total, 1);
    assert.equal(noMappings.totals.google_reviews_attributed, 1);
    assert.equal(noMappings.totals.requests_sent, 1);

    // The earlier source-clinic match is not in the current-mapping set. When
    // neither generation holds the public row, it must not win the rank and
    // then discard a later, eligible current-head match for that review.
    await Reviews.destroy({ where: { review_name: { [D.Op.in]: [
      `accounts/${account}/locations/${oldId}/reviews/fictitious-review`, 'fictitious-review',
    ] } } });
    const orphanGroup = await readActivity(group);
    assert.equal(orphanGroup.totals.google_reviews_total, 3, 'two different public reviews plus one current-head orphan receipt');
    assert.equal(orphanGroup.totals.google_reviews_attributed, 1);
    const attributedByClinic = id => orphanGroup.by_clinic.find(row => row.clinic_id === id)?.series
      .find(series => series.key === 'google_reviews_attributed')?.data.reduce((sum, point) => sum + point.y, 0) || 0;
    assert.equal(attributedByClinic(destination), 1, 'later current-head receipt remains eligible after source-only receipt is filtered');
    assert.equal(attributedByClinic(sourceClinic), 0);
  } finally {
    if (temporaryList) {
      await sql.query('DELETE FROM MarketingPatientContactEvents WHERE list_id=? AND item_id=?', { replacements: [temporaryList.id, temporaryItemId] });
      await sql.query('DELETE FROM MarketingPatientListItems WHERE list_id=? AND id=?', { replacements: [temporaryList.id, temporaryItemId] });
      await temporaryList.destroy();
    }
    await Reviews.destroy({ where: {}, force: true });
    if (baseline.length) await Reviews.bulkCreate(baseline, { validate: false, hooks: false, silent: true });
    activity.invalidate();
    assert.deepEqual(await Reviews.findAll({ raw: true, order: [['id', 'ASC']] }), baseline,
      'native reader cases must restore every pre-existing observation for the later generation-chain fixture');
    if (addedClinicUrl) await sql.getQueryInterface().removeColumn('Clinicas', 'url_ficha_local');
  }
  report.checks.push('Native MySQL overview includes accepted same-asset predecessor observations before first head rows; current head overlap and tombstone precedence deduplicate public reputation without moving origin IDs or widening private clinic scope');
  report.checks.push('Native MySQL activity keeps a same-tail distinct asset separate, joins authorized group attribution once across generations, hides source private matches from destination-only actor, and avoids duplicate orphan matches when current mapping IDs are empty');
};
