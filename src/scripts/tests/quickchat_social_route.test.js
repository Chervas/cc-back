'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const binding = require('../../services/metaMarketingEnrollmentBinding.service');
const E = require('../../services/metaMarketingEnrollment.contract');
const { assetSetDigest } = require('../../services/metaMarketingEffectiveCredential.service');
const { resolveRoute } = require('../../services/socialInboxRoute.service');

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
        journals.filter((j) => j.selected_instagram_id === where.selected_instagram_id),
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
  shares.push({ assetId: 11, clinicaId: 42 });
  assert.equal(await lookup('messenger', '401'), null);
  assert.equal(await lookup('instagram', '501'), null);
  journals.push({ ...journals[0], reserved_scope: 'clinic:42' });
  assert.equal(await lookup('instagram', '501'), null);
});
