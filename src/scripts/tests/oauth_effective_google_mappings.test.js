'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildEffectiveGoogleMappings,
  listScopedGoogleAccounts,
  resolveEffectiveGoogleMappings,
} = require('../../services/effectiveMarketingAssets.service');

function inventoryFixture(scope = {
  assignment_scope: 'clinic',
  clinic_id: 36,
  group_id: 5,
  clinic_ids: [19, 35, 36, 58],
}) {
  return {
    scope,
    descriptors: {
      clinic_name: scope.clinic_id ? 'Propdental Francia' : null,
      group_name: 'Propdental',
    },
    google: {
      available_accounts: [
        {
          mapping_id: 20,
          customer_id: '1851215478',
          formatted_customer_id: '185-121-5478',
          descriptive_name: 'Cuenta propia',
          assignment_origin: 'clinic',
          clinic_id: 36,
          group_id: 5,
          connection_id: 23,
        },
        {
          mapping_id: 12,
          customer_id: '5992356722',
          formatted_customer_id: '599-235-6722',
          descriptive_name: 'Cuenta del grupo',
          assignment_origin: 'group',
          clinic_id: 58,
          group_id: 5,
          connection_id: 23,
        },
      ],
      available_assets: {
        search_console: [{
          mapping_id: 10,
          site_url: 'sc-domain:propdental.es',
          assignment_origin: 'shared',
          clinic_id: 35,
          connection_id: 23,
        }],
        analytics: [{
          mapping_id: 7,
          property_name: 'properties/7',
          display_name: 'GA4 de clínica',
          assignment_origin: 'clinic',
          clinic_id: 36,
          connection_id: 23,
        }],
        business_profile: [{
          mapping_id: 9,
          location_id: 'locations/9',
          name: 'Perfil del grupo',
          assignment_origin: 'group',
          clinic_id: 35,
          connection_id: 23,
        }],
      },
    },
  };
}

async function testOneInventoryProducesFourReadOnlySections() {
  const params = { clinicIdRaw: 36, groupIdRaw: null, assignmentScopeRaw: 'clinic' };
  let inventoryCalls = 0;
  const result = await resolveEffectiveGoogleMappings(params, {
    async resolveEffectiveMarketingAssetInventory(receivedParams) {
      inventoryCalls += 1;
      assert.deepEqual(receivedParams, params);
      return inventoryFixture();
    },
  });

  assert.equal(inventoryCalls, 1, 'the endpoint projection must resolve one canonical inventory only');
  assert.deepEqual(Object.keys(result.effective_mappings).sort(), [
    'analytics',
    'business_profile',
    'google_ads',
    'search_console',
  ]);

  const ownAccount = result.effective_mappings.google_ads[0];
  assert.equal(ownAccount.assignment_origin, 'clinic');
  assert.equal(ownAccount.inherited, false);
  assert.equal(ownAccount.read_only, true);
  assert.equal(ownAccount.target_clinic_id, 36);
  assert.equal(ownAccount.owner_clinic_id, 36);

  const inheritedAccount = result.effective_mappings.google_ads[1];
  assert.equal(inheritedAccount.assignment_origin, 'group');
  assert.equal(inheritedAccount.inherited, true);
  assert.equal(inheritedAccount.target_clinic_id, 36);
  assert.equal(inheritedAccount.owner_clinic_id, 58);
  assert.deepEqual(inheritedAccount.source_scope, {
    type: 'group',
    clinic_id: null,
    group_id: 5,
    group_name: 'Propdental',
  });

  const sharedSearchConsole = result.effective_mappings.search_console[0];
  assert.equal(sharedSearchConsole.assignment_origin, 'shared');
  assert.equal(sharedSearchConsole.inherited, true);
  assert.equal(sharedSearchConsole.target_clinic_id, 36);
  assert.equal(sharedSearchConsole.owner_clinic_id, 35);
  assert.equal(sharedSearchConsole.source_scope.type, 'shared');
  assert.equal(sharedSearchConsole.source_scope.clinic_id, 35);

  const groupProfile = result.effective_mappings.business_profile[0];
  assert.equal(groupProfile.inherited, true);
  assert.equal(groupProfile.source_scope.group_name, 'Propdental');
}

