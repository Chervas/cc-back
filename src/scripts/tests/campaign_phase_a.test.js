'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const db = require('../../../models');
const {
  clinicIdsFromStrategyRows,
  hasMarketingClinicScopeAccess,
  requestIdsFromRows,
} = require('../../lib/marketingScopeAccess');
const {
  CAMPAIGN_LEVEL_SEGMENT,
  buildCampaignLevelMetricsQuery,
  prepareCampaignLevelFallbackRows,
  shouldMarkGoogleAdsAccountSynced,
} = require('../../lib/googleAdsSyncHelpers');
const { ADMIN_ROLES, STAFF_ROLES } = require('../../lib/role-helpers');
const {
  createPinnedLookup,
  isUnsafeIpAddress,
  resolvePublicAddresses,
  resolveSafeHttpTarget,
} = require('../../lib/safeHttpTarget');
const { resolveEffectiveTrackingConfig } = require('../../services/effectiveMarketingAssets.service');

function controllerSection(source, exportName, nextExportName = null) {
  const start = source.indexOf(`exports.${exportName}`);
  assert.notEqual(start, -1, `Missing controller export ${exportName}`);
  const end = nextExportName
    ? source.indexOf(`exports.${nextExportName}`, start + 1)
    : source.length;
  assert.notEqual(end, -1, `Missing next controller export ${nextExportName}`);
  return source.slice(start, end);
}

async function testScopeAuthorization() {
  assert.deepEqual(
    clinicIdsFromStrategyRows([
      {
        clinica_id: 4,
        solicitud: { scope: { clinic_id: 4, clinic_ids: [4, 9, '9'] } },
      },
    ]),
    [4, 9]
  );
  assert.deepEqual(requestIdsFromRows([{ id: 12 }, { id: '13' }, { id: 12 }]), [12, 13]);

  let captured = null;
  const fullMembershipModel = {
    async findAll(options) {
      captured = options;
      return [{ id_clinica: 4 }, { id_clinica: 9 }];
    },
  };
  assert.equal(await hasMarketingClinicScopeAccess({
    userId: 77,
    clinicIds: [4, 9],
    access: 'read',
    membershipModel: fullMembershipModel,
    globalAdminCheck: () => false,
  }), true);
  assert.deepEqual(captured.where.rol_clinica[Op.in], STAFF_ROLES);

  const partialMembershipModel = {
    async findAll() {
      return [{ id_clinica: 4 }];
    },
  };
  assert.equal(await hasMarketingClinicScopeAccess({
    userId: 77,
    clinicIds: [4, 9],
    access: 'read',
    membershipModel: partialMembershipModel,
    globalAdminCheck: () => false,
  }), false, 'Every clinic in a multi-clinic strategy must be authorized');

  await hasMarketingClinicScopeAccess({
    userId: 77,
    clinicIds: [4],
    access: 'write',
    membershipModel: fullMembershipModel,
    globalAdminCheck: () => false,
  });
  assert.deepEqual(captured.where.rol_clinica[Op.in], ADMIN_ROLES);

  let queried = false;
  assert.equal(await hasMarketingClinicScopeAccess({
    userId: 1,
    clinicIds: [999],
    membershipModel: { async findAll() { queried = true; return []; } },
    globalAdminCheck: () => true,
  }), true);
  assert.equal(queried, false, 'Global admins must not require pivot memberships');
}

