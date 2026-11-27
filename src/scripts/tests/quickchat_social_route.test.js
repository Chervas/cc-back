'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const binding = require('../../services/metaMarketingEnrollmentBinding.service');
const E = require('../../services/metaMarketingEnrollment.contract');
const { assetSetDigest } = require('../../services/metaMarketingEffectiveCredential.service');
const { resolveRoute, routesForEnrollment } = require('../../services/socialInboxRoute.service');

test('saved group destinations separate Instagram extension and Page messages under the same authorization', async (t) => {
  const selected = ['401', '402'].map((id) => ({
    kind: 'facebook_page',
    id,
    parentPageId: null,
    assetRef: 'meta-facebook_page:' + id,
  }));
  const enrollment = {
    state: 'active',
    enrollment_id: 'enrollment',
    scope_key: 'group:9',
    connection_ref: 'shared',
    meta_user_id: '701',
    app_id: '101',
    clinicIds: [41, 42],
    mappingIds: [11, 12],
    selected,
  };
  t.mock.method(E, 'request', (row) => row);
  t.mock.method(binding, 'createBindings', () => ({ committed: async () => ({ digest: 'snapshot' }) }));
  const mappings = selected.map((p, i) => ({
    id: 11 + i,
    metaAssetId: p.id,
    assignmentScope: 'group',
    grupoClinicaId: 9,
  }));
  const shares = [
    { assetId: 11, clinicaId: 41 },
    { assetId: 12, clinicaId: 42 },
  ];
  const journals = ['501', '502'].map((id, i) => ({
    ...enrollment,
    confirmed_at: new Date(),
    reserved_scope: 'clinic:' + (41 + i),
    selected_candidate_digest: 'b'.repeat(64),
    selected_instagram_id: id,
    structure_hash: E.hash(
      JSON.stringify(['snapshot', selected[i].id, assetSetDigest(selected), '701']),
    ),
  }));
  const db = {
    MetaMarketingBrokerBinding: {
      findAll: async ({ where }) =>
        mappings
          .filter((m) => 'meta-facebook_page:' + m.metaAssetId === where.asset_ref)
          .map((m) => ({ ...enrollment, mapping_id: m.id })),
    },
    MetaMarketingInstagramExtension: {
      findAll: async ({ where }) =>
        journals.filter((j) => where.enrollment_id ? j.enrollment_id === where.enrollment_id : j.selected_instagram_id === where.selected_instagram_id),
    },
    MetaMarketingEnrollmentRequest: { findByPk: async () => enrollment },
    MetaMarketingBrokerRevocation: { findOne: async () => null },
    ClinicMetaAsset: {
      findAll: async () => mappings,
      findOne: async ({ where }) => mappings.find((m) => m.metaAssetId === where.metaAssetId),
      findByPk: async (id) => mappings.find((m) => m.id === id),
    },
    GrupoClinica: { findByPk: async () => ({ facebook_assignment_mode: 'clinic' }) },
    GroupAssetClinicAssignment: {
      findAll: async ({ where }) => shares.filter((s) => [].concat(where.assetId).includes(s.assetId)),
    },
  };
  const lookup = (channel, accountId) => resolveRoute(db, { channel, accountId }, {});
  for (const [channel, id, clinic] of [
    ['instagram', '501', 41],
    ['instagram', '502', 42],
    ['messenger', '401', 41],
    ['messenger', '402', 42],
  ]) {
    const r = await lookup(channel, id);
    assert.equal(r.clinicId, clinic);
    assert.equal(r.connectionRef, 'shared');
  }
  const snapshot = () => routesForEnrollment(db, enrollment.enrollment_id, {});
  const first = await snapshot();
  assert.equal(first.status, 'resolved');
  assert.deepEqual(first.routes.map(r => [r.clinicId, r.channel, r.accountId, r.pageId]), [
    [41, 'messenger', '401', '401'], [42, 'messenger', '402', '402'],
    [41, 'instagram', '501', '401'], [42, 'instagram', '502', '402'],
  ]);
  shares.push({ assetId: 11, clinicaId: 42 });
  assert.equal(await lookup('messenger', '401'), null);
  assert.equal(await lookup('instagram', '501'), null);
  const changed = await snapshot();
  assert.equal(changed.status, 'assignment_review');
  // Sharing the first page with clinic 42 also leaves that clinic's Instagram
  // extension with two possible parent Pages in the saved destination plan.
  assert.deepEqual(changed.review, [
    { channel: 'messenger', accountId: '401' }, { channel: 'instagram', accountId: '501' },
    { channel: 'instagram', accountId: '502' },
  ]);
  assert.deepEqual(changed.routes.map(r => [r.channel, r.clinicId]), [['messenger', 42]]);
  journals.push({ ...journals[0], reserved_scope: 'clinic:42' });
  assert.equal(await lookup('instagram', '501'), null);
});

