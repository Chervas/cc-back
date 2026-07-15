'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const campaignOnboarding = require('../../controllers/campaignOnboarding.controller').__test;
const webAccess = require('../../routes/web.routes').__test;

const CLINIC_SCOPE = {
  assignment_scope: 'clinic',
  clinic_id: 36,
  group_id: 5,
  clinic_ids: [36]
};

async function testGoogleCampaignUsesExactMappedGrant() {
  let loadedConnectionIds = [];
  const connectionModel = {
    async findByPk(id) {
      loadedConnectionIds.push(id);
      return { id, accessToken: `google-token-${id}` };
    }
  };
  const accountModel = {
    async findAll({ where }) {
      if (where.customerId === '1111111111') {
        return [
          { id: 1, clinicaId: 36, googleConnectionId: 11, customerId: where.customerId },
          { id: 2, clinicaId: 36, googleConnectionId: 22, customerId: where.customerId }
        ];
      }
      return [
        { id: 3, grupoClinicaId: 5, assignmentScope: 'group', googleConnectionId: 22, customerId: where.customerId },
        { id: 4, clinicaId: 36, assignmentScope: 'clinic', googleConnectionId: 11, customerId: where.customerId }
      ];
    }
  };

  const ambiguous = await campaignOnboarding.resolveGoogleCampaignMappingAccess({
    scope: CLINIC_SCOPE,
    customerId: '111-111-1111',
    accountModel,
    connectionModel
  });
  assert.equal(ambiguous.connection, null);
  assert.equal(ambiguous.reason, 'google_ads_account_mapping_ambiguous');
  assert.deepEqual(loadedConnectionIds, [], 'An ambiguous account must not load or use either token');

  const directOverride = await campaignOnboarding.resolveGoogleCampaignMappingAccess({
    scope: CLINIC_SCOPE,
    customerId: '222-222-2222',
    accountModel,
    connectionModel
  });
  assert.equal(directOverride.account.googleConnectionId, 11);
  assert.equal(directOverride.connection.accessToken, 'google-token-11');
  assert.deepEqual(loadedConnectionIds, [11]);
}

async function testMetaCampaignsAreBatchedByMappedGrant() {
  const { accountMap, authorizationIssues } = campaignOnboarding.buildMetaAccountConnectionMap([
    { metaAssetId: '100', metaConnectionId: 101, grupoClinicaId: 5, assignmentScope: 'group' },
    { metaAssetId: '100', metaConnectionId: 111, clinicaId: 36, assignmentScope: 'clinic' },
    { metaAssetId: '200', metaConnectionId: 202, clinicaId: 36, assignmentScope: 'clinic' },
    { metaAssetId: '300', metaConnectionId: 303, clinicaId: 36, assignmentScope: 'clinic' }
  ], CLINIC_SCOPE);
  assert.equal(accountMap.get('act_100').metaConnectionId, 111, 'Clinic override must beat inherited group mapping');
  assert.equal(accountMap.get('act_200').metaConnectionId, 202);
  assert.deepEqual(authorizationIssues, []);

  const providerCalls = [];
  const future = new Date('2099-01-01T00:00:00.000Z');
  const connectionModel = {
    async findByPk(id) {
      if (id === 303) {
        return { id, accessToken: 'expired-token', expiresAt: new Date('2020-01-01T00:00:00.000Z') };
      }
      return { id, accessToken: `meta-token-${id}`, expiresAt: future };
    }
  };
  const campaigns = [
    { account_id: 'act_100', external_campaign_id: 'campaign-a' },
    { account_id: '200', external_campaign_id: 'campaign-b' },
    { account_id: 'act_300', external_campaign_id: 'campaign-expired' },
    { account_id: 'act_999', external_campaign_id: 'campaign-unmapped' }
  ];
  const result = await campaignOnboarding.enrichMetaCampaignsWithMappedConnections({
    campaigns,
    metaAccountMap: accountMap,
    campaignAdRows: new Map(),
    connectionModel,
    nowMs: new Date('2026-07-15T00:00:00.000Z').getTime(),
    enrich: async ({ campaigns: batch, accessToken }) => {
      providerCalls.push({
        accessToken,
        campaignIds: batch.map((item) => item.external_campaign_id)
      });
      return batch.map((item) => ({ ...item, enriched_with: accessToken }));
    }
  });

  assert.deepEqual(providerCalls, [
    { accessToken: 'meta-token-111', campaignIds: ['campaign-a'] },
    { accessToken: 'meta-token-202', campaignIds: ['campaign-b'] }
  ]);
  assert.equal(result.campaigns[0].enriched_with, 'meta-token-111');
  assert.equal(result.campaigns[1].enriched_with, 'meta-token-202');
  assert.equal(result.campaigns[2].enriched_with, undefined);
  assert.equal(result.campaigns[3].enriched_with, undefined);
  assert.ok(result.authorizationIssues.some((item) => (
    item.campaign_id === 'campaign-expired' && item.reason === 'meta_mapping_token_expired'
  )));
  assert.ok(result.authorizationIssues.some((item) => (
    item.campaign_id === 'campaign-unmapped' && item.reason === 'meta_account_mapping_connection_missing'
  )));
}

