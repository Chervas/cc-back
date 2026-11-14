'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), S = require('sequelize');
const H = require('../../services/businessProfileHistoryScope.service');
const C = require('../../services/businessProfileAssociation.contract');
const Owner = require('../../../services/integrations-broker/src/google-business-profile-enrollment-contract');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');

// These tests exercise the real overview/cache/authority path. The SQL adapter
// returns projected aggregates deliberately; native SQL ranking is covered by
// the isolated generations/activity fixture, not simulated as JavaScript here.
function fixture({ shared = false, mixed = false } = {}) {
  const state = { originGroup: 28, roles: new Map([[70, 'agencia'], [71, 'agencia']]),
    afterCache: null, duringPublicQuery: null, publicQueries: [], privateScopes: [], projectionReads: [], caches: [] };
  const scope = { scope: shared || mixed ? 'group' : 'clinic', groupId: shared || mixed ? 28 : null,
    clinicIds: shared || mixed ? [70, 71] : [70] };
  const mapping = { id: 17, clinica_id: 70, google_connection_id: 23, location_id: 'locations/456', is_active: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:456' };
  const source = { ...mapping, id: 2, clinica_id: 1, is_active: false };
  const unrelated = { ...mapping, id: 18, clinica_id: 71, location_id: 'locations/999', broker_read_asset_ref: 'gbp:123:999' };
  const locations = new Map([[17, mapping], [2, source], [18, unrelated]]);
  const generationId = '20000000-0000-4000-8000-000000000002', attemptId = '30000000-0000-4000-8000-000000000003';
  const proof = { descriptorId: '40000000-0000-4000-8000-000000000004', sourceTenantRef: 'clinic:1',
    sourceConnectionRef: 'connection:test', sourceScopeRef: 'gbp-enroll:clinic:1', sourceAssetRef: 'gbp:123:456',
    retirementEnrollmentId: '50000000-0000-4000-8000-000000000005', retirementDigest: 'a'.repeat(64) };
  const predecessor = { mappingId: 2, clinicId: 1, groupId: 28, assetRef: 'gbp:123:456', connectionRef: 'connection:test' };
  const generation = { generation_id: generationId, mapping_id: 17, external_location_id: '456', clinica_id: 70,
    google_connection_id: 23, connection_ref: 'connection:test', asset_ref: 'gbp:123:456', scope_ref: 'gbp-enroll:clinic:70',
    previous_asset_ref: null, state: 'active', association_attempt_id: attemptId, source_fingerprint: 'b'.repeat(64),
    predecessor: [predecessor], reassociation: proof };
  generation.proof_digest = Owner.reassociationDigest(proof, { tenantRef: 'clinic:70', connectionRef: generation.connection_ref,
    assetRef: generation.scope_ref, payload: { enrollmentId: attemptId, accountId: '123', locationId: '456', previousAssetRef: null,
      clinicCount: 1, clinicSetDigest: C.hash([70]), reassociation: proof } });
  const clinic = id => ({ id_clinica: Number(id), nombre_clinica: 'Fictitious clinic ' + id,
    grupoClinicaId: Number(id) === 1 ? state.originGroup : 28, configuracion: {} });
  const idsFrom = clause => Array.isArray(clause) ? clause : clause?.[S.Op.in] || [clause].filter(v => v != null);
  const db = { Sequelize: S, sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: true } }), query: async (sql, options) => {
    const r = options.replacements;
    if (sql.includes('BusinessProfileReviews') && sql.includes('total_reviews')) {
      const ids = Array.from(r.providerLocationIds || r.locationIds || []);
      state.publicQueries.push(ids);
      await state.duringPublicQuery?.();
      const rows = [];
      if (ids.includes(2)) rows.push({ business_location_id: 17, total_reviews: 2, rating_sum: 9, five_star_reviews: 1, last_seen_at: '2026-11-12T12:00:00Z' });
      if (mixed && ids.includes(18)) rows.push({ business_location_id: 18, total_reviews: 1, rating_sum: 3, five_star_reviews: 0, last_seen_at: '2026-11-12T12:00:00Z' });
      return rows;
    }
    if (r.clinicIds) state.privateScopes.push(Array.from(r.clinicIds));
    return [];
  } }, Clinica: { findByPk: async id => clinic(id), findAll: async ({ where }) => idsFrom(where.id_clinica).map(clinic) },
  UsuarioClinica: { findAll: async ({ where }) => {
    const id = Number(where.id_clinica), role = state.roles.get(id);
    return role ? [{ id_clinica: id, rol_clinica: role, estado_invitacion: 'aceptada' }] : [];
  } }, ClinicBusinessLocation: { findByPk: async id => locations.get(Number(id)),
    findAll: async ({ where }) => idsFrom(where.id).map(id => locations.get(Number(id))).filter(row => row?.is_active) },
  BusinessProfileBrokerRevocation: { findByPk: async () => null },
  BusinessProfileBrokerBinding: { findByPk: async id => id === '999'
    ? { external_location_id: '999', state: 'active', clinica_id: 71, google_connection_id: 23,
      connection_ref: 'connection:test', asset_ref: 'gbp:123:999', current_generation_id: null }
    : { external_location_id: '456', state: 'retired', current_generation_id: generationId } },
  BusinessProfileBrokerBindingGeneration: { findByPk: async () => generation },
  BusinessProfileAssociationRequest: { findByPk: async () => ({ state: 'active', target_mapping_id: 17,
    target_snapshot: { generationId, predecessors: [predecessor] } }) } };
  const history = { ...H, createHistoryProjection: args => {
    state.projectionReads.push({ clinicId: args.clinicId, ids: args.locations.map(row => row.id) });
    return H.createHistoryProjection({ ...args, permission: async ({ clinicIds }) =>
      clinicIds.every(id => ['agencia', 'personaldeclinica'].includes(state.roles.get(Number(id)))) });
  } };
  const cacheModule = require('../../lib/report-read-cache');
  const caches = { createReportReadCache: options => {
    const cache = cacheModule.createReportReadCache(options), original = cache.read, index = state.caches.length;
    cache.read = async (...args) => { const result = await original(...args); if (index === 0) await state.afterCache?.(); return result; };
    state.caches.push(cache); return cache;
  } };
  const activity = loadDiscoverySource('services/reviewActivityReport.service.js', {
    sequelize: S, '../lib/availability-calendar': require('../../lib/availability-calendar'),
    '../lib/review-response-heatmaps': require('../../lib/review-response-heatmaps'),
    './businessProfileHistoryScope.service': history,
    '../lib/report-read-cache': cacheModule,
  });
  const overview = loadDiscoverySource('services/reviewOverview.service.js', {
    '../lib/phone': require('../../lib/phone'), '../lib/review-request-history': require('../../lib/review-request-history'),
    '../lib/report-read-cache': caches, './reviewActivityReport.service': activity,
    '../lib/marketing-template-variables': require('../../lib/marketing-template-variables'),
    './googleReviewHistory.service': require('../../services/googleReviewHistory.service'),
    './businessProfileHistoryScope.service': history,
  });
  const resolveProfile = async row => {
    const location = mixed && Number(row.id_clinica) === 71 ? unrelated : mapping;
    // An own (non-alias) profile really returns location:null. Its numeric
    // mapping ID is links.business_location_id; links.location_id is external.
    return { location: null, alias: false, links: { business_location_id: location.id,
      location_id: location.location_id, location_name: 'Fictitious public asset ' + location.id } };
  };
  const service = overview.createService({ db, resolveProfile, queues: async () => [], automation: async () => null,
    projectPublicHistory: args => overview.publicHistoryForOverview(db, resolveProfile, args),
    ratingSummary: row => ({ total_reviews: Number(row.total_reviews), average: Number(row.rating_sum) / Number(row.total_reviews) }),
    now: () => new Date('2026-11-14T08:00:00Z') });
  const read = () => service.overview(scope, { userId: 9, scopeRaw: scope.scope === 'group' ? 'group:28' : '70' });
  return { state, service, scope, read };
}

