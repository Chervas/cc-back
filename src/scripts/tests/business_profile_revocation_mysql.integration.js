'use strict';
const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { DataTypes: D } = require('sequelize'); const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  for (const [name, key] of [['Clinicas', 'id_clinica'], ['GoogleConnections', 'id'], ['ClinicMetaAssets', 'id']]) {
    await qi.createTable(name, { [key]: { type: D.INTEGER, primaryKey: true } });
  }
  await sql.query('INSERT INTO Clinicas VALUES (71), (72), (73)'); await sql.query('INSERT INTO GoogleConnections VALUES (81)');
  await require('../../../migrations/20250915103000-create-clinicbusinesslocations').up(qi, require('sequelize'));
  await require('../../../migrations/20260913000000-add-business-profile-broker-read-binding').up(qi);
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(qi, D);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(qi, D);
  const migration = require('../../../migrations/20260913010000-create-business-profile-broker-revocations');
  await migration.up(qi, D); await migration.down(qi); await migration.up(qi, D);
  for (const [name, file] of [['ClinicBusinessLocation','clinicbusinesslocation'], ['BusinessProfileBrokerBinding','businessprofilebrokerbinding'],
    ['BusinessProfileBrokerRevocation','businessprofilebrokerrevocation'], ['PlatformAuditEvent','platformauditevent']]) models[name] = require('../../../models/' + file)(sql, D);
  const R = models.BusinessProfileBrokerRevocation; const A = models.PlatformAuditEvent; const B = models.BusinessProfileBrokerBinding; const L = models.ClinicBusinessLocation;
  const empty = { findAll: async () => [] };
  models.ClinicWebAsset = models.ClinicAnalyticsProperty = models.ClinicGoogleAdsAccount = empty;
  models.SearchConsoleBrokerBinding = models.AnalyticsBrokerBinding = models.GooglePropertyBrokerRevocation = models.GrupoClinica = models.GoogleAdsBrokerBinding = empty;
  models.GoogleConnectionAssignment = empty; models.GroupAssetClinicAssignment = empty;
  models.Clinica = { findAll: async () => [{ id_clinica: 71 }, { id_clinica: 72 }] };
  const service = require('../../services/businessProfileRevocation.service');
  const { deactivateGoogleMappingsForScope: disconnect } = require('../../services/oauthScopedDisconnect.service');
  const { unpack } = require('../../../services/platform-audit/src/event');
  process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED = 'true';
  const seed = async (location, clinic) => {
    const row = await L.create({ clinica_id: clinic, google_connection_id: 81, location_id: 'locations/' + location,
      broker_read_connection_ref: 'connection:qa', broker_read_asset_ref: 'gbp:123:' + location });
    await B.create({ external_location_id: location, clinica_id: clinic, google_connection_id: 81, connection_ref: 'connection:qa', asset_ref: 'gbp:123:' + location });
    return row;
  };
  const first = await seed('456', 71); const foreign = await seed('457', 72);
  const args = clinic => ({ scope: { assignmentScope: 'clinic', clinicId: clinic }, connectionId: 81, models, actorId: 501, sessionRef: randomUUID() });
  const perform = (clinic, extra = {}) => sql.transaction(transaction => disconnect({ ...args(clinic), ...extra, transaction }));
  const result = await perform(71); assert.equal(result.brokerRevocationsPending, 1); assert.equal(result.local, 1);
  assert.equal((await first.reload()).is_active, false); assert.equal((await foreign.reload()).is_active, true);
  assert.equal(await R.count(), 1); assert.equal(await A.count(), 1);
  const attempt = unpack((await A.findOne()).get({ plain: true })).event;
  assert.equal(attempt.version, 7); assert.equal(attempt.actor.id, '501'); assert.equal(attempt.scope.id, '71');
  const initial = (await R.findByPk('456')).get({ plain: true });
  await perform(71); assert.equal(await A.count(), 1); assert.equal((await R.findByPk('456')).request_id, initial.request_id);
  report.checks.push('Mapping deactivation, durable intent and human v7 attempt commit together, exclude foreign clinic and deduplicate repeated disconnect');
  process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED = 'false';
  await assert.rejects(perform(72), { code: 'gbp_revocation_unavailable' });
  process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED = 'true';
  await assert.rejects(perform(72, { actorId: null }), { code: 'gbp_revocation_unavailable' });
  const breakAudit = () => { throw Error('FICTITIOUS_AUDIT_FAILURE'); };
  A.addHook('beforeCreate', 'qaFailure', breakAudit); await assert.rejects(perform(72), /FICTITIOUS_AUDIT_FAILURE/); A.removeHook('beforeCreate', 'qaFailure');
  assert.equal(await R.count(), 1); assert.equal((await foreign.reload()).is_active, true);
  models.GroupAssetClinicAssignment = { findAll: async () => [{ clinicaId: 73 }] };
  await assert.rejects(perform(72), { code: 'scope_disconnect_shared_asset_conflict' }); models.GroupAssetClinicAssignment = empty;
  report.checks.push('Disabled gate, missing actor, failed audit or shared consumer outside scope leave mappings and queue unchanged');
  const second = await seed('458', 71);
  models.GoogleConnectionAssignment = { findAll: async () => [{ clinicaId: 72 }] };
  const group = await sql.transaction(transaction => disconnect({ scope: { assignmentScope: 'group', groupId: 9 }, connectionId: 81, models, actorId: 501, transaction }));
  assert.equal(group.brokerRevocationsPending, 2); assert.equal(await R.count(), 2); assert.equal((await foreign.reload()).is_active, true);
  models.GoogleConnectionAssignment = empty;
  report.checks.push('Group disconnect preserves the active clinic override and its independent broker grant');
  const repository = service.createRevocationRepository(models); let clock = new Date(Date.now() + 1000);
  const claims = (await Promise.all(Array.from({ length: 6 }, () => repository.claim(clock)))).filter(Boolean);
  assert.equal(claims.length, 2); assert.equal(new Set(claims.map(r => r.external_location_id)).size, 2);
  const claim = claims.find(r => r.external_location_id === '456'); const other = claims.find(r => r.external_location_id === '458');
  await repository.retry(other, 'FICTITIOUS_SECRET', clock); assert.equal((await R.findByPk('458')).last_error, 'gbp_revocation_unavailable');
  clock = new Date(clock.getTime() + 121000);
  const reclaimed = await repository.claim(clock); assert.equal(reclaimed.external_location_id, '456');
  assert.equal(reclaimed.request_id, claim.request_id); assert.notEqual(reclaimed.lease_token, claim.lease_token);
  assert.equal(await repository.confirm(claim, clock), false);
  A.addHook('beforeCreate', 'qaFailure', breakAudit); await assert.rejects(repository.confirm(reclaimed, clock), /FICTITIOUS_AUDIT_FAILURE/); A.removeHook('beforeCreate', 'qaFailure');
  assert.equal((await R.findByPk('456')).state, 'pending'); assert.equal(await A.count({ where: { stage: 'completed' } }), 0);
  assert.equal(await repository.confirm(reclaimed, clock), true); assert.equal(await repository.confirm(reclaimed, clock), false);
  report.checks.push('Concurrent SKIP LOCKED claims are exclusive; expired lease cannot confirm; completion and job audit are atomic and idempotent');
  let lost = true; const calls = []; const fictitiousBrokerTombstones = new Set();
  const client = { execute: async command => {
    calls.push(command); fictitiousBrokerTombstones.add(command.requestId);
    if (lost) { lost = false; throw Object.assign(Error('FICTITIOUS_LOST_ACK'), { code: 'broker_timeout' }); }
    return { requestId: command.requestId, data: { revoked: true } };
  } };
  const worker = () => service.createRevocationWorker({ repository: service.createRevocationRepository(models), client, enabled: () => true, now: () => clock });
  assert.equal((await worker().run()).failed, 1); assert.equal((await R.findByPk('458')).state, 'pending');
  clock = new Date(clock.getTime() + 10000); assert.equal((await worker().run()).confirmed, 1);
  assert.equal(calls.length, 2); assert.equal(calls[0].requestId, calls[1].requestId); assert.equal(fictitiousBrokerTombstones.size, 1);
  assert.deepEqual(await service.status([71], models), { status: 'confirmed', pending_assets: 0, confirmed_assets: 2 });
  assert.deepEqual(await service.status([72], models), { status: 'none', pending_assets: 0, confirmed_assets: 0 });
  assert.equal(await R.count(), 2); assert.equal(await A.count(), 4);
  for (const audit of await A.findAll({ raw: true })) { const e = unpack(audit).event; assert.equal(e.subjectUserId, '501'); assert.equal(e.actor.type, e.stage === 'attempted' ? 'user' : 'job'); }
  report.checks.push('Fresh worker retries a lost broker ACK with the same durable request, confirms once and exposes only scoped counts');
  await first.destroy(); await second.destroy(); await B.destroy({ where: { clinica_id: 71 } });
  const recreated = await L.create({ clinica_id: 71, google_connection_id: 81, location_id: 'locations/456' });
  let tokenReads = 0; const adapter = require('../../services/businessProfileBroker.service').createBusinessProfileBroker({ enabled: () => true,
    loadLocation: id => L.findByPk(id), loadManagedBinding: id => B.findByPk(id), loadRevocation: id => R.findByPk(id), client: { execute: async () => { throw Error('UNEXPECTED_PROVIDER'); } } });
  await assert.rejects(adapter.prepare(recreated, async () => { tokenReads++; }, new Map()), { code: 'asset_revoked' }); assert.equal(tokenReads, 0);
  await assert.rejects(migration.down(qi), /gbp_revocation_preserve_tombstones/);
  const repeated = await perform(71); assert.equal(repeated.brokerRevocationsPending, 0); assert.equal(await A.count(), 4);
  report.checks.push('Confirmed tombstones survive deletion of both mapping and registry; recreated legacy mapping cannot load a token; rollback refuses to erase evidence');
  await perform(73); assert.equal(await A.count(), 4);
  report.checks.push('Unmanaged scope retains legacy SQL disconnect behavior without creating broker requests');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
