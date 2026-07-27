'use strict';

const assert = require('node:assert/strict');
const {
  accessibleProviderLocationsById,
  assertBusinessProfileConnectionCoherence,
  mergeBusinessProfileRawPayload,
  movedOriginClinicIds,
  normalizeBusinessProfileLocationMappings,
  normalizeBusinessProfileVerification,
  resolveAuthorizedDestinationGoogleConnection,
} = require('../../lib/businessProfileLocationMapping');
const {
  authorizeRequestedMarketingConnectionScope,
  marketingScopeInputFromRequest,
} = require('../../lib/oauthMarketingScopeAccess');
const {
  selectAuthorizedMetaAssets,
  withoutMetaAccessToken,
} = require('../../lib/metaAssetAuthorization');
const {
  assertSharedMarketingAssetMutationAccess,
} = require('../../lib/sharedMarketingAssetMutationAccess');
const {
  buildReviewProfileAliasConfiguration,
} = require('../../lib/reviewProfileAlias');

function expectInputError(input, code) {
  assert.throws(
    () => normalizeBusinessProfileLocationMappings(input),
    (error) => error?.httpStatus === 400 && error?.code === code
  );
}

function testMappingValidation() {
  expectInputError([], 'business_profile_mappings_required');
  expectInputError(
    [{ clinicaId: 55, locationId: 'locations/shared' }, { clinicaId: 56, locationId: 'locations/shared' }],
    'business_profile_location_destination_conflict'
  );
  expectInputError(
    [{ clinicaId: 55, locationId: '' }],
    'business_profile_mapping_invalid'
  );

  const normalized = normalizeBusinessProfileLocationMappings([
    { clinicaId: '55', locationId: ' locations/one ', locationName: 'Primera versión' },
    { clinicaId: 55, locationId: 'locations/one', locationName: 'Versión final' },
  ]);
  assert.equal(normalized.length, 1, 'an identical clinic/location pair must be idempotent');
  assert.equal(normalized[0].clinicaId, 55);
  assert.equal(normalized[0].locationId, 'locations/one');
  assert.equal(normalized[0].locationName, 'Versión final');
}

function testOriginMoveDetection() {
  const existing = [
    { location_id: 'locations/one', clinica_id: 55 },
    { location_id: 'locations/two', clinica_id: 56 },
    { location_id: 'locations/three', clinica_id: 57 },
  ];
  const requested = normalizeBusinessProfileLocationMappings([
    { clinicaId: 55, locationId: 'locations/one' },
    { clinicaId: 66, locationId: 'locations/two' },
  ]);
  assert.deepEqual(
    movedOriginClinicIds(existing, requested),
    [56],
    'only a real cross-clinic move must require permission on the origin clinic'
  );
}

function testReviewProfileAliasKeepsGeneralMappingSeparate() {
  const current = {
    disciplinas: ['dental'],
    reviews: {
      google_business_profile_alias: {
        clinic_id: 35,
        location_id: 'locations/old',
      },
      google_business_profile_alias_clinic_id: 35,
      google_business_profile_alias_location_id: 'locations/old',
      unrelated_setting: true,
    },
  };
  const updated = buildReviewProfileAliasConfiguration(current, {
    targetClinicId: 57,
    sourceClinicId: 56,
    sourceClinicName: 'Propdental Sant Marti',
    businessLocationId: 6,
    locationId: 'locations/sant-marti',
    updatedAt: new Date('2026-07-27T12:00:00.000Z'),
  });

  assert.deepEqual(updated.disciplinas, ['dental']);
  assert.equal(updated.reviews.unrelated_setting, true);
  assert.equal(updated.reviews.google_business_profile_alias, undefined);
  assert.equal(updated.reviews.google_business_profile_alias_clinic_id, 56);
  assert.equal(updated.reviews.google_business_profile_alias_business_location_id, 6);
  assert.equal(updated.reviews.google_business_profile_alias_location_id, 'locations/sant-marti');
  assert.equal(updated.reviews.google_business_profile_alias_updated_at, '2026-07-27T12:00:00.000Z');

  const ownProfile = buildReviewProfileAliasConfiguration(updated, {
    targetClinicId: 57,
    sourceClinicId: 57,
    sourceClinicName: 'Propdental Eixample',
    businessLocationId: 12,
    locationId: 'locations/eixample',
  });
  assert.equal(ownProfile.reviews.unrelated_setting, true);
  assert.equal(ownProfile.reviews.google_business_profile_alias_clinic_id, undefined);
  assert.equal(ownProfile.reviews.google_business_profile_alias_location_id, undefined);
}