test('direct Instagram must agree with its unique enrolled parent Page and the clinic actually receiving it', async t => {
  const grant = {
    enrollment_id: 'enrollment', state: 'active', connection_ref: 'connection', app_id: '101',
    scope_key: 'group:9', clinicIds: [41, 42], selected: [
      { kind: 'facebook_page', id: '401' }, { kind: 'facebook_page', id: '402' },
      { kind: 'instagram_business', id: '501', parentPageId: '401' },
    ],
  };
  const assets = new Map([
    ['meta-facebook_page:401', [{ enrollment_id: 'enrollment', connection_ref: 'connection', mapping_id: 11 }]],
    ['meta-facebook_page:402', [{ enrollment_id: 'enrollment', connection_ref: 'connection', mapping_id: 12 }]],
    ['meta-instagram_business:501', [{ enrollment_id: 'enrollment', connection_ref: 'connection', mapping_id: 21, parent_page_id: '401' }]],
  ]);
  const clinicByMapping = new Map([[11, 41], [12, 42], [21, 41]]);
  const activeExtensions = [];
  let revoked = false, grantReads = 0;
  t.mock.method(E, 'request', row => row);
  t.mock.method(binding, 'createBindings', () => ({ committed: async () => {
    grantReads++;
    if (revoked) throw Object.assign(Error(), { code: 'meta_enrollment_asset_revoked' });
    return { digest: 'pinned' };
  } }));
  const db = {
    MetaMarketingEnrollmentRequest: { findByPk: async () => grant },
    MetaMarketingBrokerBinding: { findAll: async ({ where }) => assets.get(where.asset_ref) || [] },
    MetaMarketingInstagramExtension: { findAll: async ({ where }) => activeExtensions.filter(
      e => where.enrollment_id ? e.enrollment_id === where.enrollment_id : e.selected_instagram_id === where.selected_instagram_id) },
    ClinicMetaAsset: { findByPk: async id => ({ id, assignmentScope: 'group', grupoClinicaId: 9 }) },
    GrupoClinica: { findByPk: async () => ({ facebook_assignment_mode: 'clinic', instagram_assignment_mode: 'clinic' }) },
    GroupAssetClinicAssignment: { findAll: async ({ where }) => [{ clinicaId: clinicByMapping.get(where.assetId) }] },
  };
  const read = () => routesForEnrollment(db, grant.enrollment_id, {});
  const ig = { channel: 'instagram', accountId: '501' };
  assert.deepEqual((await read()).routes.map(r => [r.clinicId, r.pageId]), [[41, '401'], [42, '402'], [41, '401']]);
  assert.equal(grantReads, 1);
  clinicByMapping.set(21, 42);
  assert.deepEqual((await read()).review, [ig]);
  assert.equal(await resolveRoute(db, ig, {}), null);
  clinicByMapping.set(21, 41);
  activeExtensions.push({ enrollment_id: grant.enrollment_id, selected_instagram_id: '501' });
  const duplicate = await read();
  assert.deepEqual(duplicate.review, [ig]);
  assert.deepEqual(duplicate.routes.map(r => r.channel), ['messenger', 'messenger']);
  activeExtensions.pop();
  assets.get('meta-instagram_business:501')[0].parent_page_id = '402';
  assert.deepEqual((await read()).review, [ig]);
  assets.get('meta-instagram_business:501')[0].parent_page_id = '401';
  assets.get('meta-facebook_page:401').push({ enrollment_id: 'another' });
  assert.deepEqual((await read()).review, [{ channel: 'messenger', accountId: '401' }, ig]);
  revoked = true;
  assert.deepEqual(await read(), { status: 'enrollment_unavailable', routes: [], review: [] });
});
