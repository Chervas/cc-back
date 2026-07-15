'use strict';

const assert = require('node:assert/strict');
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
    Clinica: emptyModel,
    GoogleConnectionAssignment: emptyModel,
    MetaConnectionAssignment: emptyModel,
    ClinicWebAsset: { findAll: async () => webRow ? [webRow] : [] },
    ClinicAnalyticsProperty: emptyModel,
    ClinicBusinessLocation: emptyModel,
    ClinicGoogleAdsAccount: emptyModel,
    GroupAssetClinicAssignment: {
      findAll: async ({ where }) => {
        assert.deepEqual(where, { assetType: 'google.search_console', assetId: 10 });
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
  assert.deepEqual(result, { web: 1, analytics: 0, local: 0, ads: 0 });
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
  console.log('oauth scoped disconnect tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