async function testDestinationDerivedConnectionBlocksCrossScopeAttack() {
  const mappings = normalizeBusinessProfileLocationMappings([
    { clinicaId: 55, locationId: 'locations/a' },
  ]);
  const resolvedClinicIds = [];
  const result = await resolveAuthorizedDestinationGoogleConnection({
    userId: 7,
    mappings,
    authorizeDestinations: async ({ clinicIds, access }) => {
      assert.deepEqual(clinicIds, [55]);
      assert.equal(access, 'write');
      return true;
    },
    resolveForClinic: async (clinicId) => {
      resolvedClinicIds.push(clinicId);
      return { connection: { id: 100 + clinicId } };
    },
  });
  assert.deepEqual(resolvedClinicIds, [55],
    'a forged request scope must never choose the connection; only authorized destinations do');
  assert.equal(result.connection.id, 155);

  let resolverCalled = false;
  await assert.rejects(
    resolveAuthorizedDestinationGoogleConnection({
      userId: 7,
      mappings,
      authorizeDestinations: async () => false,
      resolveForClinic: async () => { resolverCalled = true; },
    }),
    (error) => error?.httpStatus === 403
      && error?.code === 'business_profile_destination_scope_forbidden'
  );
  assert.equal(resolverCalled, false, 'authorization must run before any scope resolver side effect');

  await assert.rejects(
    resolveAuthorizedDestinationGoogleConnection({
      userId: 7,
      mappings: normalizeBusinessProfileLocationMappings([
        { clinicaId: 55, locationId: 'locations/a' },
        { clinicaId: 56, locationId: 'locations/b' },
      ]),
      authorizeDestinations: async () => true,
      resolveForClinic: async (clinicId) => ({ connection: { id: clinicId } }),
    }),
    (error) => error?.httpStatus === 400
      && error?.code === 'business_profile_connection_scope_conflict'
  );
}

async function testExplicitScopeGuardRunsBeforeResolution() {
  let authorizationCalls = 0;
  await assert.rejects(
    authorizeRequestedMarketingConnectionScope({
      userId: 7,
      clinicIdRaw: null,
      groupIdRaw: 90,
      assignmentScopeRaw: 'group',
      access: 'read',
      findClinicGroupId: async () => null,
      findGroupClinicIds: async () => [66, 67],
      authorizeClinicIds: async ({ clinicIds, access }) => {
        authorizationCalls += 1;
        assert.deepEqual(clinicIds, [66, 67]);
        assert.equal(access, 'read');
        return false;
      },
    }),
    (error) => error?.httpStatus === 403
      && error?.code === 'marketing_connection_scope_forbidden'
  );
  assert.equal(authorizationCalls, 1);

  await assert.rejects(
    authorizeRequestedMarketingConnectionScope({
      userId: 7,
      clinicIdRaw: 55,
      groupIdRaw: 90,
      assignmentScopeRaw: 'group',
      access: 'write',
      findClinicGroupId: async () => 90,
      findGroupClinicIds: async () => [66, 67],
      authorizeClinicIds: async () => true,
    }),
    (error) => error?.httpStatus === 400
      && error?.code === 'marketing_connection_scope_mismatch'
  );

  let exactClinicScope = null;
  await authorizeRequestedMarketingConnectionScope({
    userId: 7,
    clinicIdRaw: 55,
    groupIdRaw: 90,
    assignmentScopeRaw: 'clinic',
    access: 'write',
    findClinicGroupId: async () => 90,
    findGroupClinicIds: async () => {
      throw new Error('an explicit clinic scope must not expand to the whole group');
    },
    authorizeClinicIds: async ({ clinicIds }) => {
      exactClinicScope = clinicIds;
      return true;
    },
  });
  assert.deepEqual(exactClinicScope, [55]);
}

