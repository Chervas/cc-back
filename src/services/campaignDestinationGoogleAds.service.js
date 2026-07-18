'use strict';

const { googleAdsRequest, normalizeCustomerId } = require('../lib/googleAdsClient');
const {
  GOOGLE_ADS_SCOPE,
  resolveScopedGoogleAdsRuntime,
  runtimeError,
} = require('./googleAdsScopedRuntime.service');

const SEARCH_FAMILY = 'google_search';
const PMAX_FAMILY = 'google_pmax';
const EXPANSION_TYPE = 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION';
const MUTABLE_STATUSES = new Set(['ENABLED', 'PAUSED']);

function text(value) {
  return String(value ?? '').trim();
}

function campaignId(value) {
  const clean = text(value);
  return /^\d+$/.test(clean) && !/^0+$/.test(clean) ? clean.replace(/^0+(?=\d)/, '') : '';
}

function customerId(value) {
  const clean = normalizeCustomerId(value);
  return /^\d{10}$/.test(clean) ? clean : '';
}

function list(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean)));
}

function normalizeAutomationSettings(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    assetAutomationType: text(item?.assetAutomationType ?? item?.asset_automation_type).toUpperCase(),
    assetAutomationStatus: text(item?.assetAutomationStatus ?? item?.asset_automation_status).toUpperCase(),
  })).filter((item) => item.assetAutomationType && item.assetAutomationStatus);
}

function expansionStatus(settings) {
  return normalizeAutomationSettings(settings)
    .find((item) => item.assetAutomationType === EXPANSION_TYPE)?.assetAutomationStatus || null;
}

function normalizedScope(binding) {
  return {
    assignmentScope: binding?.scopeType === 'group' ? 'group' : 'clinic',
    clinicId: Number(binding?.clinicaId) || null,
    groupId: Number(binding?.grupoClinicaId) || null,
  };
}

function assertInput(account, binding) {
  const normalizedCustomerId = customerId(account?.customerId ?? account?.customer_id);
  const normalizedCampaignId = campaignId(account?.campaignId ?? account?.campaign_id);
  const family = text(account?.family).toLowerCase();
  if (!normalizedCustomerId || !normalizedCampaignId || ![SEARCH_FAMILY, PMAX_FAMILY].includes(family)) {
    throw runtimeError('CAMPAIGN_DESTINATION_GOOGLE_INPUT_INVALID', 'La cuenta Google Ads no identifica una campaña Search/PMax válida.', 422);
  }
  const scope = normalizedScope(binding);
  if ((scope.assignmentScope === 'clinic' && !scope.clinicId) || (scope.assignmentScope === 'group' && !scope.groupId)) {
    throw runtimeError('CAMPAIGN_DESTINATION_SCOPE_INVALID', 'El binding no contiene un scope Google Ads válido.', 422);
  }
  return { customerId: normalizedCustomerId, campaignId: normalizedCampaignId, family, scope };
}

async function runtimeFor(account, binding, dependencies = {}) {
  const input = assertInput(account, binding);
  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const runtime = await resolveRuntime({
    ...input.scope,
    customerId: input.customerId,
    requiredScopes: [GOOGLE_ADS_SCOPE],
  });
  if (customerId(runtime?.customerId) !== input.customerId || !runtime?.accessToken) {
    throw runtimeError('CAMPAIGN_DESTINATION_RUNTIME_MISMATCH', 'El runtime Google no pertenece a la cuenta del binding.', 403);
  }
  return { input, runtime };
}

function commonCampaign(row) {
  const campaign = row?.campaign && typeof row.campaign === 'object' ? row.campaign : {};
  return {
    resource_name: text(campaign.resourceName ?? campaign.resource_name),
    status: text(campaign.status).toUpperCase() || null,
    channel_type: text(campaign.advertisingChannelType ?? campaign.advertising_channel_type).toUpperCase() || null,
    asset_automation_settings: normalizeAutomationSettings(campaign.assetAutomationSettings ?? campaign.asset_automation_settings),
  };
}

