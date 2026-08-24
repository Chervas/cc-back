'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const {
  listScopedGoogleAccounts,
  listScopedGoogleProperties,
  listScopedMetaAssets,
  resolveEffectiveMarketingAssetInventory,
} = require('../../services/effectiveMarketingAssets.service');
const { __testing } = require('../../controllers/marketingReports.controller');

const clinicScope = {
  assignment_scope: 'clinic',
  clinic_id: 36,
  group_id: 5,
  clinic_ids: [36],
};

function findOrClauses(where) {
  return where?.[Op.or] || [];
}

async function testExplicitlySharedGoogleAccountIsEffective() {
  const assignmentModel = {
    async findAll(options) {
      assert.equal(options.where.clinicaId, 36);
      assert.equal(options.where.grupoClinicaId, 5);
      assert.equal(options.where.assetType, 'google.ads_account');
      return [{
        grupoClinicaId: 5,
        clinicaId: 36,
        assetType: 'google.ads_account',
        assetId: 10,
      }];
    },
  };
  const accountModel = {
    async findAll(options) {
      assert.equal(options.where.isActive, true);
      const explicitClause = findOrClauses(options.where)
        .find((clause) => Array.isArray(clause?.id?.[Op.in]));
      assert.deepEqual(explicitClause.id[Op.in], [10]);
      assert.ok(findOrClauses(options.where).some((clause) => clause.clinicaId === 36));
      assert.ok(findOrClauses(options.where).some((clause) => (
        clause.grupoClinicaId === 5 && clause.assignmentScope === 'group'
      )));
      return [
        {
          id: 10,
          clinicaId: 35,
          grupoClinicaId: null,
          assignmentScope: 'clinic',
          customerId: '111-222-3333',
          descriptiveName: 'Cuenta compartida explícitamente',
          isActive: true,
          googleConnectionId: 8,
          lastSyncedAt: '2026-07-15T09:00:00.000Z',
        },
        {
          id: 11,
          clinicaId: null,
          grupoClinicaId: 5,
          assignmentScope: 'group',
          customerId: '4445556666',
          descriptiveName: 'Cuenta heredada',
          isActive: true,
          googleConnectionId: 8,
        },
        {
          id: 12,
          clinicaId: 36,
          grupoClinicaId: null,
          assignmentScope: 'clinic',
          customerId: '444-555-6666',
          descriptiveName: 'Selección propia prioritaria',
          isActive: true,
          googleConnectionId: 9,
        },
      ];
    },
  };

  const accounts = await listScopedGoogleAccounts(clinicScope, {
    assignmentModel,
    accountModel,
  });

  assert.deepEqual(accounts.map((account) => account.customer_id), [
    '4445556666',
    '1112223333',
  ]);
  assert.equal(accounts[0].descriptive_name, 'Selección propia prioritaria');
  assert.equal(accounts[0].assignment_origin, 'clinic');
  assert.equal(accounts[1].assignment_origin, 'shared');
  assert.equal(accounts[1].mapping_id, 10);
  assert.equal(accounts[1].last_synced_at, '2026-07-15T09:00:00.000Z');
}

async function testExplicitlySharedMetaProfilesAreEffective() {
  const assignmentModel = {
    async findAll(options) {
      assert.equal(options.where.clinicaId, 36);
      assert.equal(options.where.grupoClinicaId, 5);
      assert.deepEqual(options.where.assetType[Op.in].sort(), [
        'meta.ad_account',
        'meta.facebook_page',
        'meta.instagram_business',
      ]);
      return [{
        grupoClinicaId: 5,
        clinicaId: 36,
        assetType: 'meta.facebook_page',
        assetId: 21,
      }];
    },
  };
  const assetModel = {
    async findAll(options) {
      const explicitClause = findOrClauses(options.where)
        .find((clause) => Array.isArray(clause?.id?.[Op.in]));
      assert.deepEqual(explicitClause.id[Op.in], [21]);
      return [{
        id: 21,
        clinicaId: 35,
        grupoClinicaId: null,
        assignmentScope: 'clinic',
        assetType: 'facebook_page',
        metaAssetId: 'page-21',
        metaAssetName: 'Perfil compartido',
        metaConnectionId: 7,
        isActive: true,
      }, {
        id: 22,
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'clinic',
        assetType: 'ad_account',
        metaAssetId: 'act_123456789',
        metaAssetName: 'Cuenta de la clínica',
        metaConnectionId: 7,
        ad_account_refreshed_at: '2026-08-23T22:17:34.000Z',
        isActive: true,
      }];
    },
  };

  const assets = await listScopedMetaAssets(clinicScope, {
    assignmentModel,
    assetModel,
  });
  assert.equal(assets.facebook_pages.length, 1);
  assert.equal(assets.facebook_pages[0].page_id, 'page-21');
  assert.equal(assets.facebook_pages[0].assignment_origin, 'shared');
  assert.equal(assets.facebook_pages[0].mapping_id, 21);
  assert.equal(assets.ad_accounts.length, 1);
  assert.equal(assets.ad_accounts[0].ad_account_id, 'act_123456789');
  assert.equal(assets.ad_accounts[0].last_checked_at, '2026-08-23T22:17:34.000Z');
}