function testScopeAliasesUseOneCanonicalParser() {
  for (const [container, alias] of [
    ['query', 'clinic_id'],
    ['query', 'clinicId'],
    ['query', 'clinica_id'],
    ['query', 'clinicaId'],
    ['body', 'clinic_id'],
    ['body', 'clinicId'],
    ['body', 'clinica_id'],
    ['body', 'clinicaId'],
  ]) {
    const req = { query: {}, body: {} };
    req[container][alias] = '55';
    assert.equal(marketingScopeInputFromRequest(req).clinicIdRaw, '55', `${container}.${alias}`);
  }
  assert.deepEqual(marketingScopeInputFromRequest({
    query: { groupId: '9', assignmentScope: 'group' },
    body: {},
  }), {
    clinicIdRaw: null,
    groupIdRaw: '9',
    assignmentScopeRaw: 'group',
  });
}

function testProviderOwnershipConnectionCoherenceAndRawMerge() {
  const mappings = normalizeBusinessProfileLocationMappings([
    { clinicaId: 55, locationId: 'locations/a' },
  ]);
  const providerById = accessibleProviderLocationsById(mappings, [
    { locationId: 'locations/a', locationName: 'Clínica A' },
  ]);
  assert.equal(providerById.get('locations/a').locationName, 'Clínica A');
  assert.throws(
    () => accessibleProviderLocationsById(mappings, [{ locationId: 'locations/from-other-connection' }]),
    (error) => error?.httpStatus === 400
      && error?.code === 'business_profile_location_not_accessible'
  );

  assert.equal(assertBusinessProfileConnectionCoherence([
    { location_id: 'locations/a', google_connection_id: 8 },
  ], mappings, 8), true);
  assert.throws(
    () => assertBusinessProfileConnectionCoherence([
      { location_id: 'locations/a', google_connection_id: 9 },
    ], mappings, 8),
    (error) => error?.httpStatus === 409
      && error?.code === 'business_profile_connection_mismatch'
  );

  const merged = mergeBusinessProfileRawPayload({
    title: 'Antiguo',
    clinicaclick_media_items: [{ name: 'media/1' }],
    clinicaclick_reviews_synced_at: '2026-07-15T10:00:00.000Z',
  }, {
    title: 'Nuevo',
    clinicaclick_media_items: [{ name: 'ataque' }],
    clinicaclick_reviews_synced_at: 'reemplazado',
  }, {
    accountName: 'accounts/1',
  });
  assert.equal(merged.title, 'Nuevo');
  assert.deepEqual(merged.clinicaclick_media_items, [{ name: 'media/1' }]);
  assert.equal(merged.clinicaclick_reviews_synced_at, '2026-07-15T10:00:00.000Z');
  assert.equal(merged.accountName, 'accounts/1');
}

function testBusinessProfileVoiceOfMerchantVerification() {
  assert.deepEqual(normalizeBusinessProfileVerification({
    hasVoiceOfMerchant: true,
    verificationState: 'UNVERIFIED',
    hasBusinessAuthority: false,
  }), {
    verificationStatus: 'VERIFIED',
    isVerified: true,
  }, 'hasVoiceOfMerchant is the canonical current Google verification signal');
  assert.deepEqual(normalizeBusinessProfileVerification({ hasVoiceOfMerchant: false }), {
    verificationStatus: 'UNVERIFIED',
    isVerified: false,
  });
  assert.deepEqual(normalizeBusinessProfileVerification({ verificationStatus: 'VERIFIED' }), {
    verificationStatus: 'VERIFIED',
    isVerified: true,
  }, 'legacy persisted payloads remain readable');
}