async function testWebMappingsUseTheirOwnConnectionTokens() {
  const loadedConnectionIds = [];
  const connectionModel = {
    async findByPk(id) {
      loadedConnectionIds.push(id);
      if (id === 33) {
        return {
          id,
          accessToken: 'expired',
          refreshToken: null,
          expiresAt: new Date('2020-01-01T00:00:00.000Z')
        };
      }
      return {
        id,
        accessToken: `web-token-${id}`,
        refreshToken: null,
        expiresAt: new Date('2099-01-01T00:00:00.000Z')
      };
    }
  };
  const tokenCache = new Map();
  const dependencies = {
    connectionModel,
    nowMs: new Date('2026-07-15T00:00:00.000Z').getTime()
  };
  const first = await webAccess.getAccessTokenForWebMapping(
    { siteUrl: 'sc-domain:first.test', googleConnectionId: 11 },
    tokenCache,
    dependencies
  );
  const second = await webAccess.getAccessTokenForWebMapping(
    { siteUrl: 'sc-domain:second.test', googleConnectionId: 22 },
    tokenCache,
    dependencies
  );
  const firstAgain = await webAccess.getAccessTokenForWebMapping(
    { siteUrl: 'https://first.test/', googleConnectionId: 11 },
    tokenCache,
    dependencies
  );
  assert.equal(first.accessToken, 'web-token-11');
  assert.equal(second.accessToken, 'web-token-22');
  assert.equal(firstAgain.accessToken, 'web-token-11');
  assert.deepEqual(loadedConnectionIds, [11, 22], 'Token cache must be keyed by exact connection id');
  await assert.rejects(
    () => webAccess.getAccessTokenForWebMapping(
      { siteUrl: 'sc-domain:expired.test', googleConnectionId: 33 },
      tokenCache,
      dependencies
    ),
    (error) => error.code === 'web_mapping_token_expired'
  );

  let capturedInventoryInput = null;
  const mappings = await webAccess.getClinicSiteMappings(36, {
    inventoryResolver: async (input) => {
      capturedInventoryInput = input;
      return {
        google: {
          available_assets: {
            search_console: [
              { site_url: 'sc-domain:first.test', connection_id: 11, assignment_origin: 'clinic' },
              { site_url: 'sc-domain:second.test', connection_id: 22, assignment_origin: 'shared' }
            ]
          }
        }
      };
    }
  });
  assert.equal(mappings.length, 2);
  assert.equal(mappings[1].assignmentOrigin, 'shared');
  assert.deepEqual(capturedInventoryInput, {
    clinicIdRaw: 36,
    groupIdRaw: null,
    assignmentScopeRaw: 'clinic'
  });
}

function testConsumersWireExactMappingAccess() {
  const webSource = fs.readFileSync(path.resolve(__dirname, '../../routes/web.routes.js'), 'utf8');
  const pagesStart = webSource.indexOf("router.get('/clinica/:clinicaId/sc/pages'");
  const psiStart = webSource.indexOf("router.get('/clinica/:clinicaId/psi/latest'", pagesStart);
  const pagesBody = webSource.slice(pagesStart, psiStart);
  assert.match(pagesBody, /getAccessTokenForWebMapping\(mapping, tokenCache\)/);
  assert.doesNotMatch(pagesBody, /getGoogleAccessToken\(/);
  assert.match(webSource, /getAccessTokenForWebMapping\(primaryMapping\)/);

  const syncSource = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  const syncStart = syncSource.indexOf('async executeWebSync(options = {})');
  const syncEnd = syncSource.indexOf('async executeWebBackfill()', syncStart);
  const syncBody = syncSource.slice(syncStart, syncEnd);
  assert.match(syncBody, /tokenByConnectionId/);
  assert.match(syncBody, /authorizedMappings\.push/);
  assert.match(syncBody, /phase: 'authorization'/);
  assert.doesNotMatch(syncBody, /findByPk\(arr\[0\]\.googleConnectionId\)/);

  const onboardingSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8'
  );
  const onboardingStart = onboardingSource.indexOf('exports.startCampaignOnboarding');
  const onboardingEnd = onboardingSource.indexOf('exports.getCampaignOnboardingStatus', onboardingStart);
  const onboardingBody = onboardingSource.slice(onboardingStart, onboardingEnd);
  assert.match(onboardingBody, /resolveGoogleCampaignMappingAccess/);
  assert.match(onboardingBody, /resolveMetaCampaignMappingAccess/);
  assert.doesNotMatch(onboardingBody, /resolveGoogleConnectionForScope/);
  assert.doesNotMatch(onboardingBody, /resolveMetaConnectionForScope/);

  const bootstrapStart = onboardingSource.indexOf('exports.getCampaignOnboardingBootstrap');
  const bootstrapEnd = onboardingSource.indexOf('exports.listMarketingStrategies', bootstrapStart);
  const bootstrapBody = onboardingSource.slice(bootstrapStart, bootstrapEnd);
  assert.match(bootstrapBody, /summarizeGoogleMappedAccountAccess/);
  assert.match(bootstrapBody, /resolveMetaCampaignMappingAccess/);
  assert.doesNotMatch(bootstrapBody, /resolveGoogleConnectionForScope|resolveMetaConnectionForScope/);

  const gateStart = onboardingSource.indexOf('exports.gateEnhancedConversionsActivation');
  const gateEnd = onboardingSource.indexOf('exports.startCampaignOnboarding', gateStart);
  const gateBody = onboardingSource.slice(gateStart, gateEnd);
  assert.match(gateBody, /summarizeGoogleMappedAccountAccess/);
  assert.doesNotMatch(gateBody, /resolveGoogleConnectionForScope/);
}

async function main() {
  await testGoogleCampaignUsesExactMappedGrant();
  await testMetaCampaignsAreBatchedByMappedGrant();
  await testWebMappingsUseTheirOwnConnectionTokens();
  testConsumersWireExactMappingAccess();
  console.log('oauth_multigrant_consumers.test.js: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
