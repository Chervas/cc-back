'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const C = require('../../services/metaMarketingEnrollment.contract');
const F = require('../../services/metaMarketingFirstEnrollmentAuthority.service');

function fixture() {
  const config = { clinicId: 111, legacyGrantId: 21, legacyConnectionId: 31, canonicalConnectionId: 32,
    appId: '401', adAccountId: '501', pageId: '601' };
  const flow = { flow_id: randomUUID(), scope_key: 'clinic:111', clinic_ids: '[111]',
    connection_ref: 'meta-marketing-auto-clinic-111-v1', asset_ref: 'meta-enroll:clinic:111', app_id: '401' };
  const clinics = [{ id_clinica: 111, grupoClinicaId: null }];
  const grants = [{ id: 21, scopeKey: flow.scope_key, assignmentScope: 'clinic', clinicaId: 111,
    grupoClinicaId: null, metaConnectionId: 31, status: 'active' }];
  const args = { flow, clinics, grants, connectionId: 32 }, env = { [F.SETTING]: JSON.stringify(config) };
  const assets = C.assets([{ assetRef: 'meta-ad_account:501', kind: 'ad_account', id: '501', parentPageId: null },
    { assetRef: 'meta-facebook_page:601', kind: 'facebook_page', id: '601', parentPageId: null }]);
  const row = { ...flow, flow_digest: C.hash('synthetic-flow'), candidate_digest: C.hash('synthetic-candidate'),
    scope_digest: C.hash('synthetic-scope'), meta_user_id: '701', meta_connection_id: 32,
    assets: JSON.stringify(assets), actor_user_id: 41 };
  return { config, flow, clinics, grants, args, env, assets, row,
    permit: () => F.permitFor(args, env) };
}

test('an exact configured first direct-clinic enrollment receives only its two predetermined assets', () => {
  const f = fixture(), before = structuredClone(f.args), permit = f.permit();
  assert.equal(F.configuredFor(f.flow, f.env), true);
  assert.deepEqual(permit, { clinicId: 111, legacyConnectionId: 31, assetRefs: ['meta-ad_account:501', 'meta-facebook_page:601'] });
  assert(Object.isFrozen(permit) && Object.isFrozen(permit.assetRefs));
  assert.deepEqual(f.args, before); assert.equal(F.eligibleAssets(permit, f.assets), true);
  assert.equal(F.eligibleAssets(permit, permit.assetRefs.slice().reverse()), true);
});

test('absent permit is off, while malformed advertised settings cannot silently fall back', () => {
  const f = fixture();
  assert.equal(F.configuredFor(f.flow, {}), false); assert.equal(F.permitFor(f.args, {}), null);
  for (const value of ['{', '[]', 'null', JSON.stringify({ clinicId: '111' }), ' '.repeat(2049)]) {
    assert.throws(() => F.configuredFor(f.flow, { [F.SETTING]: value }), { code: 'meta_enrollment_assignment_review' });
  }
  const env = { [F.SETTING]: JSON.stringify({ clinicId: 111 }) };
  assert.equal(F.configuredFor(f.flow, env), true); assert.equal(F.permitFor(f.args, env), null);
});

test('advertised scope stays fenced despite app, connection, grant or canonical drift', () => {
  for (const mutate of [f => { f.flow.app_id = '999'; }, f => { f.flow.connection_ref = 'static:old'; },
    f => { f.args.connectionId = 99; }, f => { f.grants.length = 0; }, f => { f.grants[0].status = 'revoked'; }]) {
    const f = fixture(); mutate(f);
    assert.equal(F.configuredFor(f.flow, f.env), true); assert.equal(f.permit(), null);
  }
  const f = fixture(); f.flow.scope_key = 'clinic:112';
  assert.equal(F.configuredFor(f.flow, f.env), false); assert.equal(f.permit(), null);
});

test('permit rejects every ambiguous, grouped, malformed or widened identity/grant configuration', () => {
  const changes = [f => { f.config.extra = true; }, f => { f.config.legacyGrantId = '21'; },
    f => { f.config.canonicalConnectionId = 31; }, f => { f.config.adAccountId = 501; },
    f => { f.flow.clinic_ids = '[111,112]'; }, f => { f.flow.asset_ref = 'meta-enroll:clinic:112'; },
    f => { f.clinics[0].grupoClinicaId = 4; }, f => { delete f.clinics[0].grupoClinicaId; },
    f => { f.clinics.push({ id_clinica: 112, grupoClinicaId: null }); },
    f => { f.grants.push({ ...f.grants[0], id: 22 }); }, f => { f.grants[0].id = 22; },
    f => { f.grants[0].metaConnectionId = 32; }, f => { f.grants[0].scopeKey = 'clinic:112'; },
    f => { f.grants[0].assignmentScope = 'group'; }, f => { f.grants[0].grupoClinicaId = 4; }];
  for (const mutate of changes) {
    const f = fixture(); mutate(f); f.env[F.SETTING] = JSON.stringify(f.config); assert.equal(f.permit(), null);
  }
});

test('eligibility never borrows an extra account/page, an IG parent or a partial/duplicate selection', () => {
  const f = fixture(), permit = f.permit();
  for (const refs of [[], [permit.assetRefs[0]], [permit.assetRefs[0], permit.assetRefs[0]],
    [...permit.assetRefs, 'meta-ad_account:999'], ['meta-ad_account:999', permit.assetRefs[1]],
    [permit.assetRefs[0], 'meta-instagram_business:601'], ['act_501', permit.assetRefs[1]]]) {
    assert.equal(F.eligibleAssets(permit, refs), false);
  }
  assert.equal(F.eligibleAssets(null, f.assets), false);
});