async function testGooglePropertiesResolveDirectSharedAndGroupPrimary() {
  const groupModel = {
    async findByPk(groupId) {
      assert.equal(groupId, 5);
      return {
        id_grupo: 5,
        search_console_assignment_mode: 'clinic',
        search_console_primary_asset_id: null,
        analytics_assignment_mode: 'group',
        analytics_primary_property_id: 202,
        business_profile_assignment_mode: 'clinic',
        business_profile_primary_location_id: null,
      };
    },
  };
  const assignmentModel = {
    async findAll(options) {
      assert.equal(options.where.grupoClinicaId, 5);
      assert.equal(options.where.clinicaId, 36);
      assert.deepEqual(options.where.assetType[Op.in].sort(), [
        'google.analytics',
        'google.business_profile',
        'google.search_console',
      ]);
      return [
        { grupoClinicaId: 5, clinicaId: 36, assetType: 'google.search_console', assetId: 101 },
        { grupoClinicaId: 5, clinicaId: 36, assetType: 'google.search_console', assetId: 999 },
        { grupoClinicaId: 5, clinicaId: 36, assetType: 'google.analytics', assetId: 299 },
        { grupoClinicaId: 5, clinicaId: 36, assetType: 'google.business_profile', assetId: 303 },
      ];
    },
  };
  const propertyModels = {
    search_console: {
      async findAll(options) {
        assert.equal(options.where.isActive, true);
        const idClause = findOrClauses(options.where).find((clause) => clause.id?.[Op.in]);
        assert.deepEqual(idClause.id[Op.in].sort(), [101, 999]);
        return [
          { id: 100, clinicaId: 36, siteUrl: 'sc-domain:propia.es', isActive: true, googleConnectionId: 1 },
          { id: 101, clinicaId: 35, siteUrl: 'sc-domain:compartida.es', isActive: true, googleConnectionId: 1, verified: 0 },
        ];
      },
    },
    analytics: {
      async findAll(options) {
        assert.equal(options.where.isActive, true);
        const idClause = findOrClauses(options.where).find((clause) => clause.id?.[Op.in]);
        assert.deepEqual(idClause.id[Op.in], [202]);
        return [{
          id: 202,
          clinicaId: 35,
          propertyName: 'properties/202',
          propertyDisplayName: 'GA4 grupo',
          isActive: true,
          googleConnectionId: 1,
        }];
      },
    },
    business_profile: {
      async findAll(options) {
        assert.equal(options.where.is_active, true);
        const idClause = findOrClauses(options.where).find((clause) => clause.id?.[Op.in]);
        assert.deepEqual(idClause.id[Op.in], [303]);
        return [
          { id: 304, clinica_id: 36, location_id: 'locations/304', is_active: true, google_connection_id: 1, is_verified: 1, is_suspended: 0 },
          { id: 303, clinica_id: 35, location_id: 'locations/303', is_active: true, google_connection_id: 1 },
        ];
      },
    },
  };

  const properties = await listScopedGoogleProperties(clinicScope, {
    groupModel,
    assignmentModel,
    propertyModels,
  });

  assert.deepEqual(properties.search_console.map((asset) => asset.mapping_id), [100, 101]);
  assert.deepEqual(properties.search_console.map((asset) => asset.assignment_origin), ['clinic', 'shared']);
  assert.equal(properties.search_console[1].verified, false);
  assert.ok(!properties.search_console.some((asset) => asset.mapping_id === 999));
  assert.deepEqual(properties.analytics.map((asset) => asset.mapping_id), [202]);
  assert.equal(properties.analytics[0].assignment_origin, 'group');
  assert.deepEqual(properties.business_profile.map((asset) => asset.mapping_id), [304, 303]);
  assert.deepEqual(properties.business_profile.map((asset) => asset.assignment_origin), ['clinic', 'shared']);
  assert.equal(properties.business_profile[0].verified, true);
  assert.equal(properties.business_profile[0].suspended, false);
}

