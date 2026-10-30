'use strict';
const { createHash } = require('node:crypto');
const { schema, ref } = require('./contracts');
const { canonical } = require('./canonical');
const { fail } = require('./errors');
const ads = require('./google-ads-contract');
const COHORT = 'google-ads-optimization-v1';
const OPERATIONS = Object.freeze({ apply: 'google.ads.optimization.apply.v1', status: 'google.ads.optimization.status.v1', review: 'google.ads.optimization.review.v1' });
const KINDS = Object.freeze(['pause_ad', 'manual_cpc', 'target_cpa', 'maximize_conversions_cpa', 'target_roas', 'maximize_conversion_value_roas', 'daily_budget']);
const TTL_MS = 60000;
const REVIEW_DELAY_MS = 120000;
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const id = { type: 'string', pattern: '^[1-9][0-9]{0,19}$' };
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const amount = { type: 'string', pattern: '^[1-9][0-9]{0,15}$' };
const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,6})?$' };
const hashField = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const bindingSchema = object({ accounts: { type: 'array', minItems: 1, maxItems: 1000, items: object({ assetRef: ref,
  campaigns: { type: 'array', minItems: 1, maxItems: 1000, items: object({ campaignId: id,
    kinds: { type: 'array', minItems: 1, maxItems: KINDS.length, uniqueItems: true, items: { enum: KINDS } },
    maxBidMicros: { ...amount, type: ['string', 'null'] }, maxTargetRoas: { ...decimal, type: ['string', 'null'] },
    maxDailyBudgetMicros: { ...amount, type: ['string', 'null'] }, allowBudgetIncrease: { type: 'boolean' } }) } }) } });
const applyFields = { executionId: uuid, mandateId: uuid, evidenceFingerprint: hashField, expiresAt: { type: 'integer', minimum: 1 },
  campaignId: id, kind: { enum: KINDS }, resourceId: id, adGroupId: { ...id, type: ['string', 'null'] },
  baselineAdId: { ...id, type: ['string', 'null'] }, before: { type: 'string', maxLength: 24 }, after: { type: 'string', maxLength: 24 } };
const validators = { apply: schema(applyFields), status: schema({ executionId: uuid }),
  review: schema({ submission: object(applyFields), actorId: { type: 'integer', minimum: 1, maximum: 2147483647 },
    observedAt: { type: 'integer', minimum: 1 }, value: { type: 'string', minLength: 1, maxLength: 24 }, confirmed: { const: true } }) };
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function scaled(value, ratio = false) {
  if (typeof value !== 'string' || !(ratio ? /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/ : /^[1-9][0-9]{0,15}$/).test(value)) fail('invalid_request');
  const [whole, part = ''] = value.split('.'); const result = BigInt(whole) * 1000000n + BigInt(part.padEnd(6, '0'));
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER) * 1000000n) fail('invalid_request');
  // Google expects numeric ROAS in JSON, unlike string-valued micros. Reject
  // ratios whose serialization would silently change the approved decimal.
  const fraction = part.replace(/0+$/, '');
  if (ratio && String(Number(value)) !== whole + (fraction ? '.' + fraction : '')) fail('invalid_request');
  return result;
}
const ratioKind = kind => ['target_roas', 'maximize_conversion_value_roas'].includes(kind);
const targetKind = kind => ['target_cpa', 'maximize_conversions_cpa', 'target_roas', 'maximize_conversion_value_roas'].includes(kind);
const action = kind => kind === 'pause_ad' ? 'pause' : kind === 'daily_budget' ? 'budget' : 'bid';
function validate(kind, input) {
  if (!Object.hasOwn(validators, kind)) fail('operation_denied'); validators[kind](input);
  if (kind === 'status') return;
  if (kind === 'review') {
    validate('apply', input.submission);
    if (input.submission.kind === 'pause_ad') { if (!['ENABLED', 'PAUSED', 'REMOVED'].includes(input.value)) fail('invalid_request'); }
    else scaled(input.value, ratioKind(input.submission.kind));
    return;
  }
  if (input.kind === 'pause_ad') {
    if (!input.adGroupId || !input.baselineAdId || input.resourceId === input.baselineAdId
      || input.before !== 'ENABLED' || input.after !== 'PAUSED') fail('invalid_request');
  } else {
    if (input.adGroupId !== null || input.baselineAdId !== null || targetKind(input.kind) && input.resourceId !== input.campaignId) fail('invalid_request');
    const before = scaled(input.before, ratioKind(input.kind)), after = scaled(input.after, ratioKind(input.kind));
    const delta = before > after ? before - after : after - before;
    if (!delta || delta * 100n > before * 10n || input.kind === 'manual_cpc' && after >= before
      || targetKind(input.kind) && (ratioKind(input.kind) ? after >= before : after <= before)) fail('invalid_request');
  }
}
const validateShape = schema({ value: bindingSchema });
function validateBinding(binding) {
  validateShape({ value: binding.googleAdsOptimization });
  if (binding.provider !== ads.PROVIDER) fail('invalid_request');
  const assets = new Set();
  for (const account of binding.googleAdsOptimization.accounts) {
    ads.resource(binding, account.assetRef); if (assets.has(account.assetRef)) fail('invalid_request'); assets.add(account.assetRef);
    const campaigns = new Set();
    for (const row of account.campaigns) {
      if (campaigns.has(row.campaignId)) fail('invalid_request'); campaigns.add(row.campaignId);
      const required = [row.kinds.some(k => ['manual_cpc', 'target_cpa', 'maximize_conversions_cpa'].includes(k)), row.kinds.some(ratioKind), row.kinds.includes('daily_budget')];
      for (const [index, key] of ['maxBidMicros', 'maxTargetRoas', 'maxDailyBudgetMicros'].entries()) {
        if (required[index] !== (row[key] !== null)) fail('invalid_request');
        if (row[key] !== null) scaled(row[key], key === 'maxTargetRoas');
      }
      if (!required[2] && row.allowBudgetIncrease) fail('invalid_request');
    }
  }
}
function resource(binding, assetRef, input = null) {
  const account = ads.resource(binding, assetRef);
  const policy = binding.googleAdsOptimization?.accounts.find(row => row.assetRef === assetRef);
  if (!policy) fail('scope_denied');
  if (input) {
    const campaign = policy.campaigns.find(row => row.campaignId === input.campaignId);
    if (!campaign?.kinds.includes(input.kind)) fail('scope_denied');
    if (input.kind !== 'pause_ad') {
      const cap = input.kind === 'daily_budget' ? campaign.maxDailyBudgetMicros : ratioKind(input.kind) ? campaign.maxTargetRoas : campaign.maxBidMicros;
      if (cap === null || scaled(input.after, ratioKind(input.kind)) > scaled(cap, ratioKind(input.kind))
        || input.kind === 'daily_budget' && !campaign.allowBudgetIncrease && scaled(input.after) > scaled(input.before)) fail('scope_denied');
    }
  }
  return { ...account, policy };
}
function scopeDigest(binding, target, principal) {
  return hash({ connection: binding.connectionRef, subject: binding.googleSubject, secret: binding.secretArn,
    client: binding.clientSecretArn, developer: binding.developerSecretArn, target,
    principal: { id: principal.id, key: principal.keyId, publicKey: principal.publicKey } });
}
const specs = Object.freeze({ pause_ad: ['adGroupAds', 'status'], manual_cpc: ['adGroups', 'cpcBidMicros'],
  target_cpa: ['campaigns', 'targetCpa.targetCpaMicros'], maximize_conversions_cpa: ['campaigns', 'maximizeConversions.targetCpaMicros'],
  target_roas: ['campaigns', 'targetRoas.targetRoas'], maximize_conversion_value_roas: ['campaigns', 'maximizeConversionValue.targetRoas'],
  daily_budget: ['campaignBudgets', 'amountMicros'] });