test('certificate is stable across mutable lifecycle state and requires no runtime permit', () => {
  const f = fixture(), cert = F.certificate(f.row); assert.match(cert, /^[a-f0-9]{64}$/);
  f.row.assignment_digest = cert;
  for (const state of ['prepare_pending', 'prepared', 'active', 'revoke_pending', 'revoked', 'superseded']) {
    assert.equal(F.isCertified({ ...f.row, state, attempts: 9, updated_at: new Date(), mapping_ids: '[801,802]' }), true);
  }
  const envBefore = process.env[F.SETTING];
  process.env[F.SETTING] = '{broken';
  try { assert.equal(F.isCertified(f.row), true); assert.equal(F.certificate(f.row), cert); }
  finally { if (envBefore === undefined) delete process.env[F.SETTING]; else process.env[F.SETTING] = envBefore; }
  assert.notEqual(cert, C.hash(JSON.stringify(F.CERTIFICATE_FIELDS.map(key => f.row[key]))));
});

test('certificate pins every durable authority field and never certifies a legacy digest', () => {
  const f = fixture(); f.row.assignment_digest = F.certificate(f.row);
  const changes = { flow_id: randomUUID(), flow_digest: C.hash('changed-flow'), candidate_digest: C.hash('changed-candidate'),
    scope_key: 'clinic:112', clinic_ids: '[112]', connection_ref: 'connection:static', scope_digest: C.hash('changed-scope'),
    app_id: '402', meta_user_id: '702', meta_connection_id: 33, assets: f.row.assets.replace(/501/g, '502'), actor_user_id: 42 };
  for (const [field, value] of Object.entries(changes)) assert.equal(F.isCertified({ ...f.row, [field]: value }), false, field);
  assert.equal(F.isCertified({ ...f.row, assignment_digest: C.hash('legacy-assignment') }), false);
  for (const assets of [[], [f.assets[0]], [f.assets[0], { assetRef: 'meta-instagram_business:701', kind: 'instagram_business', id: '701', parentPageId: '601' }],
    [f.assets[0], f.assets[0]], [...f.assets].reverse()]) {
    assert.throws(() => F.certificate({ ...f.row, assets: JSON.stringify(assets) }));
  }
  assert.throws(() => F.certificate({ ...f.row, clinic_ids: '[111,112]' }));
  assert.throws(() => F.certificate({ ...f.row, flow_id: 'not-a-uuid' }));
});

function legacyFixture() {
  const f = fixture(), permit = f.permit(), calls = [], transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const rows = [{ id: 801, metaConnectionId: 31, assignmentScope: 'clinic', clinicaId: 111, grupoClinicaId: null,
    assetType: 'whatsapp_business_account', isActive: true },
  { id: 802, metaConnectionId: 31, assignmentScope: 'clinic', clinicaId: 111, grupoClinicaId: null,
    assetType: 'whatsapp_phone_number', isActive: 1 }];
  let binding = null;
  const models = { ClinicMetaAsset: { async findAll(options) { calls.push(['aliases', options]); return rows; } },
    MetaMarketingBrokerBinding: { async findOne(options) { calls.push(['binding', options]); return binding; } },
    MetaMarketingEnrollmentRequest: { findAll() { assert.fail('own pending enrollment is not a conflict'); } },
    MetaMarketingEnrollmentClaim: { findAll() { assert.fail('own pending claims remain checked by physical guard'); } } };
  const options = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
  return { ...f, rows, calls, transaction, options, models, permit, setBinding: value => { binding = value; },
    intact: () => F.legacyScopeIntact({ models, flow: f.flow, permit, options }) };
}

test('legacy scope check reads only bounded WA metadata and leaves own pending journal/claims alone', async () => {
  const f = legacyFixture(), before = structuredClone(f.rows); assert.equal(await f.intact(), true);
  assert.deepEqual(f.rows, before); assert.equal(f.calls.length, 2);
  const options = f.calls[0][1]; assert.deepEqual(options.where, { clinicaId: 111 }); assert.equal(options.limit, 1001);
  assert.equal(options.transaction, f.transaction); assert.equal(options.lock, 'UPDATE');
  assert(!options.attributes.some(key => /token|credential|additionalData|metaAssetId/.test(key)));
  assert.deepEqual(f.calls[1][1].where, { scope_key: 'clinic:111' });
});

test('legacy scope check denies wrong ownership, non-WA history, absent active phone and existing Marketing binding', async () => {
  for (const mutate of [f => { f.rows.length = 0; }, f => { f.rows[1].isActive = false; },
    f => { f.rows[0].assetType = 'facebook_page'; }, f => { f.rows[0].metaConnectionId = 32; },
    f => { f.rows[0].grupoClinicaId = 4; }, f => { f.rows[0].assignmentScope = 'group'; },
    f => { f.rows[0].clinicaId = 112; }, f => { f.rows[0].isActive = '1'; },
    f => { f.rows.push(...Array.from({ length: 1000 }, (_, i) => ({ ...f.rows[0], id: i + 900 }))); },
    f => { f.setBinding({ mapping_id: 999 }); }]) {
    const f = legacyFixture(); mutate(f); assert.equal(await f.intact(), false);
  }
});

test('storage uncertainty propagates unchanged and closed transactions or extra projections cannot be accepted', async () => {
  const f = legacyFixture(), timeout = Object.assign(Error('synthetic storage timeout'), { code: 'ETIMEDOUT' });
  f.models.ClinicMetaAsset.findAll = async () => { throw timeout; };
  await assert.rejects(f.intact(), error => error === timeout);
  for (const options of [{ ...f.options, transaction: { finished: 'commit' } }, { ...f.options, include: ['secret'] }]) {
    await assert.rejects(F.legacyScopeIntact({ models: f.models, flow: f.flow, permit: f.permit, options }), { code: 'meta_enrollment_unavailable' });
  }
});
