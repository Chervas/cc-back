'use strict';

const assert = require('node:assert/strict');
const {
  buildCampaignAttributionPlan,
  configureGoogleAdsCampaignAttribution,
  mergeClinicaclickAttributionSuffix,
  normalizeConfiguredAccounts,
} = require('../../services/googleAdsCampaignAttributionSuffix.service');

function row({
  customerId = '1234567890',
  campaignId,
  channelType = 'SEARCH',
  suffix = '',
  status = 'ENABLED',
  name = null,
}) {
  return {
    campaign: {
      id: String(campaignId),
      resourceName: `customers/${customerId}/campaigns/${campaignId}`,
      name: name || `Campaign ${campaignId}`,
      status,
      advertisingChannelType: channelType,
      finalUrlSuffix: suffix,
    },
  };
}

function deterministicClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 12, 10, 0, tick++));
}

function runtimeResolverFor(customerIds) {
  const allowed = new Set(customerIds);
  return async ({ customerId }) => {
    if (!allowed.has(customerId)) {
      const error = new Error('account forbidden');
      error.code = 'CUSTOMER_NOT_ASSIGNED_TO_SCOPE';
      error.httpStatus = 403;
      throw error;
    }
    return {
      accessToken: `secret-${customerId}`,
      loginCustomerId: '9999999999',
      customerId,
    };
  };
}

function testSuffixMergePreservesForeignParametersAndIsIdempotent() {
  const merged = mergeClinicaclickAttributionSuffix(
    'utm_source=google&x=a%26b&cc_gads_customer_id=old&repeat=1&repeat=2&cc_gads_campaign_id=old',
    '123-456-7890',
  );
  assert.equal(
    merged.after,
    'utm_source=google&x=a%26b&repeat=1&repeat=2&cc_gads_customer_id=1234567890&cc_gads_campaign_id={campaignid}',
  );
  assert.equal(merged.preserved_parameter_count, 4);
  assert.equal(merged.changed, true);
  assert.equal(
    mergeClinicaclickAttributionSuffix(merged.after, '1234567890').after,
    merged.after,
  );

  const encodedOwnedKey = mergeClinicaclickAttributionSuffix(
    'foo=bar&cc%5Fgads%5Fcustomer%5Fid=wrong&CC_GADS_CAMPAIGN_ID=wrong',
    '1234567890',
  );
  assert.equal(
    encodedOwnedKey.after,
    'foo=bar&cc_gads_customer_id=1234567890&cc_gads_campaign_id={campaignid}',
  );
}

function testConfiguredAccountNormalizationIsStrict() {
  assert.deepEqual(normalizeConfiguredAccounts([{
    customer_id: '123-456-7890',
    campaign_ids: ['001', 1, '2'],
  }]), [{ customer_id: '1234567890', campaign_ids: ['1', '2'] }]);

  assert.throws(
    () => normalizeConfiguredAccounts([
      { customer_id: '1234567890', campaign_ids: ['1'] },
      { customer_id: '123-456-7890', campaign_ids: ['2'] },
    ]),
    (error) => error.code === 'CONFIGURED_CUSTOMER_DUPLICATE',
  );
  assert.throws(
    () => normalizeConfiguredAccounts([{ customer_id: '1234567890', campaign_ids: ['1 OR 1=1'] }]),
    (error) => error.code === 'CONFIGURED_CAMPAIGN_ID_INVALID',
  );
}