function mutation(input, customerId) {
  const [entity, field] = specs[input.kind];
  const name = `customers/${customerId}/${entity}/${input.kind === 'pause_ad' ? input.adGroupId + '~' : ''}${input.resourceId}`;
  const update = { resourceName: name }; const parts = field.split('.');
  const container = parts.length === 2 ? update[parts[0]] = {} : update;
  container[parts.at(-1)] = ratioKind(input.kind) ? Number(input.after) : input.after;
  return { path: `/v24/customers/${customerId}/${entity}:mutate`, body: {
    operations: [{ update, updateMask: field }], partialFailure: false, responseContentType: 'RESOURCE_NAME_ONLY' }, resourceName: name };
}
function validateMutation(path, kind, body) {
  if (!KINDS.includes(kind) || !body || Object.keys(body).sort().join(',') !== 'operations,partialFailure,responseContentType'
    || body.partialFailure !== false || body.responseContentType !== 'RESOURCE_NAME_ONLY' || !Array.isArray(body.operations)
    || body.operations.length !== 1) fail('invalid_request');
  const operation = body.operations[0]; const [entity, field] = specs[kind];
  const match = typeof path === 'string' && path.match(new RegExp(`^/v24/customers/([0-9]{10})/${entity}:mutate$`));
  if (!match || !operation || Object.keys(operation).sort().join(',') !== 'update,updateMask' || operation.updateMask !== field) fail('invalid_request');
  const update = operation.update, parts = field.split('.');
  if (!update || Object.keys(update).sort().join(',') !== ['resourceName', parts[0]].sort().join(',')
    || typeof update.resourceName !== 'string' || !new RegExp(`^customers/${match[1]}/${entity}/${kind === 'pause_ad' ? '[1-9][0-9]{0,19}~' : ''}[1-9][0-9]{0,19}$`).test(update.resourceName)) fail('invalid_request');
  const inner = parts.length === 2 ? update[parts[0]] : update;
  if (!inner || parts.length === 2 && Object.keys(inner).join(',') !== parts[1]) fail('invalid_request');
  const value = inner[parts.at(-1)];
  if (kind === 'pause_ad') { if (value !== 'PAUSED') fail('invalid_request'); }
  else { if (typeof value !== (ratioKind(kind) ? 'number' : 'string')) fail('invalid_request'); scaled(String(value), ratioKind(kind)); }
}
function result(raw, expected) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['results', 'responseId'].includes(key))
    || !Array.isArray(raw.results) || raw.results.length !== 1 || raw.results[0]?.resourceName !== expected
    || Object.keys(raw.results[0]).join(',') !== 'resourceName') fail('provider_failed');
  return { acknowledged: true, resourceName: expected };
}
module.exports = { COHORT, OPERATIONS, KINDS, TTL_MS, REVIEW_DELAY_MS, bindingSchema, validateBinding, validate, resource, scopeDigest, hash,
  scaled, ratioKind, targetKind, action, mutation, validateMutation, result };