async function fetchSearchState({ runtime, input, request }) {
  const query = [
    'SELECT',
    '  campaign.id,',
    '  campaign.resource_name,',
    '  campaign.status,',
    '  campaign.advertising_channel_type,',
    '  ad_group_ad.status,',
    '  ad_group_ad.ad.id,',
    '  ad_group_ad.ad.resource_name,',
    '  ad_group_ad.ad.type,',
    '  ad_group_ad.ad.final_urls',
    'FROM ad_group_ad',
    `WHERE campaign.id = ${input.campaignId}`,
    '  AND ad_group_ad.status != REMOVED',
    '  AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD',
  ].join('\n');
  const response = await request('POST', `customers/${input.customerId}/googleAds:search`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: { query },
    singleAttempt: true,
  });
  const rows = Array.isArray(response?.results) ? response.results : [];
  const campaign = commonCampaign(rows[0]);
  const entities = rows.map((row) => {
    const adGroupAd = row?.adGroupAd ?? row?.ad_group_ad ?? {};
    const ad = adGroupAd?.ad && typeof adGroupAd.ad === 'object' ? adGroupAd.ad : {};
    return {
      resource_name: text(ad.resourceName ?? ad.resource_name),
      status: text(adGroupAd.status).toUpperCase() || null,
      final_urls: list(ad.finalUrls ?? ad.final_urls),
    };
  }).filter((item) => item.resource_name);
  return { customer_id: input.customerId, campaign_id: input.campaignId, family: input.family, campaign, entities };
}

async function fetchPmaxState({ runtime, input, request }) {
  const query = [
    'SELECT',
    '  campaign.id,',
    '  campaign.resource_name,',
    '  campaign.status,',
    '  campaign.advertising_channel_type,',
    '  campaign.asset_automation_settings,',
    '  asset_group.id,',
    '  asset_group.resource_name,',
    '  asset_group.status,',
    '  asset_group.final_urls',
    'FROM asset_group',
    `WHERE campaign.id = ${input.campaignId}`,
    '  AND asset_group.status != REMOVED',
  ].join('\n');
  const response = await request('POST', `customers/${input.customerId}/googleAds:search`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: { query },
    singleAttempt: true,
  });
  const rows = Array.isArray(response?.results) ? response.results : [];
  const campaign = commonCampaign(rows[0]);
  const entities = rows.map((row) => {
    const assetGroup = row?.assetGroup ?? row?.asset_group ?? {};
    return {
      resource_name: text(assetGroup.resourceName ?? assetGroup.resource_name),
      status: text(assetGroup.status).toUpperCase() || null,
      final_urls: list(assetGroup.finalUrls ?? assetGroup.final_urls),
    };
  }).filter((item) => item.resource_name);
  return {
    customer_id: input.customerId,
    campaign_id: input.campaignId,
    family: input.family,
    campaign,
    entities,
    pmax_url_expansion_status: expansionStatus(campaign.asset_automation_settings),
  };
}

function assertInspectableState(state) {
  const expectedChannel = state.family === SEARCH_FAMILY ? 'SEARCH' : 'PERFORMANCE_MAX';
  const expectedCampaignResource = `customers/${state.customer_id}/campaigns/${state.campaign_id}`;
  if (state.campaign?.resource_name !== expectedCampaignResource || state.campaign?.channel_type !== expectedChannel) {
    throw runtimeError('CAMPAIGN_DESTINATION_PROVIDER_IDENTITY_MISMATCH', 'Google devolvió una campaña distinta o de una familia no compatible.', 409);
  }
  if (!MUTABLE_STATUSES.has(state.campaign?.status)) {
    throw runtimeError('CAMPAIGN_DESTINATION_PROVIDER_STATUS_BLOCKED', 'La campaña Google debe estar habilitada o pausada.', 409);
  }
  if (!state.entities.length || state.entities.some((item) => !MUTABLE_STATUSES.has(item.status))) {
    throw runtimeError('CAMPAIGN_DESTINATION_ENTITIES_BLOCKED', 'No hay anuncios/grupos de recursos mutables para cambiar el destino.', 409);
  }
  return state;
}

