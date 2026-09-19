'use strict';
const { createHash } = require('node:crypto');
const { schema, ref } = require('./contracts');
const { canonical } = require('./canonical');
const { fail } = require('./errors');
const ads = require('./google-ads-contract');
const PROVIDER = ads.PROVIDER, SCOPES = ads.SCOPES;
const PREFIX = 'google.ads.conversion_actions.';
const OPERATIONS = Object.freeze(Object.fromEntries(['prepare', 'validate', 'apply', 'status'].map(name => [name, PREFIX + name + '.v1'])));
const CATALOG = Object.freeze({ lead: ['Lead - ClinicaClick', 'SUBMIT_LEAD_FORM'], contact: ['Contact - ClinicaClick', 'CONTACT'],
  qualified_lead: ['Qualified Lead - ClinicaClick', 'QUALIFIED_LEAD'], schedule: ['Schedule - ClinicaClick', 'BOOK_APPOINTMENT'],
  purchase: ['Purchase - ClinicaClick', 'PURCHASE'] });
const EVENTS = Object.keys(CATALOG), TTL_MS = 300000;
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const id = { type: ['string', 'null'], pattern: '^[1-9][0-9]{0,19}$' };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const currency = { type: 'string', pattern: '^[A-Z]{3}$' };
const bindingSchema = object({ accounts: { type: 'array', minItems: 1, maxItems: 1000, items: object({ assetRef: ref,
  events: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: EVENTS } },
  currencies: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: currency },
  allowCreate: { type: 'boolean' }, allowNormalize: { type: 'boolean' } }) } });
const prepareSchema = { mode: { enum: ['create', 'normalize'] }, currency: { ...currency, type: ['string', 'null'] },
  targets: { type: 'array', minItems: 1, maxItems: 5, items: object({ event: { enum: EVENTS }, actionId: id }) } };
const validators = { [OPERATIONS.prepare]: schema(prepareSchema),
  ...Object.fromEntries(['validate', 'apply', 'status'].map(name => [OPERATIONS[name], schema({ planId: uuid })])) };
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function validate(operation, payload) {
  if (!Object.hasOwn(validators, operation)) fail('operation_denied'); validators[operation](payload);
  if (operation === OPERATIONS.prepare && (new Set(payload.targets.map(row => row.event)).size !== payload.targets.length
    || new Set(payload.targets.map(row => row.actionId).filter(Boolean)).size !== payload.targets.filter(row => row.actionId).length
    || payload.mode === 'create' && (!payload.currency || payload.targets.some(row => row.actionId !== null))
    || payload.mode === 'normalize' && payload.currency !== null)) fail('invalid_request');
  return payload;
}
const validateBindingShape = schema({ value: bindingSchema });
function validateBinding(binding) {
  validateBindingShape({ value: binding.googleAdsActionManagement });
  if (binding.provider !== PROVIDER) fail('invalid_request');
  const seen = new Set();
  for (const row of binding.googleAdsActionManagement.accounts) {
    ads.resource(binding, row.assetRef);
    if (seen.has(row.assetRef) || !row.allowCreate && !row.allowNormalize) fail('invalid_request'); seen.add(row.assetRef);
  }
}
function resource(binding, assetRef, input) {
  const account = ads.resource(binding, assetRef);
  const policy = binding.googleAdsActionManagement?.accounts.find(row => row.assetRef === assetRef);
  if (!policy || input.mode === 'create' && (!policy.allowCreate || !policy.currencies.includes(input.currency))
    || input.mode === 'normalize' && !policy.allowNormalize
    || input.targets.some(row => !policy.events.includes(row.event))) fail('scope_denied');
  return { ...account, policy };
}
function scopeDigest(binding, assetRef, input, principal) {
  const target = resource(binding, assetRef, input);
  return hash({ connection: binding.connectionRef, subject: binding.googleSubject, secretArn: binding.secretArn,
    clientSecretArn: binding.clientSecretArn, developerSecretArn: binding.developerSecretArn, assetRef, target,
    principal: { id: principal.id, keyId: principal.keyId, publicKey: principal.publicKey } });
}
function create(event, currency) {
  return { name: CATALOG[event][0], category: CATALOG[event][1], type: 'UPLOAD_CLICKS', status: 'ENABLED',
    primaryForGoal: false, countingType: 'MANY_PER_CLICK',
    valueSettings: { defaultValue: 0, alwaysUseDefaultValue: false, defaultCurrencyCode: currency } };
}
function plan(input, rows, account) {
  const operations = [], changes = [], selected = [];
  for (const target of input.targets) {
    const matches = rows.filter(row => row.conversionAction.status !== 'REMOVED'
      && row.conversionAction.name.trim().toLowerCase() === CATALOG[target.event][0].toLowerCase());
    if (matches.length > 1) fail('action_plan_conflict');
    const action = matches[0]?.conversionAction;
    if (target.actionId && action?.id !== target.actionId || input.mode === 'normalize' && !action) fail('action_plan_conflict');
    if (action && (action.resourceName !== `customers/${account.customerId}/conversionActions/${action.id}`
      || action.ownerCustomer !== `customers/${account.customerId}` || action.type !== 'UPLOAD_CLICKS'
      || action.category !== CATALOG[target.event][1] || !['ENABLED', 'HIDDEN'].includes(action.status))) fail('action_plan_conflict');
    selected.push({ event: target.event, action: action || null });
    let change = 'unchanged';
    if (!action) { change = 'create'; operations.push({ create: create(target.event, input.currency) }); }
    else if (input.mode === 'normalize' && (action.countingType !== 'MANY_PER_CLICK' || action.primaryForGoal !== false)) {
      change = 'normalize'; operations.push({ update: { resourceName: action.resourceName, countingType: 'MANY_PER_CLICK', primaryForGoal: false },
        updateMask: 'counting_type,primary_for_goal' });
    }
    changes.push({ event: target.event, actionId: action?.id || null, change });
  }
  return { baseline: hash(selected), operations, changes };
}
function result(raw, plan, account, validateOnly) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error || raw.errors || raw.partialFailureError || raw.partial_failure_error
    || Object.keys(raw).some(key => !['results', 'responseId'].includes(key))
    || raw.results !== undefined && !Array.isArray(raw.results)) fail('provider_failed');
  if (validateOnly) { if (raw.results?.length) fail('provider_failed'); return; }
  const changed = plan.changes.filter(row => row.change !== 'unchanged');
  if (raw.results?.length !== changed.length) fail('provider_failed');
  const ids = new Set();
  return changed.map((row, index) => {
    const name = raw.results[index]?.resourceName;
    const match = typeof name === 'string' && name.match(new RegExp(`^customers/${account.customerId}/conversionActions/([1-9][0-9]{0,19})$`));
    if (!match || row.actionId && row.actionId !== match[1] || ids.has(match[1])) fail('provider_failed'); ids.add(match[1]);
    return { event: row.event, actionId: match[1], change: row.change };
  });
}
module.exports = { PROVIDER, SCOPES, OPERATIONS, CATALOG, EVENTS, TTL_MS, bindingSchema,
  validate, validateBinding, resource, scopeDigest, hash, plan, result };