function testPlanSupportsSearchPmaxAndSmartAndFailsClosedForUnknown() {
  const supported = buildCampaignAttributionPlan({
    customerId: '1234567890',
    campaignIds: ['11', '12', '13'],
    providerCampaigns: [
      row({ campaignId: '11', channelType: 'SEARCH', suffix: 'utm_source=google' }).campaign,
      row({ campaignId: '12', channelType: 'PERFORMANCE_MAX' }).campaign,
      row({ campaignId: '13', channelType: 'SMART' }).campaign,
    ].map((campaign) => ({
      campaign_id: campaign.id,
      resource_name: campaign.resourceName,
      name: campaign.name,
      status: campaign.status,
      channel_type: campaign.advertisingChannelType,
      final_url_suffix: campaign.finalUrlSuffix,
    })),
  });
  assert.equal(supported.blocked, false);
  assert.equal(supported.operations.length, 3);
  assert.deepEqual(
    supported.campaigns.map((campaign) => campaign.channel_type),
    ['SEARCH', 'PERFORMANCE_MAX', 'SMART'],
  );
  for (const operation of supported.operations) {
    assert.equal(operation.updateMask, 'final_url_suffix');
    assert.match(operation.update.finalUrlSuffix, /cc_gads_customer_id=1234567890/);
    assert.match(operation.update.finalUrlSuffix, /cc_gads_campaign_id=\{campaignid\}/);
  }

  const blocked = buildCampaignAttributionPlan({
    customerId: '1234567890',
    campaignIds: ['11', '14'],
    providerCampaigns: [
      {
        campaign_id: '11',
        resource_name: 'customers/1234567890/campaigns/11',
        status: 'ENABLED',
        channel_type: 'SEARCH',
        final_url_suffix: '',
      },
      {
        campaign_id: '14',
        resource_name: 'customers/1234567890/campaigns/14',
        status: 'ENABLED',
        channel_type: 'VIDEO',
        final_url_suffix: '',
      },
    ],
  });
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.blockers.some((item) => item.code === 'CAMPAIGN_CHANNEL_UNSUPPORTED'));
  // Ni siquiera se expone la operación de la campaña válida cuando la cuenta
  // completa está bloqueada.
  assert.equal(blocked.operations.length, 0);
}

async function testPreviewNeverMutates() {
  const calls = [];
  const result = await configureGoogleAdsCampaignAttribution({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{ customer_id: '1234567890', campaign_ids: ['11'] }],
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolverFor(['1234567890']),
      request: async (method, path, options) => {
        calls.push({ method, path, data: options.data });
        assert.equal(path, 'customers/1234567890/googleAds:search');
        return { results: [row({ campaignId: '11', suffix: 'utm_source=google' })] };
      },
    },
  });
  assert.equal(result.mode, 'preview');
  assert.equal(result.accounts[0].outcome, 'ready');
  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.path.endsWith('campaigns:mutate')), false);
}

async function testValidateOnlyUsesProviderValidationWithoutApply() {
  const calls = [];
  const result = await configureGoogleAdsCampaignAttribution({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{ customer_id: '1234567890', campaign_ids: ['11'] }],
    validateOnly: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolverFor(['1234567890']),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path.endsWith('googleAds:search')) return { results: [row({ campaignId: '11' })] };
        assert.equal(options.data.validateOnly, true);
        assert.equal(options.data.partialFailure, false);
        assert.equal(options.data.operations.length, 1);
        return {};
      },
    },
  });
  assert.equal(result.mode, 'validate_only');
  assert.equal(result.accounts[0].outcome, 'validated');
  assert.equal(calls.filter((call) => call.path.endsWith('campaigns:mutate')).length, 1);
  assert.equal(calls.some((call) => call.path.endsWith('campaigns:mutate') && call.data.validateOnly === false), false);
}

async function testExplicitApplyValidatesChecksDriftMutatesAndVerifies() {
  const calls = [];
  let storedSuffix = 'utm_source=google';
  const result = await configureGoogleAdsCampaignAttribution({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{ customer_id: '1234567890', campaign_ids: ['11'] }],
    apply: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolverFor(['1234567890']),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path.endsWith('googleAds:search')) {
          return { results: [row({ campaignId: '11', suffix: storedSuffix })] };
        }
        if (options.data.validateOnly === false) {
          storedSuffix = options.data.operations[0].update.finalUrlSuffix;
          return { results: [{ resourceName: 'customers/1234567890/campaigns/11' }] };
        }
        return {};
      },
    },
  });

  assert.equal(result.mode, 'apply');
  assert.equal(result.accounts[0].outcome, 'applied');
  assert.equal(result.accounts[0].verification[0].verified, true);
  const mutates = calls.filter((call) => call.path.endsWith('campaigns:mutate'));
  assert.deepEqual(mutates.map((call) => call.data.validateOnly), [true, false]);
  assert.equal(calls.filter((call) => call.path.endsWith('googleAds:search')).length, 3);
}