function testMetaAssetsAlwaysUseServerAuthorizedValues() {
  const trusted = {
    id: 'page-1',
    type: 'facebook_page',
    name: 'Nombre real',
    assetAvatarUrl: 'https://trusted.example/avatar.jpg',
    pageAccessToken: 'trusted-page-token',
  };
  const selected = selectAuthorizedMetaAssets([{
    id: 'page-1',
    type: 'facebook_page',
    name: 'Nombre manipulado',
    pageAccessToken: 'attacker-token',
  }], [trusted]);
  assert.equal(selected[0], trusted, 'mapping must persist the server-side Meta object, not browser fields');
  assert.throws(
    () => selectAuthorizedMetaAssets([{ id: 'unknown', type: 'facebook_page' }], [trusted]),
    (error) => error?.httpStatus === 400 && error?.code === 'meta_asset_not_accessible'
  );
  assert.deepEqual(withoutMetaAccessToken(trusted), {
    id: 'page-1',
    type: 'facebook_page',
    name: 'Nombre real',
    assetAvatarUrl: 'https://trusted.example/avatar.jpg',
  });
  assert.deepEqual(withoutMetaAccessToken({
    id: 'page-1',
    additionalData: {
      page_access_token: 'legacy-secret',
      nested: { accessToken: 'legacy-secret-2', followers: 20 },
    },
  }), {
    id: 'page-1',
    additionalData: { nested: { followers: 20 } },
  });
}

async function testSharedAssetMutationRequiresEveryConsumerClinic() {
  const assignmentModel = {
    async findAll(options) {
      assert.deepEqual(options.where, { assetType: 'google.analytics', assetId: 101 });
      return [{ clinicaId: 56 }, { clinicaId: 56 }];
    },
  };
  let authorizedClinicIds = null;
  await assert.rejects(
    assertSharedMarketingAssetMutationAccess({
      userId: 7,
      assetType: 'google.analytics',
      assetId: 101,
      ownerClinicId: 55,
      assignmentModel,
      authorizeClinicIds: async ({ clinicIds, access }) => {
        authorizedClinicIds = clinicIds;
        assert.equal(access, 'write');
        return false;
      },
    }),
    (error) => error?.httpStatus === 409 && error?.code === 'asset_in_use'
  );
  assert.deepEqual(authorizedClinicIds, [55, 56]);

  const allowed = await assertSharedMarketingAssetMutationAccess({
    userId: 7,
    assetType: 'google.analytics',
    assetId: 101,
    ownerClinicId: 55,
    assignmentModel,
    authorizeClinicIds: async ({ clinicIds }) => clinicIds.length === 2,
  });
  assert.deepEqual(allowed, [55, 56]);

  let implicitGroupScope = null;
  await assert.rejects(
    assertSharedMarketingAssetMutationAccess({
      userId: 7,
      assetType: 'google.ads_account',
      assetId: 11,
      ownerClinicId: 55,
      assignmentModel: { findAll: async () => [] },
      findImplicitGroupId: async () => 5,
      findGroupClinicIds: async (groupId) => {
        assert.equal(groupId, 5);
        return [55, 56, 57];
      },
      authorizeClinicIds: async ({ clinicIds }) => {
        implicitGroupScope = clinicIds;
        return false;
      },
    }),
    (error) => error?.httpStatus === 409 && error?.code === 'asset_in_use'
  );
  assert.deepEqual(implicitGroupScope, [55, 56, 57],
    'assignmentScope=group must include every clinic even without explicit assignment rows');
}

async function run() {
  testMappingValidation();
  testOriginMoveDetection();
  testReviewProfileAliasKeepsGeneralMappingSeparate();
  await testDestinationDerivedConnectionBlocksCrossScopeAttack();
  await testExplicitScopeGuardRunsBeforeResolution();
  testScopeAliasesUseOneCanonicalParser();
  testProviderOwnershipConnectionCoherenceAndRawMerge();
  testBusinessProfileVoiceOfMerchantVerification();
  testMetaAssetsAlwaysUseServerAuthorizedValues();
  await testSharedAssetMutationRequiresEveryConsumerClinic();
  console.log('oauth local mapping scope tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