async function testInventoryResolverIsReadOnly() {
  let connectionResolverCalls = 0;
  const inventory = await resolveEffectiveMarketingAssetInventory({
    clinicIdRaw: 36,
    groupIdRaw: null,
    assignmentScopeRaw: 'clinic',
  }, {
    async normalizeScope() {
      return { clinicId: 36, groupId: 5, assignmentScope: 'clinic' };
    },
    clinicModel: {
      async findAll() {
        return [{ id_clinica: 35 }, { id_clinica: 36 }];
      },
    },
    async loadScopeDescriptors() {
      return { clinic_name: 'Clínica 36', group_name: 'Grupo 5' };
    },
    async loadScopeIntakeRecords() {
      return { clinicRecord: null, groupRecord: null };
    },
    async listScopedMetaAssets() {
      return { ad_accounts: [], facebook_pages: [], instagram_business: [] };
    },
    async listScopedGoogleAccounts() {
      return [];
    },
    async listScopedGoogleProperties() {
      return {
        search_console: [{ mapping_id: 101, site_url: 'sc-domain:compartida.es' }],
        analytics: [],
        business_profile: [],
      };
    },
    async resolveMetaConnectionForScope() {
      connectionResolverCalls += 1;
    },
    async resolveGoogleConnectionForScope() {
      connectionResolverCalls += 1;
    },
  });

  assert.equal(connectionResolverCalls, 0);
  assert.equal(inventory.google.available_assets.search_console[0].mapping_id, 101);
  assert.ok(!Object.prototype.hasOwnProperty.call(inventory.google, 'connection'));
  assert.ok(!Object.prototype.hasOwnProperty.call(inventory.meta, 'connection'));
}

async function testReportsResolveReadOnlyAndKeepHistoricalAdsScope() {
  const reportScope = {
    scope: 'clinic',
    clinicIds: [36],
    groupId: null,
  };
  let resolverInput = null;
  const state = await __testing.resolveReportMarketingState(reportScope, {
    async resolveEffectiveMarketingAssetInventory(input) {
      resolverInput = input;
      return {
        google: {
          available_accounts: [
            { customer_id: '1112223333', last_synced_at: '2026-07-14T08:00:00.000Z' },
            { customer_id: '4445556666', last_synced_at: '2026-07-15T08:00:00.000Z' },
          ],
          available_assets: {
            search_console: [{ mapping_id: 41, clinic_id: 35, site_url: 'sc-domain:compartida.es' }],
            analytics: [{ mapping_id: 42, property_name: 'properties/42' }],
            business_profile: [{ mapping_id: 43, location_id: 'locations/43' }],
          },
        },
        meta: {
          available_assets: {
            ad_accounts: [{ ad_account_id: 'act_123' }],
            facebook_pages: [{ page_id: 'page-1', mapping_id: 31 }],
            instagram_business: [],
          },
        },
      };
    },
  });

  assert.deepEqual(resolverInput, {
    clinicIdRaw: 36,
    groupIdRaw: null,
    assignmentScopeRaw: 'clinic',
  });

  const googleWhere = __testing.buildGoogleAdsDataWhere(reportScope, state);
  assert.equal(googleWhere.clinicaId, 36);
  assert.ok(!Object.prototype.hasOwnProperty.call(googleWhere, 'customerId'));

  const metaWhere = __testing.buildMetaAdsDataWhere(reportScope, state);
  assert.equal(metaWhere.clinica_id, 36);
  assert.ok(!Object.prototype.hasOwnProperty.call(metaWhere, 'ad_account_id'));
  assert.deepEqual(__testing.effectiveSocialMappingIds(state), [31]);
  assert.deepEqual(__testing.effectiveSearchConsoleSiteUrls(state), ['sc-domain:compartida.es']);
  assert.deepEqual(__testing.effectiveAnalyticsMappingIds(state), [42]);
  assert.deepEqual(__testing.effectiveBusinessLocationIds(state), [43]);

  const sharedJobScope = __testing.scopeWithEffectiveAssetOwners(reportScope, [
    { clinic_id: 35 },
    { clinic_id: 36 },
  ]);
  assert.deepEqual(sharedJobScope.clinicIds, [36, 35]);

  const gaScope = __testing.buildHistoricalOrEffectiveWhere(reportScope, 'clinica_id', 'property_id', [42]);
  assert.equal(gaScope[Op.or][0].clinica_id, 36);
  assert.equal(gaScope[Op.or][1].property_id, 42);
  const seoScope = __testing.buildSearchConsoleDataWhere(reportScope, state);
  assert.equal(seoScope[Op.or][0].clinica_id, 36);
  assert.deepEqual(seoScope[Op.or][1], {
    clinica_id: 35,
    site_url: 'sc-domain:compartida.es',
  });
  assert.equal(__testing.latestEffectiveGoogleSync(state), '2026-07-15T08:00:00.000Z');

  const currentReviewScope = __testing.buildEffectiveSnapshotWhere(
    reportScope,
    'clinica_id',
    'business_location_id',
    [43]
  );
  assert.equal(currentReviewScope.business_location_id, 43);
  assert.ok(!currentReviewScope[Op.or], 'current snapshots must exclude old clinic mappings');

  const legacyReviewScope = __testing.buildEffectiveSnapshotWhere(
    reportScope,
    'clinica_id',
    'business_location_id',
    []
  );
  assert.equal(legacyReviewScope.clinica_id, 36);
}