async function testDriftAbortsBeforeRealMutation() {
  const calls = [];
  let readCount = 0;
  const result = await configureGoogleAdsCampaignAttribution({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{ customer_id: '1234567890', campaign_ids: ['11'] }],
    apply: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolverFor(['1234567890']),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path.endsWith('googleAds:search')) {
          readCount += 1;
          return { results: [row({
            campaignId: '11',
            suffix: readCount === 1 ? 'utm_source=google' : 'utm_source=changed_elsewhere',
          })] };
        }
        assert.equal(options.data.validateOnly, true);
        return {};
      },
    },
  });
  assert.equal(result.accounts[0].outcome, 'blocked');
  assert.equal(result.accounts[0].blockers[0].code, 'CAMPAIGN_STATE_CHANGED');
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('campaigns:mutate')).map((call) => call.data.validateOnly),
    [true],
  );
}

async function testMissingCampaignBlocksWholeAccountAndAccountsStayIsolated() {
  const calls = [];
  const result = await configureGoogleAdsCampaignAttribution({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [
      { customer_id: '1234567890', campaign_ids: ['11', '12'] },
      { customer_id: '0987654321', campaign_ids: ['21'] },
    ],
    validateOnly: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolverFor(['1234567890', '0987654321']),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path === 'customers/1234567890/googleAds:search') {
          return { results: [row({ customerId: '1234567890', campaignId: '11' })] };
        }
        if (path === 'customers/0987654321/googleAds:search') {
          return { results: [row({ customerId: '0987654321', campaignId: '21' })] };
        }
        assert.equal(path, 'customers/0987654321/campaigns:mutate');
        assert.equal(options.data.operations[0].update.finalUrlSuffix.includes('cc_gads_customer_id=0987654321'), true);
        assert.equal(options.data.operations[0].update.finalUrlSuffix.includes('1234567890'), false);
        return {};
      },
    },
  });
  assert.deepEqual(result.accounts.map((account) => account.outcome), ['blocked', 'validated']);
  assert.equal(calls.some((call) => call.path === 'customers/1234567890/campaigns:mutate'), false);
  assert.equal(calls.some((call) => call.path === 'customers/0987654321/campaigns:mutate'), true);
}

async function testProviderFailureIsAuditedWithoutCredentialLeak() {
  const result = await configureGoogleAdsCampaignAttribution({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{ customer_id: '1234567890', campaign_ids: ['11'] }],
    validateOnly: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolverFor(['1234567890']),
      request: async (_method, path) => {
        if (path.endsWith('googleAds:search')) return { results: [row({ campaignId: '11' })] };
        const error = new Error('provider denied');
        error.response = {
          status: 403,
          data: { error: { status: 'PERMISSION_DENIED', message: 'No access' } },
          headers: { 'request-id': 'request-123' },
          config: { headers: { Authorization: 'Bearer should-never-leak' } },
        };
        throw error;
      },
    },
  });
  assert.equal(result.accounts[0].outcome, 'failed');
  assert.deepEqual(result.accounts[0].error, {
    code: 'PERMISSION_DENIED',
    http_status: 403,
    message: 'No access',
    request_id: 'request-123',
    details: [],
  });
  assert.equal(JSON.stringify(result).includes('should-never-leak'), false);
  assert.equal(JSON.stringify(result).includes('secret-1234567890'), false);
}

async function testConflictingModesAreRejected() {
  await assert.rejects(
    configureGoogleAdsCampaignAttribution({
      configuredAccounts: [{ customer_id: '1234567890', campaign_ids: ['11'] }],
      apply: true,
      validateOnly: true,
    }),
    (error) => error.code === 'ATTRIBUTION_MODE_CONFLICT',
  );
  await assert.rejects(
    configureGoogleAdsCampaignAttribution({
      configuredAccounts: [{ customer_id: '1234567890', campaign_ids: ['11'] }],
      apply: 'true',
    }),
    (error) => error.code === 'APPLY_FLAG_INVALID',
  );
}

async function main() {
  testSuffixMergePreservesForeignParametersAndIsIdempotent();
  testConfiguredAccountNormalizationIsStrict();
  testPlanSupportsSearchPmaxAndSmartAndFailsClosedForUnknown();
  await testPreviewNeverMutates();
  await testValidateOnlyUsesProviderValidationWithoutApply();
  await testExplicitApplyValidatesChecksDriftMutatesAndVerifies();
  await testDriftAbortsBeforeRealMutation();
  await testMissingCampaignBlocksWholeAccountAndAccountsStayIsolated();
  await testProviderFailureIsAuditedWithoutCredentialLeak();
  await testConflictingModesAreRejected();
  console.log('google_ads_campaign_attribution_suffix.test.js OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