test('overview requests accepted same-asset predecessor inventory when the current mapping has zero rows, without source private scope', async () => {
  const f = fixture(), result = await f.read();
  assert.deepEqual(f.state.publicQueries[0].sort((a,b) => a-b), [2,17]);
  assert.equal(result.google_profiles[0].business_location_id,17);
  assert.equal(result.google_profiles[0].rating.total_reviews,2);
  assert.equal(result.google_profiles[0].rating.average,4.5);
  assert.equal(result.current.google_reviews_total,2);
  assert(f.state.privateScopes.length > 0);
  assert(f.state.privateScopes.every(ids => ids.length === 1 && ids[0] === 70), 'old clinic patient/match/request scopes must not expand');
  assert.equal(result.private_ratings_summary.total,0);
  assert.equal(result.historical.requests_sent,0);
  assert.equal(result.historical.attributed_reviews,0);
  assert.equal(result.provider_requests,0);
});

test('two authorized clinics sharing one head display its score each but count its public inventory only once', async () => {
  const f = fixture({ shared: true }), result = await f.read();
  assert.equal(result.google_profiles.length,2);
  assert(result.google_profiles.every(row => row.business_location_id === 17 && row.rating.total_reviews === 2));
  assert.equal(result.current.google_reviews_total,2);
  assert(result.google_profiles.every(row => row.shared_with.length === 2));
  assert(f.state.projectionReads.some(row => row.clinicId === 70) && f.state.projectionReads.some(row => row.clinicId === 71));
  assert(f.state.privateScopes.every(ids => JSON.stringify(ids) === '[70,71]'));
});

