'use strict';
const { createHash } = require('node:crypto');
const { schema, ref } = require('./contracts');
const { canonical } = require('./canonical');
const { fail } = require('./errors');
const ads = require('./google-ads-contract');
const planner = require('./google-goal-policy-plan');
const COHORT = 'google-ads-goal-policy-write-v1';
const OPERATIONS = Object.freeze(Object.fromEntries(['prepare', 'validate', 'apply', 'status'].map(k => [k, `google.ads.goal_policy.${k}.v1`])));
const PHASES = Object.freeze(['goal', 'campaign_config', 'campaign_goals']);
const TTL_MS = 300000;
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const id = { type: 'string', pattern: '^[1-9][0-9]{0,19}$' };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const strategy = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_.:-]+$' };
const stage = { enum: planner.BIDDING_SIGNAL_KEYS };
const campaigns = { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: id };
const goal = { type: ['string', 'null'], pattern: '^customers/[0-9]{10}/customConversionGoals/[1-9][0-9]{0,19}$' };
const actionIds = object(Object.fromEntries(planner.ALL_CANONICAL_KEYS.map(k => [k, id])));
const bindingSchema = object({ accounts: { type: 'array', minItems: 1, maxItems: 1000, items: object({ assetRef: ref,
  strategyRef: strategy, stage, campaignIds: campaigns, canonicalActionIds: actionIds, ownedGoalResourceName: goal,
  allowCreate: { type: 'boolean' }, allowUpdate: { type: 'boolean' } }) } });
const ownershipSchema = object({ planId: uuid, customerId: { type: 'string', pattern: '^[0-9]{10}$' },
  goalResourceName: goal, goalAckSha256: digest, commitRefSha256: digest, mandateSha256: digest });