async function inspect({ account, binding }, dependencies = {}) {
  const { input, runtime } = await runtimeFor(account, binding, dependencies);
  const request = dependencies.request || googleAdsRequest;
  const state = input.family === SEARCH_FAMILY
    ? await fetchSearchState({ runtime, input, request })
    : await fetchPmaxState({ runtime, input, request });
  return assertInspectableState(state);
}

function desiredExpansionStatus(policy) {
  if (policy === 'enabled') return 'OPTED_IN';
  if (policy === 'disabled') return 'OPTED_OUT';
  return null;
}

function replaceExpansionSetting(settings, policy) {
  const status = desiredExpansionStatus(policy);
  if (!status) throw runtimeError('PMAX_URL_EXPANSION_REQUIRED', 'Performance Max requiere decidir explícitamente la expansión de URL.', 422);
  return [
    ...normalizeAutomationSettings(settings).filter((item) => item.assetAutomationType !== EXPANSION_TYPE),
    { assetAutomationType: EXPANSION_TYPE, assetAutomationStatus: status },
  ];
}

function desiredFrom({ account, destinationUrl }) {
  const family = text(account?.family).toLowerCase();
  const pmaxPolicy = text(account?.pmaxUrlExpansion ?? account?.pmax_url_expansion).toLowerCase();
  if (family === PMAX_FAMILY && !['enabled', 'disabled'].includes(pmaxPolicy)) {
    throw runtimeError('PMAX_URL_EXPANSION_REQUIRED', 'Performance Max requiere decidir explícitamente la expansión de URL.', 422);
  }
  return {
    destination_url: text(destinationUrl),
    pmax_url_expansion: family === PMAX_FAMILY ? pmaxPolicy : 'not_applicable',
  };
}

function buildOperations({ state, desired }) {
  if (!desired.destination_url) throw runtimeError('CAMPAIGN_DESTINATION_URL_REQUIRED', 'Falta la URL final.', 422);
  if (state.family === SEARCH_FAMILY) {
    return [{
      service: 'ads',
      path: `customers/${state.customer_id}/ads:mutate`,
      data: {
        operations: state.entities.map((entity) => ({
          updateMask: 'final_urls',
          update: { resourceName: entity.resource_name, finalUrls: [desired.destination_url] },
        })),
      },
    }];
  }
  const expansionSettings = replaceExpansionSetting(state.campaign.asset_automation_settings, desired.pmax_url_expansion);
  return [
    {
      service: 'asset_groups',
      path: `customers/${state.customer_id}/assetGroups:mutate`,
      data: {
        operations: state.entities.map((entity) => ({
          updateMask: 'final_urls',
          update: { resourceName: entity.resource_name, finalUrls: [desired.destination_url] },
        })),
      },
    },
    {
      service: 'campaigns',
      path: `customers/${state.customer_id}/campaigns:mutate`,
      data: {
        operations: [{
          updateMask: 'asset_automation_settings',
          update: {
            resourceName: state.campaign.resource_name,
            assetAutomationSettings: expansionSettings,
          },
        }],
      },
    },
  ];
}

async function sendOperations({ runtime, operations, validateOnly, request }) {
  const results = [];
  for (const operation of operations) {
    const response = await request('POST', operation.path, {
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId || undefined,
      data: {
        ...operation.data,
        partialFailure: false,
        validateOnly: validateOnly === true,
        responseContentType: 'MUTABLE_RESOURCE',
      },
      singleAttempt: true,
    });
    results.push({ service: operation.service, result_count: Array.isArray(response?.results) ? response.results.length : 0 });
  }
  return results;
}