test('mixed assets keep different head reputations and never merge an unrelated asset into the successor', async () => {
  const f = fixture({ mixed: true }), result = await f.read();
  assert.deepEqual(f.state.publicQueries[0].sort((a,b) => a-b), [2,17,18]);
  assert.equal(result.google_profiles.find(row => row.business_location_id === 17).rating.average,4.5);
  assert.equal(result.google_profiles.find(row => row.business_location_id === 18).rating.average,3);
  assert.equal(result.current.google_reviews_total,3);
  assert(result.google_profiles.every(row => row.shared_with.length === 0));
});

test('moving the origin out of the group changes the cache authority fingerprint and removes its historical data', async () => {
  const f = fixture();
  assert.equal((await f.read()).current.google_reviews_total,2);
  f.state.originGroup = 29;
  const after = await f.read();
  assert.equal(after.aggregate_cache.status,'miss');
  assert.deepEqual(f.state.publicQueries.at(-1),[17]);
  assert.equal(after.google_profiles[0].rating,null);
  assert.equal(after.current.google_reviews_total,0);
});

test('a cached public result is withheld if destination READ disappears after the hit', async () => {
  const f = fixture();
  assert.equal((await f.read()).current.google_reviews_total,2);
  const queryCount = f.state.publicQueries.length;
  f.state.afterCache = () => f.state.roles.delete(70);
  await assert.rejects(f.read(), error => error.code === 'scope_denied' && error.status === 403);
  assert.equal(f.state.publicQueries.length,queryCount, 'the revoked read must be tested on the cached path');
});

test('a shared head must revalidate every represented clinic, including loss of the second destination READ after a cache hit', async () => {
  const f = fixture({ shared: true });
  assert.equal((await f.read()).current.google_reviews_total,2);
  const queryCount = f.state.publicQueries.length;
  f.state.afterCache = () => f.state.roles.delete(71);
  await assert.rejects(f.read(), error => error.code === 'scope_denied' && error.status === 403);
  assert.equal(f.state.publicQueries.length,queryCount);
});

test('a fresh aggregate crossing a group change is rejected and never stored in the cache', async () => {
  const f = fixture();
  f.state.duringPublicQuery = () => { f.state.originGroup = 29; };
  await assert.rejects(f.read(), error => error.code === 'scope_denied' && error.status === 403);
  assert.equal(f.state.caches[0].size(),0);
});

test('a fresh aggregate crossing a destination role revocation is rejected and never stored in the cache', async () => {
  const f = fixture();
  f.state.duringPublicQuery = () => f.state.roles.delete(70);
  await assert.rejects(f.read(), error => error.code === 'scope_denied' && error.status === 403);
  assert.equal(f.state.caches[0].size(),0);
});