function testGroupScopeHasNoSyntheticClinicTarget() {
  const result = buildEffectiveGoogleMappings(inventoryFixture({
    assignment_scope: 'group',
    clinic_id: null,
    group_id: 5,
    clinic_ids: [19, 35, 36, 58],
  }));
  assert.ok(result.effective_mappings.google_ads.length > 0);
  assert.ok(result.effective_mappings.google_ads.every((asset) => asset.target_clinic_id === null));
  const groupAccount = result.effective_mappings.google_ads.find((asset) => (
    asset.assignment_origin === 'group'
  ));
  assert.equal(groupAccount.inherited, false, 'a group asset is native when the requested scope is the group');
  assert.equal(result.effective_mappings.search_console[0].inherited, true,
    'an explicitly shared asset remains marked as shared in a group inventory');
}

async function testGoogleAdsCustomerIdFormattingKeepsAllDigits() {
  const accounts = await listScopedGoogleAccounts({
    assignment_scope: 'clinic',
    clinic_id: 36,
    group_id: 5,
    clinic_ids: [36],
  }, {
    assignmentModel: { findAll: async () => [] },
    accountModel: {
      findAll: async () => [{
        id: 20,
        customerId: '1851215478',
        clinicaId: 36,
        grupoClinicaId: 5,
        googleConnectionId: 23,
        assignmentScope: 'clinic',
        isActive: true,
      }],
    },
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].customer_id, '1851215478');
  assert.equal(accounts[0].formatted_customer_id, '185-121-5478');
}

function testRouteIsExplicitScopeReadOnlyAndAdditive() {
  const routePath = path.resolve(__dirname, '../../routes/oauth.routes.js');
  const source = fs.readFileSync(routePath, 'utf8');
  const providerPaths = source.slice(
    source.indexOf('const PROVIDER_INVENTORY_PATHS'),
    source.indexOf('const EXPLICIT_SCOPE_REQUIRED_PATHS')
  );
  const explicitPaths = source.slice(
    source.indexOf('const EXPLICIT_SCOPE_REQUIRED_PATHS'),
    source.indexOf('const PUBLIC_OAUTH_PATHS')
  );
  assert.doesNotMatch(providerPaths, /google\/effective-mappings/,
    'the DB-only endpoint must not inherit provider-inventory write authorization');
  assert.match(explicitPaths, /google\/effective-mappings/,
    'the DB-only endpoint must reject requests without an explicit scope');

  const route = source.slice(
    source.indexOf("router.get('/google/effective-mappings'"),
    source.indexOf('/**', source.indexOf("router.get('/google/effective-mappings'") + 1)
  );
  assert.match(route, /resolveEffectiveGoogleMappings\(getScopeInputFromRequest\(req\)\)/);
  assert.doesNotMatch(route, /axios|googleAdsRequest|ensureGoogle|\.update\(|\.create\(|upsert|destroy/,
    'the effective endpoint must remain DB-only and mutation-free');

  for (const physicalPath of [
    "router.get('/google/mappings'",
    "router.get('/google/analytics/mappings'",
    "router.get('/google/local/mappings'",
    "router.get('/google/ads/mappings'",
  ]) {
    assert.ok(source.includes(physicalPath), `${physicalPath} must remain available for editable mappings`);
  }
}

async function run() {
  await testOneInventoryProducesFourReadOnlySections();
  testGroupScopeHasNoSyntheticClinicTarget();
  await testGoogleAdsCustomerIdFormattingKeepsAllDigits();
  testRouteIsExplicitScopeReadOnlyAndAdditive();
  console.log('oauth effective google mappings tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