const checks = {
  prepare: schema({ strategyRef: strategy, stage, campaignIds: campaigns, expectedDigest: digest }),
  validate: schema({ planId: uuid, phase: { enum: PHASES }, expectedPreviousAckSha256: { ...digest, type: ['string', 'null'] },
    ownership: { anyOf: [{ type: 'null' }, ownershipSchema] } }),
  status: schema({ planId: uuid }),
};
checks.apply = checks.validate;
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function validate(operation, payload) {
  const family = Object.keys(OPERATIONS).find(k => OPERATIONS[k] === operation);
  if (!family) fail('operation_denied'); checks[family](payload); return payload;
}
const checkBinding = schema({ value: bindingSchema });
function resource(binding, assetRef, input) {
  const account = ads.resource(binding, assetRef);
  const matches = binding.googleAdsGoalPolicy?.accounts.filter(r => r.assetRef === assetRef && r.strategyRef === input.strategyRef
    && r.stage === input.stage && hash([...r.campaignIds].sort()) === hash([...input.campaignIds].sort())) || [];
  if (matches.length !== 1) fail('scope_denied');
  const policy = matches[0];
  const normalized = planner.normalizeConfiguredAccounts([{ customer_id: account.customerId, strategy_ref: policy.strategyRef,
    campaign_ids: policy.campaignIds, canonical_action_ids: policy.canonicalActionIds, bidding_action_key: policy.stage,
    owned_custom_goal_resource_name: policy.ownedGoalResourceName }])[0];
  return { ...account, policy, account: normalized };
}
function validateBinding(binding) {
  checkBinding({ value: binding.googleAdsGoalPolicy });
  if (binding.provider !== ads.PROVIDER) fail('invalid_request');
  const keys = new Set(), owned = new Set();
  for (const row of binding.googleAdsGoalPolicy.accounts) {
    const target = resource(binding, row.assetRef, { strategyRef: row.strategyRef, stage: row.stage, campaignIds: row.campaignIds });
    if (!row.allowCreate && !row.allowUpdate || row.ownedGoalResourceName && !row.allowUpdate
      || !row.ownedGoalResourceName && !row.allowCreate) fail('invalid_request');
    const key = row.assetRef + ':' + row.strategyRef;
    if (keys.has(key)) fail('invalid_request'); keys.add(key);
    for (const id of row.campaignIds) { const k = target.customerId + ':' + id; if (owned.has(k)) fail('invalid_request'); owned.add(k); }
  }
}
function scopeDigest(binding, assetRef, input, principal) {
  return hash({ target: resource(binding, assetRef, input), connection: binding.connectionRef, subject: binding.googleSubject,
    secretArn: binding.secretArn, clientSecretArn: binding.clientSecretArn, developerSecretArn: binding.developerSecretArn,
    principal: { id: principal.id, keyId: principal.keyId, publicKey: principal.publicKey } });
}
// Guarantee every later ACK/UNKNOWN/status envelope fits the existing projector.
// Use a worst-length own goal ID before create; never discover overflow only
// after an irreversible provider mutation. This does not broaden any row cap.
function assertResponseBudget(plan,target,planId) {
  const ownGoal=target.account.owned_custom_goal_resource_name||`customers/${target.customerId}/customConversionGoals/${'9'.repeat(20)}`;
  const phases=PHASES.map(phase=>{
    const operations=phaseOperations(plan,phase,ownGoal);
    return {phase,state:'unknown',requestId:'ffffffff-ffff-4fff-8fff-ffffffffffff',receiptSha256:'f'.repeat(64),
      resources:phase==='goal'?[ownGoal]:operations.map(op=>op.update.resourceName),
      knownMutationCount:operations.length,attemptedMutationCount:operations.length};
  });
  const maximum={planId,state:'prepared',expiresAt:Number.MAX_SAFE_INTEGER,planDigest:'f'.repeat(64),phases,validated:true};
  if(Buffer.byteLength(JSON.stringify(maximum))>32768)fail('action_plan_conflict');
  return Buffer.byteLength(JSON.stringify(maximum));
}
function phaseOperations(plan, phase, goalResource) {
  if (phase === 'goal') return plan.operations.custom_goal ? [plan.operations.custom_goal] : [];
  if (phase === 'campaign_config') return plan.operations.campaign_goal_configs.map(op => ({ ...op, update: { ...op.update,
    customConversionGoal: op.update.customConversionGoal === planner.NEW_GOAL_PLACEHOLDER ? goalResource : op.update.customConversionGoal } }));
  return plan.operations.campaign_conversion_goals;
}
function endpoint(customer, phase) {
  if (!/^[0-9]{10}$/.test(customer) || !PHASES.includes(phase)) fail('invalid_request');
  return `/${ads.API_VERSION}/customers/${customer}/${{ goal: 'customConversionGoals', campaign_config: 'conversionGoalCampaignConfigs', campaign_goals: 'campaignConversionGoals' }[phase]}:mutate`;
}
// A second transport boundary: this selector is built inside the typed operation,
// never accepted from the application. Only the exact three endpoint/mask sets.
function validateMutation(path, phase, body) {
  const match = typeof path === 'string' && path.match(/^\/v24\/customers\/([0-9]{10})\//);
  if (!match || endpoint(match[1], phase) !== path || !body || Object.getPrototypeOf(body) !== Object.prototype
    || Object.keys(body).sort().join(',') !== (phase === 'campaign_goals' ? 'operations,validateOnly' : 'operations,responseContentType,validateOnly')
    || typeof body.validateOnly !== 'boolean' || phase !== 'campaign_goals' && body.responseContentType !== 'RESOURCE_NAME_ONLY'
    || !Array.isArray(body.operations) || !body.operations.length || body.operations.length > (phase === 'goal' ? 1 : phase === 'campaign_config' ? 200 : 2000)) fail('invalid_request');
  for (const op of body.operations) {
    if (phase === 'goal' && op.create) {
      if (Object.keys(op).join(',') !== 'create' || Object.keys(op.create).sort().join(',') !== 'conversionActions,name,status'
        || op.create.status !== 'ENABLED' || typeof op.create.name !== 'string' || !op.create.name.startsWith(planner.GOAL_NAME_PREFIX + ' · ')
        || op.create.name.length > 255 || !Array.isArray(op.create.conversionActions) || op.create.conversionActions.length !== 1
        || !new RegExp(`^customers/${match[1]}/conversionActions/[1-9][0-9]{0,19}$`).test(op.create.conversionActions[0])) fail('invalid_request');
      continue;
    }
    if (Object.keys(op).sort().join(',') !== 'update,updateMask' || !op.update || Object.getPrototypeOf(op.update) !== Object.prototype) fail('invalid_request');
    const fields = { goal: 'conversionActions,resourceName', campaign_config: 'customConversionGoal,resourceName', campaign_goals: 'biddable,resourceName' };
    const masks = { goal: 'conversion_actions', campaign_config: 'custom_conversion_goal', campaign_goals: 'biddable' };
    const types = { goal: 'customConversionGoals/[1-9][0-9]{0,19}', campaign_config: 'conversionGoalCampaignConfigs/[1-9][0-9]{0,19}', campaign_goals: 'campaignConversionGoals/[1-9][0-9]{0,19}~[A-Z_]+~[A-Z_]+' };
    const ownGoal = x => new RegExp(`^customers/${match[1]}/customConversionGoals/[1-9][0-9]{0,19}$`).test(x);
    if (Object.keys(op.update).sort().join(',') !== fields[phase] || op.updateMask !== masks[phase]
      || !new RegExp(`^customers/${match[1]}/${types[phase]}$`).test(op.update.resourceName)
      || phase === 'goal' && (!Array.isArray(op.update.conversionActions) || op.update.conversionActions.length !== 1
        || !new RegExp(`^customers/${match[1]}/conversionActions/[1-9][0-9]{0,19}$`).test(op.update.conversionActions[0]))
      || phase === 'campaign_config' && !ownGoal(op.update.customConversionGoal)
      || phase === 'campaign_goals' && op.update.biddable !== false) fail('invalid_request');
  }
}
function result(raw, phase, operations, account, validateOnly) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['results', 'responseId'].includes(k))
    || raw.results !== undefined && !Array.isArray(raw.results)) fail('provider_failed');
  if (validateOnly) { if (raw.results?.length) fail('provider_failed'); return []; }
  if (raw.results?.length !== operations.length) fail('provider_failed');
  const names = raw.results.map((r, i) => {
    if (!r || Object.keys(r).join(',') !== 'resourceName') fail('provider_failed');
    const name = r.resourceName;
    if (phase === 'goal' ? typeof name !== 'string' || name.match(new RegExp(`^customers/${account.customerId}/customConversionGoals/[1-9][0-9]{0,19}$`))?.[0] !== name
      || operations[i].update && operations[i].update.resourceName !== name : operations[i].update.resourceName !== name) fail('provider_failed');
    return name;
  });
  if (new Set(names).size !== names.length) fail('provider_failed'); return names;
}
module.exports = { COHORT, OPERATIONS, PHASES, TTL_MS, bindingSchema, ownershipSchema, validate, validateBinding, resource,
  scopeDigest, hash, assertResponseBudget, phaseOperations, endpoint, validateMutation, result };