function testConnectOnlyConflictRegression() {
  const controllerPath = path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js');
  const source = fs.readFileSync(controllerPath, 'utf8');
  const update = controllerSection(
    source,
    'updateMarketingStrategy',
    'transitionMarketingStrategyStatus'
  );
  const create = controllerSection(source, 'createMarketingStrategy');

  const declarationIndex = update.indexOf('const targetClinicIds = clinicIdsFromStrategyRows(rows);');
  const conflictIndex = update.indexOf('findExternalCampaignAssignmentConflicts(targetClinicIds, externalTargets');
  assert.ok(declarationIndex >= 0 && declarationIndex < conflictIndex,
    'Update must define targetClinicIds before conflict detection');
  assert.match(update, /excludeRequestIds:\s*requestIdsFromRows\(rows\)/,
    'Update must exclude its own CampaignRequest rows');
  assert.doesNotMatch(create, /excludeRequestIds:\s*rows\.map/,
    'Create must not reference update-only rows');

  for (const [exportName, nextExportName, access] of [
    ['getMarketingStrategyDetail', 'getMarketingStrategyMetrics', 'read'],
    ['getMarketingStrategyMetrics', 'getMarketingStrategyAnalysisCampaign', 'read'],
    ['getMarketingStrategyAnalysisCampaign', 'updateMarketingStrategy', 'read'],
    ['updateMarketingStrategy', 'transitionMarketingStrategyStatus', 'write'],
    ['transitionMarketingStrategyStatus', 'createMarketingStrategy', 'write'],
  ]) {
    const section = controllerSection(source, exportName, nextExportName);
    assert.match(section, new RegExp(`requireMarketingClinicScope\\(req, res, clinicIdsFromStrategyRows\\(rows\\), '${access}'\\)`));
  }
  const onboarding = controllerSection(
    source,
    'getCampaignOnboardingStatus',
    'listMarketingStrategies'
  );
  assert.match(onboarding, /requireMarketingClinicScope\(req, res, onboardingClinicIds, 'read'\)/);
}

function testCampaignScopeAndWritableModesRegression() {
  const controllerPath = path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js');
  const source = fs.readFileSync(controllerPath, 'utf8');
  const pixels = controllerSection(source, 'listMetaPixels', 'listStrategyCatalog');
  const list = controllerSection(
    source,
    'listMarketingStrategies',
    'getMarketingStrategyAutomationRecommendation'
  );
  const start = controllerSection(
    source,
    'startCampaignOnboarding',
    'getCampaignOnboardingStatus'
  );
  const create = controllerSection(source, 'createMarketingStrategy');

  assert.match(pixels, /requireMarketingClinicScope\(req, res, scope\.clinic_ids, 'read'\)/,
    'Meta pixel discovery must require access to its clinic scope before using the stored provider token');
  assert.match(list, /requireMarketingClinicScope\(req, res, scope\.clinic_ids, 'read'\)/,
    'Strategy collection reads must be clinic scoped');
  assert.match(create, /requireMarketingClinicScope\(req, res, targetClinicIds, 'write'\)/,
    'Creating a strategy must require write access to every target clinic');

  assert.match(source, /const CREATABLE_MODES = new Set\(\['connect_only', 'managed_service'\]\)/);
  assert.match(start, /if \(!CREATABLE_MODES\.has\(mode\)\)/,
    'Historical managed_self must not be accepted by new onboarding writes');
  assert.match(create, /if \(!CREATABLE_MODES\.has\(effectiveMode\)\)/,
    'Historical managed_self must not create new strategies');

  const customerScopeCheck = start.indexOf("customerScopeError.code = 'CUSTOMER_NOT_ASSIGNED_TO_SCOPE'");
  const conversionEnsure = start.indexOf('ensureConversionActionsInternal({');
  assert.ok(customerScopeCheck >= 0 && customerScopeCheck < conversionEnsure,
    'Requested Google Ads customers must be checked against scoped assignments before listing or creating conversion actions');

  const scopedPixelLookup = start.indexOf('listMetaPixelsForScopeAdAccount({');
  const pixelScopeCheck = start.indexOf("pixelScopeError.code = 'PIXEL_NOT_ASSIGNED_TO_SCOPE'");
  const metaConfigWrite = start.indexOf('upsertIntakeMetaAdsForScope(scope, {');
  assert.ok(
    scopedPixelLookup >= 0
      && scopedPixelLookup < pixelScopeCheck
      && pixelScopeCheck < metaConfigWrite,
    'Requested Meta pixels must be resolved through the scoped ad account before persisting CAPI configuration'
  );
}