async function testMultiScopeUnionsEffectiveAssetsByIdentity() {
  const calls = [];
  const state = await __testing.resolveReportMarketingState({
    scope: 'multi',
    clinicIds: [36, 37],
    groupId: null,
  }, {
    async resolveEffectiveMarketingAssetInventory(input) {
      calls.push(input);
      const second = input.clinicIdRaw === 37;
      return {
        tracking: {},
        google: {
          available_accounts: [{ customer_id: second ? '222' : '111' }],
          available_assets: {
            search_console: [{ mapping_id: 101, clinic_id: 35, site_url: 'sc-domain:shared.es' }],
            analytics: [{
              mapping_id: second ? 202 : 201,
              property_name: second ? 'properties/202' : 'properties/201',
            }],
            business_profile: [{ mapping_id: 301, location_id: 'locations/shared' }],
          },
        },
        meta: {
          available_assets: {
            ad_accounts: [{ ad_account_id: 'act_123' }],
            facebook_pages: [{ page_id: 'page-shared', mapping_id: 401 }],
            instagram_business: [],
          },
        },
      };
    },
    async resolveEffectiveMarketingState() {
      throw new Error('Informes no debe usar el resolver que puede persistir grants');
    },
  });

  assert.deepEqual(calls.map((call) => call.clinicIdRaw), [36, 37]);
  assert.equal(state.google.available_accounts.length, 2);
  assert.equal(state.google.available_assets.search_console.length, 1);
  assert.equal(state.google.available_assets.analytics.length, 2);
  assert.equal(state.google.available_assets.business_profile.length, 1);
  assert.equal(state.meta.available_assets.ad_accounts.length, 1);
  assert.equal(state.meta.available_assets.facebook_pages.length, 1);

  const canonicalGaScope = __testing.buildHistoricalOrEffectiveWhere(
    { scope: 'multi', clinicIds: [36, 37] },
    'clinica_id',
    'property_id',
    __testing.effectiveAnalyticsMappingIds(state)
  );
  assert.deepEqual(canonicalGaScope.property_id[Op.in], [201, 202]);
  assert.ok(!canonicalGaScope[Op.or]);
  const canonicalSeoScope = __testing.buildSearchConsoleDataWhere(
    { scope: 'multi', clinicIds: [36, 37] },
    state
  );
  assert.deepEqual(canonicalSeoScope[Op.or], [{
    clinica_id: 35,
    site_url: 'sc-domain:shared.es',
  }]);
  const replacements = {};
  const socialSql = __testing.scopedRawOrEffectiveSql(
    'p.clinica_id',
    { scope: 'multi', clinicIds: [36, 37] },
    replacements,
    'socialPostClinicIds',
    'p.asset_id',
    [401],
    'socialAssetIds'
  );
  assert.equal(socialSql, ' AND p.asset_id IN (:socialAssetIds)');
  assert.deepEqual(replacements, { socialAssetIds: [401] });
}

async function run() {
  await testExplicitlySharedGoogleAccountIsEffective();
  await testExplicitlySharedMetaProfilesAreEffective();
  await testGooglePropertiesResolveDirectSharedAndGroupPrimary();
  await testInventoryResolverIsReadOnly();
  await testReportsResolveReadOnlyAndKeepHistoricalAdsScope();
  await testMultiScopeUnionsEffectiveAssetsByIdentity();
  console.log('marketing_report_effective_assets.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
