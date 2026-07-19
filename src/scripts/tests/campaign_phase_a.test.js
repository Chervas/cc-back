'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const db = require('../../../models');
const {
  clinicIdsFromStrategyRows,
  getAccessibleMarketingClinicIds,
  hasMarketingClinicScopeAccess,
  requestIdsFromRows,
} = require('../../lib/marketingScopeAccess');
const {
  CAMPAIGN_LEVEL_SEGMENT,
  buildCampaignLevelMetricsQuery,
  prepareCampaignLevelFallbackRows,
  shouldMarkGoogleAdsAccountSynced,
} = require('../../lib/googleAdsSyncHelpers');
const { MARKETING_WRITE_ROLES, STAFF_ROLES } = require('../../lib/role-helpers');
const {
  createPinnedLookup,
  isUnsafeIpAddress,
  publicHttpUrl,
  resolvePublicAddresses,
  resolveSafeHttpTarget,
} = require('../../lib/safeHttpTarget');
const { resolveEffectiveTrackingConfig } = require('../../services/effectiveMarketingAssets.service');
const {
  configuredLocationsWithinAllowedScope,
  parseIntakeId,
  restrictAvailableLocationsToConfigured,
  resolveIntakeLocationVisibility,
} = require('../../lib/intakeLocations');

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
  assert.deepEqual(await getAccessibleMarketingClinicIds({
    userId: 77,
    clinicIds: [4, 9],
    access: 'read',
    membershipModel: partialMembershipModel,
    globalAdminCheck: () => false,
  }), [4], 'Scoped DTOs must be able to filter candidates to accessible clinics');

  await hasMarketingClinicScopeAccess({
    userId: 77,
    clinicIds: [4],
    access: 'write',
    membershipModel: fullMembershipModel,
    globalAdminCheck: () => false,
  });
  assert.deepEqual(captured.where.rol_clinica[Op.in], MARKETING_WRITE_ROLES);

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
  const transition = controllerSection(source, 'transitionMarketingStrategyStatus', 'createMarketingStrategy');

  const declarationIndex = update.indexOf('const targetClinicIds = clinicIdsFromStrategyRows(rows);');
  const conflictIndex = update.indexOf('findExternalCampaignAssignmentConflicts(targetClinicIds, externalTargets');
  assert.ok(declarationIndex >= 0 && declarationIndex < conflictIndex,
    'Update must define targetClinicIds before conflict detection');
  assert.match(update, /excludeRequestIds:\s*requestIdsFromRows\(rows\)/,
    'Update must exclude its own CampaignRequest rows');
  assert.doesNotMatch(create, /excludeRequestIds:\s*rows\.map/,
    'Create must not reference update-only rows');
  assert.doesNotMatch(update, /updateManagedCampaignSpecsFromStrategy|ManagedCampaign\.update/,
    'Legacy strategy edits must not rewrite the managed campaign source of truth');
  assert.doesNotMatch(update, /effectiveMode\s*===\s*'connect_only'[\s\S]{0,80}\?\s*'active'/,
    'Editing a connect_only draft must not activate it without the readiness transition');
  assert.match(update, /const currentStatus = normalizeStrategyStatus\(currentPayload\.status \|\| representative\.estado\)/,
    'Strategy edits must preserve the current lifecycle status');
  assert.doesNotMatch(transition, /ManagedCampaign\.update/,
    'Legacy strategy lifecycle must not bypass managed campaign gates');
  assert.match(create, /provisionManagedCampaignsFromStrategy\(/,
    'Initial managed_service creation must still provision its managed specs once');
  const provisioningSource = fs.readFileSync(
    path.resolve(__dirname, '../../services/managedCampaignProvisioning.service.js'),
    'utf8'
  );
  assert.doesNotMatch(provisioningSource, /updateManagedCampaignSpecsFromStrategy/);
  assert.match(provisioningSource, /provisionManagedCampaignsFromStrategy/);

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
  const update = controllerSection(
    source,
    'updateMarketingStrategy',
    'transitionMarketingStrategyStatus'
  );
  const create = controllerSection(source, 'createMarketingStrategy');

  assert.match(pixels, /requireMarketingClinicScope\(req, res, scope\.clinic_ids, 'read'\)/,
    'Meta pixel discovery must require access to its clinic scope before using the stored provider token');
  assert.match(list, /requireMarketingClinicScope\(req, res, scope\.clinic_ids, 'read'\)/,
    'Strategy collection reads must be clinic scoped');
  assert.match(create, /requireMarketingClinicScope\(req, res, targetClinicIds, 'write'\)/,
    'Creating a strategy must require write access to every target clinic');

  assert.match(source, /const CREATABLE_MODES = new Set\(\[[\s\S]*CAMPAIGN_MODES\.MEASURE,[\s\S]*CAMPAIGN_MODES\.IMPROVE,[\s\S]*CAMPAIGN_MODES\.AUTOPILOT[\s\S]*\]\)/);
  assert.match(start, /if \(!CREATABLE_MODES\.has\(mode\)\)/,
    'Historical managed_self must not be accepted by new onboarding writes');
  assert.match(start, /error:\s*'consent_readiness_pending'/,
    'Every onboarding provider must pass the privacy readiness gate before start');
  assert.match(create, /if \(!CREATABLE_MODES\.has\(effectiveMode\)\)/,
    'Historical managed_self must not create new strategies');
  assert.match(update, /if \(effectiveMode === CAMPAIGN_MODES\.LEGACY_SELF_MANAGED\)/,
    'Historical managed_self must be rejected before any strategy update');
  assert.match(update, /status\(409\)[\s\S]*error:\s*'legacy_mode_read_only'/,
    'Historical managed_self updates must return the stable read-only conflict');
  assert.ok(
    update.indexOf('effectiveMode === CAMPAIGN_MODES.LEGACY_SELF_MANAGED')
      < update.indexOf('normalizeStrategyTreatments('),
    'The legacy read-only guard must run before mutation input is normalized'
  );

  const customerScopeCheck = start.indexOf("customerScopeError.code = 'CUSTOMER_NOT_ASSIGNED_TO_SCOPE'");
  const conversionEnsure = start.indexOf('evaluateGoogleConversionOnboardingReadiness({');
  assert.ok(customerScopeCheck >= 0 && customerScopeCheck < conversionEnsure,
    'Requested Google Ads customers must be checked against scoped assignments before listing or creating conversion actions');

  const transition = controllerSection(source, 'transitionMarketingStrategyStatus', 'createMarketingStrategy');
  assert.match(transition, /if \(strategy\?\.mode === CAMPAIGN_MODES\.LEGACY_SELF_MANAGED\)/,
    'Historical managed_self must be rejected before any lifecycle transition');
  assert.match(transition, /status\(409\)[\s\S]*error:\s*'legacy_mode_read_only'/,
    'Historical managed_self transitions must return the stable read-only conflict');
  assert.ok(
    transition.indexOf('strategy?.mode === CAMPAIGN_MODES.LEGACY_SELF_MANAGED')
      < transition.indexOf('const currentStatus = normalizeStrategyStatus(strategy?.status)'),
    'The legacy read-only guard must run before status/readiness processing'
  );
  assert.ok(
    transition.indexOf('strategy?.mode === CAMPAIGN_MODES.LEGACY_SELF_MANAGED')
      < transition.indexOf('CampaignRequest.update({'),
    'The legacy read-only guard must run before lifecycle persistence'
  );
  const consentGate = transition.indexOf("error: 'consent_readiness_pending'");
  const googleGate = transition.indexOf('if (strategyPayloadUsesGoogleAds(strategyPayload))');
  assert.ok(consentGate >= 0 && googleGate > consentGate,
    'Consent readiness must gate Meta/web activation independently, before the optional Google gate');

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
  assert.match(upsert, /configuredLocationsWithinAllowedScope\(configuredLocations, allowedLocationClinicIds\)/,
    'Both root and nested config locations must be checked after payload merging');
  assert.match(upsert, /rebuildTrustedSnippetVerification\(/,
    'Client-provided verification summaries must be rebuilt from signed attestations');
  assert.doesNotMatch(upsert, /verified:\s*!!body\.snippet_verification\.verified/,
    'The intake upsert must not persist a client-forged verified flag');
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

function testPublicIntakeLocationsRespectConfiguredSubset() {
  const available = [
    { id: 60, label: 'Clinica test reseñas', phone: '600000000' },
    { id: 58, label: 'Propdental Badalona', phone: '611111111' },
    { id: 19, label: 'Propdental Sants', phone: '622222222' },
    { id: 36, label: 'Propdental Francia', phone: '633333333' },
  ];
  const configured = [
    { id: '19', label: 'Sants' },
    { clinic_id: 58, label: 'Badalona' },
    { id: '999', label: 'Stale location' },
    { id: 19, label: 'Duplicate Sants' },
  ];

  assert.deepEqual(
    restrictAvailableLocationsToConfigured(available, configured),
    [available[2], available[1]],
    'Public intake must expose only configured locations, in configured order',
  );
  assert.equal(
    restrictAvailableLocationsToConfigured(available, []).length,
    0,
    'Public group intake must expose no location until an explicit subset is configured',
  );
  assert.equal(
    configuredLocationsWithinAllowedScope(configured, [19, 58]),
    false,
    'Stale or out-of-scope configured locations must be rejected on write',
  );
  assert.equal(
    configuredLocationsWithinAllowedScope(configured.slice(0, 2), [19, 58]),
    true,
    'Configured aliases are accepted when every location is in the writable scope',
  );
  assert.equal(
    configuredLocationsWithinAllowedScope([], [19, 58]),
    true,
    'Clearing the configured location subset remains valid',
  );
  assert.deepEqual(
    resolveIntakeLocationVisibility(available, [], { clinicId: 36 }),
    {
      availableLocations: [available[3]],
      configuredLocations: [{ id: 36 }],
    },
    'An empty clinic config must fall back only to that clinic before editor normalization',
  );
  assert.deepEqual(
    resolveIntakeLocationVisibility(available, [], { clinicId: null }),
    { availableLocations: [], configuredLocations: [] },
    'An empty group config must not expand to the full editor directory',
  );
  assert.deepEqual(
    resolveIntakeLocationVisibility(available, [], { includeAllLocations: true, clinicId: 36 }),
    { availableLocations: available, configuredLocations: [] },
    'The authenticated editor may still receive all candidates for selection',
  );
  assert.deepEqual(
    resolveIntakeLocationVisibility(available, configured, {
      includeAllLocations: true,
      clinicId: 36,
      allowedClinicIds: [36, 19],
    }),
    {
      availableLocations: [available[2], available[3]],
      configuredLocations: [configured[0], configured[3]],
    },
    'The editor DTO must remove candidates and selected locations outside user scope',
  );

  const controllerPath = path.resolve(__dirname, '../../controllers/intake.controller.js');
  const controllerSource = fs.readFileSync(controllerPath, 'utf8');
  assert.match(controllerSource, /resolveIntakeLocationVisibility\([\s\S]*payload\.locations[\s\S]*includeAllLocations/,
    'The public controller must decide visibility from the persisted subset before normalization');
  assert.match(controllerSource, /exports\.getIntakeConfigAdmin[\s\S]*requireIntakeConfigScopeAccess\(req, res, \{[\s\S]*access: 'read'/,
    'The full editor DTO must require authenticated scope access');
  assert.match(controllerSource, /clinicId !== null && groupId !== null[\s\S]*ambiguous_scope/,
    'The editor DTO must reject mixed clinic and group scopes');

  const routePath = path.resolve(__dirname, '../../routes/intake.routes.js');
  const routeSource = fs.readFileSync(routePath, 'utf8');
  const publicConfigRoute = routeSource.indexOf("router.get('/config',");
  const protectBoundary = routeSource.indexOf('router.use(protect)');
  const adminConfigRoute = routeSource.indexOf("router.get('/config/admin',");
  assert.ok(publicConfigRoute >= 0 && publicConfigRoute < protectBoundary);
  assert.ok(adminConfigRoute > protectBoundary,
    'The editor config route must be registered behind auth middleware');

  const appPath = path.resolve(__dirname, '../../app.js');
  const appSource = fs.readFileSync(appPath, 'utf8');
  assert.doesNotMatch(appSource, /pathname\.startsWith\('\/api\/intake\/'\)/,
    'Protected intake routes must not inherit permissive public CORS');
  assert.match(appSource, /'\/api\/intake\/whatsapp-origin'/,
    'The public widget origin endpoint must retain external CORS');
}

function testStrictIntakeIds() {
  assert.equal(parseIntakeId(57), 57);
  assert.equal(parseIntakeId('57'), 57);
  assert.equal(parseIntakeId(' 57 '), 57);
  for (const value of [57.9, '57.9', '57.0', '057', '5e1', '0x39', 0, -1, '', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseIntakeId(value), null, `Unsafe intake id must be rejected: ${String(value)}`);
  }

  const controllerPath = path.resolve(__dirname, '../../controllers/intake.controller.js');
  const controllerSource = fs.readFileSync(controllerPath, 'utf8');
  assert.match(controllerSource, /const parseInteger = parseIntakeId;/,
    'Every intake endpoint must use the strict scope/record id parser');
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
  assert.equal(publicHttpUrl('https://www.propdental.es/implantes/'), 'https://www.propdental.es/implantes/');
  assert.equal(publicHttpUrl('https://www.propdental.es/preview', { requireHttps: true }), 'https://www.propdental.es/preview');
  for (const unsafeUrl of [
    'http://127.0.0.1/private',
    'https://localhost/private',
    'https://campaign.internal/preview',
    'https://user:password@example.com/preview',
    'https://169.254.169.254/latest/meta-data',
    'https://intranet/preview',
  ]) {
    assert.equal(publicHttpUrl(unsafeUrl), null, `${unsafeUrl} must not be accepted as a public campaign URL`);
  }
  assert.equal(publicHttpUrl('http://www.propdental.es/preview', { requireHttps: true }), null);

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
  assert.match(verify, /data-consent-mode-enabled/);
  assert.match(verify, /data-consent-provider/);
  assert.match(verify, /data-clinicaclick-consent-bootstrap/);
  assert.match(verify, /cookieNoticeProviderMatches\(/,
    'An external CMP must match the provider configured for the scope');
  assert.match(verify, /verification_attestation:/,
    'Successful verification must return a server-signed attestation');
  assert.doesNotMatch(verify, /wp-consent-api/i,
    'WP Consent API is not proof that Google Consent Mode is installed');
}

async function run() {
  await testScopeAuthorization();
  testConnectOnlyConflictRegression();
  testCampaignScopeAndWritableModesRegression();
  testIntakeConfigScopeRegression();
  testPublicIntakeLocationsRespectConfiguredSubset();
  testStrictIntakeIds();
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
