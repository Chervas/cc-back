'use strict';

const assert = require('node:assert/strict');
require('./fixtures/security_offline_runtime.cjs');
const modelIndex = require.resolve('../../../models');
assert.equal(require.cache[modelIndex], undefined, 'Production models must never load in this isolated test');
require.cache[modelIndex] = { id: modelIndex, filename: modelIndex, loaded: true, exports: {} };
const {
  deactivateGoogleMappingsForScope,
  deactivateMetaMappingsForScope,
} = require('../../services/oauthScopedDisconnect.service');

function row(values) {
  return {
    ...values,
    async update(next) {
      Object.assign(this, next);
      return this;
    },
  };
}

function modelsForWebRow(webRow, consumerClinicIds = []) {
  const emptyModel = { findAll: async () => [] };
  return {
    Clinica: emptyModel, GrupoClinica: emptyModel,
    SearchConsoleBrokerBinding: emptyModel, AnalyticsBrokerBinding: emptyModel, GooglePropertyBrokerRevocation: emptyModel, GoogleAdsBrokerBinding: emptyModel, GoogleAdsBrokerRevocation: emptyModel,
    GoogleConnectionAssignment: emptyModel,
    BusinessProfileBrokerBinding: emptyModel,
    BusinessProfileBrokerRevocation: emptyModel,
    MetaConnectionAssignment: emptyModel,
    ClinicWebAsset: { findAll: async () => webRow ? [webRow] : [] },
    ClinicAnalyticsProperty: emptyModel,
    ClinicBusinessLocation: emptyModel,
    ClinicGoogleAdsAccount: emptyModel,
    GroupAssetClinicAssignment: {
      findAll: async ({ where }) => {
        assert.equal(where.assetType, 'google.search_console');
        assert(where.assetId === 10 || where.assetId[require('sequelize').Op.in]?.includes(10));
        return consumerClinicIds.map((clinicaId) => ({ clinicaId }));
      },
    },
  };
}

async function testExactClinicDeactivatesOnlyItsUnsharedMapping() {
  const mapping = row({ id: 10, clinicaId: 55, googleConnectionId: 8, isActive: true });
  const result = await deactivateGoogleMappingsForScope({
    scope: { assignmentScope: 'clinic', clinicId: 55, groupId: 5 },
    connectionId: 8,
    transaction: { LOCK: { UPDATE: 'UPDATE' } },
    models: modelsForWebRow(mapping),
  });
  assert.equal(mapping.isActive, false);
  assert.deepEqual(result, { web: 1, analytics: 0, local: 0, ads: 0, brokerRevocationsPending: 0 });
}

async function testSharedOutsideScopeBlocksAtomically() {
  const mapping = row({ id: 10, clinicaId: 55, googleConnectionId: 8, isActive: true });
  await assert.rejects(
    deactivateGoogleMappingsForScope({
      scope: { assignmentScope: 'clinic', clinicId: 55, groupId: 5 },
      connectionId: 8,
      transaction: { LOCK: { UPDATE: 'UPDATE' } },
      models: modelsForWebRow(mapping, [56]),
    }),
    (error) => error?.code === 'scope_disconnect_shared_asset_conflict'
      && error?.httpStatus === 409
  );
  assert.equal(mapping.isActive, true, 'the mapping is not touched before shared-consumer preflight passes');
}

async function testMetaClinicMappingIsDeactivatedWithTombstoneScope() {
  const mapping = row({
    id: 355,
    clinicaId: 36,
    grupoClinicaId: 5,
    assignmentScope: 'clinic',
    metaConnectionId: 158,
    assetType: 'ad_account',
    isActive: true,
  });
  const emptyModel = { findAll: async () => [] };
  const models = {
    Clinica: emptyModel,
    MetaConnectionAssignment: emptyModel,
    ClinicMetaAsset: { findAll: async () => [mapping] },
    GroupAssetClinicAssignment: {
      findAll: async ({ where }) => {
        assert.deepEqual(where, { assetType: 'meta.ad_account', assetId: 355 });
        return [];
      },
    },
  };
  const result = await deactivateMetaMappingsForScope({
    scope: { assignmentScope: 'clinic', clinicId: 36, groupId: 5 },
    connectionId: 158,
    transaction: { LOCK: { UPDATE: 'UPDATE' } },
    models,
  });
  assert.deepEqual(result, { meta: 1 });
  assert.equal(mapping.isActive, false);
}

async function run() {
  await testExactClinicDeactivatesOnlyItsUnsharedMapping();
  await testSharedOutsideScopeBlocksAtomically();
  await testMetaClinicMappingIsDeactivatedWithTombstoneScope();
  // An independent managed Ads record still prevents partial unlinking even
  // when the original Ads mapping has already been deleted.
  for (const missing of [false, true]) {
    const mapping = row({ id: 10, clinicaId: 55, googleConnectionId: 8, isActive: true });
    const models = modelsForWebRow(mapping);
    const record = { customer_id: '1234567890', mapping_id: 11, google_connection_id: 8, google_user_id: 'fictitious-subject',
      connection_ref: 'connection:ads-test', asset_ref: 'ads:1234567890', scope_key: 'clinic:55', tenant_clinic_id: 55, login_customer_id: null, state: 'active' };
    models.GoogleAdsBrokerBinding = { findAll: async options => {
      assert.equal(options.lock, 'UPDATE'); assert.equal(options.attributes.includes('accessToken'), false);
      if (missing) throw Error('FICTITIOUS_DATABASE_DETAILS'); return [record];
    } };
    await assert.rejects(deactivateGoogleMappingsForScope({ scope: { assignmentScope: 'clinic', clinicId: 55, groupId: 5 }, connectionId: 8,
      transaction: { LOCK: { UPDATE: 'UPDATE' } }, models }), { code: 'google_ads_revocation_unavailable', httpStatus: 503 });
    assert.equal(mapping.isActive, true);
  }
  const ads = row({ id: 11, customerId: '1234567890', assignmentScope: 'group', grupoClinicaId: 5, clinicaId: 999, googleConnectionId: 8, isActive: true });
  const models = modelsForWebRow(null);
  models.ClinicGoogleAdsAccount = { findAll: async () => [ads] };
  models.Clinica = { findAll: async () => [{ id_clinica: 55 }, { id_clinica: 56 }] };
  models.GroupAssetClinicAssignment = { findAll: async () => [] };
  const groupResult = await deactivateGoogleMappingsForScope({ scope: { assignmentScope: 'group', groupId: 5 }, connectionId: 8,
    transaction: { LOCK: { UPDATE: 'UPDATE' } }, models });
  assert.equal(groupResult.ads, 1); assert.equal(ads.isActive, false, 'The representative clinic is not the owner of a group Ads mapping');
  console.log('oauth scoped disconnect tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