function testIntakeConfigScopeRegression() {
  const controllerPath = path.resolve(__dirname, '../../controllers/intake.controller.js');
  const source = fs.readFileSync(controllerPath, 'utf8');
  const upsert = controllerSection(source, 'upsertIntakeConfig', 'getIntakeConfigSecretClinic');
  const clinicSecret = controllerSection(source, 'getIntakeConfigSecretClinic', 'getIntakeConfigSecretGroup');
  const groupSecret = controllerSection(source, 'getIntakeConfigSecretGroup', 'verifySnippetInstalled');
  const verify = controllerSection(source, 'verifySnippetInstalled', 'registerWhatsappOrigin');

  assert.match(upsert, /requireIntakeConfigScopeAccess\(req, res, \{[\s\S]*access: 'write'[\s\S]*\}\)/,
    'Intake configuration writes must be scope authorized');
  assert.match(clinicSecret, /requireIntakeConfigScopeAccess\(req, res, \{ clinicId, access: 'read' \}\)/,
    'Clinic HMAC secrets must be scope authorized');
  assert.match(groupSecret, /requireIntakeConfigScopeAccess\(req, res, \{ groupId, access: 'read' \}\)/,
    'Group HMAC secrets must be scope authorized');
  assert.match(verify, /requireIntakeConfigScopeAccess\(req, res, \{ clinicId, groupId, access: 'read' \}\)/,
    'Real-site verification must be scope authorized');

  const accessHelperStart = source.indexOf('const requireIntakeConfigScopeAccess');
  const accessHelperEnd = source.indexOf('const countMojibakeMarkers', accessHelperStart);
  const accessHelper = source.slice(accessHelperStart, accessHelperEnd);
  assert.doesNotMatch(accessHelper, /else if \(groupId !== null\)/,
    'When both IDs are supplied, authorization must cover both clinic and group scopes');
  assert.match(accessHelper, /clinicIds\.push\(clinicId\)/);
  assert.match(accessHelper, /clinicIds\.push\(\.\.\.rows\.map/);
}

function testGoogleCampaignFallback() {
  const query = buildCampaignLevelMetricsQuery('2026-07-03', '2026-07-09');
  assert.match(query, /FROM campaign/);
  assert.match(query, /segments\.date BETWEEN '2026-07-03' AND '2026-07-09'/);
  assert.doesNotMatch(query, /PERFORMANCE_MAX/,
    'Campaign fallback must include SMART and every other campaign type');

  const processed = new Set(['100:2026-07-03']);
  const fallbackRows = prepareCampaignLevelFallbackRows([
    {
      campaign: { id: '100', name: 'Search with ad groups' },
      segments: { date: '2026-07-03' },
      metrics: { clicks: '2' },
    },
    {
      campaign: { id: '200', name: 'SMART without ad-group metrics' },
      segments: { date: '2026-07-03' },
      metrics: { clicks: '9' },
    },
  ], processed);

  assert.equal(fallbackRows.length, 1);
  assert.equal(fallbackRows[0].campaign.id, '200');
  assert.equal(fallbackRows[0].segments.adNetworkType, CAMPAIGN_LEVEL_SEGMENT);
  assert.equal(fallbackRows[0].segments.device, CAMPAIGN_LEVEL_SEGMENT);
  assert.equal(processed.has('200:2026-07-03'), true);
  assert.deepEqual(prepareCampaignLevelFallbackRows(fallbackRows, processed), []);

  assert.equal(shouldMarkGoogleAdsAccountSynced({ discoveredRows: 50 }), false);
  assert.equal(shouldMarkGoogleAdsAccountSynced({ persistedMetricsRows: 1 }), true);
  assert.equal(shouldMarkGoogleAdsAccountSynced({ persistedInventoryRows: 1 }), true);

  const syncJobsPath = path.resolve(__dirname, '../../jobs/sync.jobs.js');
  const syncJobsSource = fs.readFileSync(syncJobsPath, 'utf8');
  assert.doesNotMatch(syncJobsSource, /_fetchPerformanceMaxMetrics/);
  assert.match(syncJobsSource, /_fetchCampaignLevelMetrics/);
  assert.match(syncJobsSource, /ExternalCampaignInventory\.upsert/,
    'Provider sync must refresh the full campaign inventory automatically');
  assert.match(syncJobsSource, /campaignStatus\s*&&\s*campaignStatus\s*!==\s*'ENABLED'/,
    'Intentionally paused campaigns must not become account publishing incidents');
  assert.equal(
    (syncJobsSource.match(/if \(!shouldMarkGoogleAdsAccountSynced\(stats\)\)/g) || []).length,
    2,
    'Recent sync and backfill must both guard lastSyncedAt on persisted data'
  );
}

function testGoogleTrackingInheritance() {
  const groupGoogle = {
    enabled: true,
    customer_id: '599-235-6722',
    conversion_action_id: '7540337982',
    currency: 'EUR',
    events: {
      lead: {
        enabled: true,
        customer_id: '5992356722',
        conversion_action_id: '7540337982',
        send_to: 'AW-123/lead',
        currency: 'EUR',
      },
    },
  };
  const inherited = resolveEffectiveTrackingConfig({ assignment_scope: 'clinic' }, {
    groupRecord: { config: { google_ads: groupGoogle } },
    clinicRecord: { config: { meta_ads: { enabled: true } } },
  });
  assert.equal(inherited.google_ads.customer_id, '5992356722');
  assert.equal(inherited.google_ads.conversion_action_id, '7540337982');
  assert.equal(inherited.google_ads.events.lead.send_to, 'AW-123/lead');

  const partialOverride = resolveEffectiveTrackingConfig({ assignment_scope: 'clinic' }, {
    groupRecord: { config: { google_ads: groupGoogle } },
    clinicRecord: { config: { google_ads: { events: { lead: { send_to: 'AW-456/clinic-lead' } } } } },
  });
  assert.equal(partialOverride.google_ads.customer_id, '5992356722');
  assert.equal(partialOverride.google_ads.events.lead.customer_id, '5992356722');
  assert.equal(partialOverride.google_ads.events.lead.conversion_action_id, '7540337982');
  assert.equal(partialOverride.google_ads.events.lead.send_to, 'AW-456/clinic-lead');
}

async function testSafeHttpTargets() {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.2',
    '203.0.113.8', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1',
    'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '3fff::1',
  ]) {
    assert.equal(isUnsafeIpAddress(address), true, `${address} must not be reachable by the verifier`);
  }
  assert.equal(isUnsafeIpAddress('8.8.8.8'), false);
  assert.equal(isUnsafeIpAddress('1.1.1.1'), false);
  assert.equal(isUnsafeIpAddress('2606:4700:4700::1111'), false);
  assert.equal(isUnsafeIpAddress('2001:4860:4860::8888'), false);

  await assert.rejects(
    resolvePublicAddresses('mixed.example', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    }),
    (error) => error?.code === 'UNSAFE_TARGET_ADDRESS'
  );

  const safeTarget = await resolveSafeHttpTarget('https://public.example/path', {
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
  });
  assert.deepEqual(safeTarget.addresses, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  assert.equal(safeTarget.httpAgent.options.keepAlive, false);
  assert.equal(safeTarget.httpsAgent.options.keepAlive, false);

  const pinnedLookup = createPinnedLookup('public.example', safeTarget.addresses);
  const pinnedAll = await new Promise((resolve, reject) => {
    pinnedLookup('public.example', { all: true }, (error, addresses) => (
      error ? reject(error) : resolve(addresses)
    ));
  });
  assert.deepEqual(pinnedAll, safeTarget.addresses);
  await assert.rejects(new Promise((resolve, reject) => {
    pinnedLookup('rebound.example', {}, (error, address) => (
      error ? reject(error) : resolve(address)
    ));
  }), (error) => error?.code === 'PINNED_HOST_MISMATCH');
  safeTarget.httpAgent.destroy();
  safeTarget.httpsAgent.destroy();

  const intakePath = path.resolve(__dirname, '../../controllers/intake.controller.js');
  const intakeSource = fs.readFileSync(intakePath, 'utf8');
  const verify = controllerSection(intakeSource, 'verifySnippetInstalled', 'registerWhatsappOrigin');
  assert.match(verify, /resolveSafeHttpTarget\(currentUrl\)/);
  assert.match(verify, /maxRedirects:\s*0/);
  assert.match(verify, /httpAgent:\s*safeTarget\.httpAgent/);
  assert.match(verify, /httpsAgent:\s*safeTarget\.httpsAgent/);
  assert.match(verify, /proxy:\s*false/);
  assert.doesNotMatch(verify, /host === 'localhost'|host === '127\.0\.0\.1'/,
    'Runtime inspection must never re-enable localhost as an official asset host');
  assert.equal((verify.match(/maxRedirects:\s*0/g) || []).length, 2,
    'Both page HTML and runtime script requests must validate redirects manually');
}

async function run() {
  await testScopeAuthorization();
  testConnectOnlyConflictRegression();
  testCampaignScopeAndWritableModesRegression();
  testIntakeConfigScopeRegression();
  testGoogleCampaignFallback();
  testGoogleTrackingInheritance();
  await testSafeHttpTargets();
  console.log('campaign_phase_a.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