async function mutate({ account, binding, beforeState, destinationUrl, validateOnly = false }, dependencies = {}) {
  const { input, runtime } = await runtimeFor(account, binding, dependencies);
  const state = assertInspectableState(beforeState);
  if (state.customer_id !== input.customerId || state.campaign_id !== input.campaignId || state.family !== input.family) {
    throw runtimeError('CAMPAIGN_DESTINATION_BEFORE_STATE_MISMATCH', 'El snapshot previo no pertenece a esta campaña.', 409);
  }
  const desired = desiredFrom({ account, destinationUrl });
  const operations = buildOperations({ state, desired });
  return sendOperations({
    runtime,
    operations,
    validateOnly,
    request: dependencies.request || googleAdsRequest,
  });
}

function verifyState({ state, account, destinationUrl }) {
  const desired = desiredFrom({ account, destinationUrl });
  const urlVerified = state.entities.length > 0
    && state.entities.every((entity) => entity.final_urls.length === 1 && entity.final_urls[0] === desired.destination_url);
  const expansionVerified = state.family !== PMAX_FAMILY
    || state.pmax_url_expansion_status === desiredExpansionStatus(desired.pmax_url_expansion);
  return {
    verified: urlVerified && expansionVerified,
    destination_url_verified: urlVerified,
    pmax_url_expansion_verified: expansionVerified,
    observed: state,
  };
}

function buildRollbackOperations(beforeState) {
  if (beforeState.family === SEARCH_FAMILY) {
    return [{
      service: 'ads',
      path: `customers/${beforeState.customer_id}/ads:mutate`,
      data: {
        operations: beforeState.entities.map((entity) => ({
          updateMask: 'final_urls',
          update: { resourceName: entity.resource_name, finalUrls: entity.final_urls },
        })),
      },
    }];
  }
  return [
    {
      service: 'asset_groups',
      path: `customers/${beforeState.customer_id}/assetGroups:mutate`,
      data: {
        operations: beforeState.entities.map((entity) => ({
          updateMask: 'final_urls',
          update: { resourceName: entity.resource_name, finalUrls: entity.final_urls },
        })),
      },
    },
    {
      service: 'campaigns',
      path: `customers/${beforeState.customer_id}/campaigns:mutate`,
      data: {
        operations: [{
          updateMask: 'asset_automation_settings',
          update: {
            resourceName: beforeState.campaign.resource_name,
            assetAutomationSettings: beforeState.campaign.asset_automation_settings,
          },
        }],
      },
    },
  ];
}

async function rollback({ account, binding, beforeState, validateOnly = false }, dependencies = {}) {
  const { input, runtime } = await runtimeFor(account, binding, dependencies);
  const state = assertInspectableState(beforeState);
  if (state.customer_id !== input.customerId || state.campaign_id !== input.campaignId || state.family !== input.family) {
    throw runtimeError('CAMPAIGN_DESTINATION_BEFORE_STATE_MISMATCH', 'El snapshot previo no pertenece a esta campaña.', 409);
  }
  return sendOperations({
    runtime,
    operations: buildRollbackOperations(state),
    validateOnly,
    request: dependencies.request || googleAdsRequest,
  });
}

function verifyRollback({ state, beforeState }) {
  const expectedByResource = new Map(beforeState.entities.map((item) => [item.resource_name, item]));
  const entitiesVerified = state.entities.length === beforeState.entities.length
    && state.entities.every((item) => {
      const expected = expectedByResource.get(item.resource_name);
      return expected && JSON.stringify(item.final_urls) === JSON.stringify(expected.final_urls);
    });
  const expansionVerified = state.family !== PMAX_FAMILY
    || state.pmax_url_expansion_status === beforeState.pmax_url_expansion_status;
  return { verified: entitiesVerified && expansionVerified, entities_verified: entitiesVerified, pmax_url_expansion_verified: expansionVerified, observed: state };
}

module.exports = {
  EXPANSION_TYPE,
  PMAX_FAMILY,
  SEARCH_FAMILY,
  buildOperations,
  desiredExpansionStatus,
  inspect,
  mutate,
  rollback,
  verifyRollback,
  verifyState,
  _fetchPmaxState: fetchPmaxState,
  _fetchSearchState: fetchSearchState,
};
