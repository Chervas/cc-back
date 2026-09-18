'use strict';
const { schema, ref } = require('./contracts');
const ads = require('./google-ads-contract');
const { fail } = require('./errors');
const { createHash } = require('node:crypto');
const { canonical } = require('./canonical');
const PROVIDER = ads.PROVIDER;
const COHORT = 'google-ads-conversions-v1';
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/datamanager']);
const OPERATIONS = Object.freeze({ validate: 'google.ads.conversion.validate.v1',
  ingest: 'google.ads.conversion.ingest.v1', status: 'google.ads.conversion.status.v1' });
const EVENTS = ['lead', 'contact', 'qualified_lead', 'schedule', 'purchase'];
const SOURCES = ['WEB', 'OTHER'];
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const id = { type: 'string', pattern: '^[1-9][0-9]{0,19}$' };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nullableDigest = { ...digest, type: ['string', 'null'] };
const stamp = { type: 'string', pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' };
const identifiers = ['email', 'phone'];
const bindingSchema = object({
  quotaProjectId: { type: 'string', pattern: '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' },
  destinations: { type: 'array', minItems: 0, maxItems: 1000, items: object({ assetRef: ref,
    conversionActionId: id, events: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: EVENTS } },
    sources: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: SOURCES } },
    enhancedPolicy: { anyOf: [{ type: 'null' }, object({ digest, notBefore: stamp, expiresAt: stamp,
      permittedIdentifiers: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: identifiers } } })] } }) },
});
const validateBindingShape = schema({ value: bindingSchema });
const choice = { conversionActionId: id, eventName: { enum: EVENTS }, eventSource: { enum: SOURCES } };
const eventSchema = object({ timestamp: stamp, transactionId: { type: ['string', 'null'], pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$' },
  value: { type: 'number', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
  currency: { type: 'string', pattern: '^[A-Z]{3}$' }, advertisingConsent: { const: 'GRANTED' },
  adUserData: { enum: [null, 'GRANTED', 'DENIED'] }, adPersonalization: { enum: [null, 'GRANTED', 'DENIED'] },
  clickId: { anyOf: [{ type: 'null' }, object({ type: { enum: ['gclid', 'gbraid', 'wbraid'] },
    value: { type: 'string', pattern: '^[A-Za-z0-9_.~-]{1,2048}$' } })] },
  userIdentifiers: { type: 'array', maxItems: 2, items: object({ type: { enum: identifiers }, sha256: digest }) },
  enhancedPolicyDigest: nullableDigest,
});
const validators = { [OPERATIONS.validate]: schema(choice), [OPERATIONS.ingest]: schema({ ...choice, event: eventSchema }),
  [OPERATIONS.status]: schema({ submissionId: uuid }) };
const validStamp = value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validate(operation, payload) {
  if (!Object.hasOwn(validators, operation)) fail('operation_denied');
  validators[operation](payload);
  if (operation === OPERATIONS.ingest) {
    const event = payload.event;
    if (!validStamp(event.timestamp) || !Number.isFinite(event.value)
      || new Set(event.userIdentifiers.map(row => row.type)).size !== event.userIdentifiers.length
      || !event.clickId && !event.userIdentifiers.length
      || Boolean(event.enhancedPolicyDigest) !== Boolean(event.userIdentifiers.length)
      || event.userIdentifiers.length && (event.adUserData !== 'GRANTED' || event.adPersonalization === null)) fail('invalid_request');
  }
  return payload;
}
function validateBinding(binding) {
  validateBindingShape({ value: binding.googleDataManager });
  if (binding.provider !== PROVIDER || !binding.googleDataManager.destinations.length && !binding.googleDataManagerEnrollment) fail('invalid_request');
  const seen = new Set();
  for (const row of binding.googleDataManager.destinations) {
    ads.resource(binding, row.assetRef);
    const key = row.assetRef + ':' + row.conversionActionId;
    if (seen.has(key)) fail('invalid_request'); seen.add(key);
    if (row.enhancedPolicy && (!validStamp(row.enhancedPolicy.notBefore) || !validStamp(row.enhancedPolicy.expiresAt)
      || row.enhancedPolicy.expiresAt <= row.enhancedPolicy.notBefore)) fail('invalid_request');
  }
  return binding;
}
function resource(binding, assetRef, payload) {
  const account = ads.resource(binding, assetRef);
  const destination = binding.googleDataManager?.destinations.find(row => row.assetRef === assetRef
    && row.conversionActionId === payload.conversionActionId && row.events.includes(payload.eventName)
    && row.sources.includes(payload.eventSource));
  if (!destination) fail('scope_denied');
  return { ...account, destination, quotaProjectId: binding.googleDataManager.quotaProjectId };
}
function assertEnhanced(resource, event, now) {
  if (!event.userIdentifiers.length) return;
  const policy = resource.destination.enhancedPolicy;
  if (!policy || event.enhancedPolicyDigest !== policy.digest || now < Date.parse(policy.notBefore)
    || now >= Date.parse(policy.expiresAt) || event.userIdentifiers.some(row => !policy.permittedIdentifiers.includes(row.type))) fail('scope_denied');
}
function scopeDigest(binding, assetRef, payload, target = resource(binding, assetRef, payload)) {
  return createHash('sha256').update(canonical({ connectionRef: binding.connectionRef, subject: binding.googleSubject,
    secretArn: binding.secretArn, clientSecretArn: binding.clientSecretArn, assetRef,
    customerId: target.customerId, loginCustomerId: target.loginCustomerId, quotaProjectId: target.quotaProjectId,
    conversionActionId: payload.conversionActionId, eventName: payload.eventName, eventSource: payload.eventSource,
    ...(target.authorizationId ? { authorizationId: target.authorizationId, authorizationDigest: target.authorizationDigest } : {}) })).digest('hex');
}
function destination(target) {
  return { operatingAccount: { accountType: 'GOOGLE_ADS', accountId: target.customerId },
    ...(target.loginCustomerId ? { loginAccount: { accountType: 'GOOGLE_ADS', accountId: target.loginCustomerId } } : {}),
    productDestinationId: target.destination.conversionActionId };
}
function body(operation, payload, target, requestId, now) {
  validate(operation, payload);
  const validation = operation === OPERATIONS.validate;
  if (!validation && operation !== OPERATIONS.ingest) fail('operation_denied');
  const input = payload.event;
  if (!validation) assertEnhanced(target, input, now);
  const event = { eventTimestamp: validation ? new Date(now).toISOString() : input.timestamp,
    eventSource: payload.eventSource, eventName: payload.eventName,
    transactionId: validation ? 'cc-check-' + requestId : input.transactionId || requestId,
    conversionValue: validation ? 0 : input.value, currency: validation ? 'EUR' : input.currency };
  if (validation) event.adIdentifiers = { gclid: 'GCLID_1' };
  else {
    if (input.clickId) event.adIdentifiers = { [input.clickId.type]: input.clickId.value };
    const consent = {};
    if (input.adUserData) consent.adUserData = 'CONSENT_' + input.adUserData;
    if (input.adPersonalization) consent.adPersonalization = 'CONSENT_' + input.adPersonalization;
    if (Object.keys(consent).length) event.consent = consent;
    if (input.userIdentifiers.length) event.userData = { userIdentifiers: input.userIdentifiers.map(row =>
      ({ [row.type === 'email' ? 'emailAddress' : 'phoneNumber']: row.sha256 })) };
  }
  return { destinations: [destination(target)], events: [event], validateOnly: validation,
    ...(!validation && input.userIdentifiers.length ? { encoding: 'HEX' } : {}) };
}
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const providerId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(value);
function ingestResult(raw, requestId, validation) {
  if (!plain(raw) || raw.error || raw.errors || raw.partialFailureError
    || raw.fieldWarnings !== undefined && (!Array.isArray(raw.fieldWarnings) || raw.fieldWarnings.length > 100)) fail('provider_failed');
  const warningCount = raw.fieldWarnings?.length || 0;
  // validateOnly explicitly returns no results; an empty successful JSON is valid.
  if (validation) return { validated: warningCount === 0, warningCount };
  if (!providerId(raw.requestId)) fail('provider_failed');
  return { accepted: true, submissionId: requestId, requestId: raw.requestId, warningCount };
}
const statuses = new Set(['REQUEST_STATUS_UNKNOWN', 'PROCESSING', 'SUCCESS', 'FAILED', 'PARTIAL_SUCCESS']);
const reasons = new Set(require('./google-data-manager-reasons.json').values);
function count(value) {
  if (value === undefined) return 0;
  if (!['number', 'string'].includes(typeof value) || !/^[01]$/.test(String(value))) fail('provider_failed');
  return Number(value);
}
function summaries(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) fail('provider_failed');
  return value.map(row => { if (!plain(row)) fail('provider_failed');
    return { reason: reasons.has(row.reason) ? row.reason : 'UNKNOWN', recordCount: count(row.recordCount) }; });
}
function statusResult(raw, target) {
  if (!plain(raw) || raw.error || raw.errors
    || raw.requestStatusPerDestination !== undefined && !Array.isArray(raw.requestStatusPerDestination)
    || raw.requestStatusPerDestination?.length > 1) fail('provider_failed');
  if (!raw.requestStatusPerDestination?.length) return { requestStatusPerDestination: [] };
  const row = raw.requestStatusPerDestination[0], expected = destination(target), received = row?.destination;
  const status = row?.requestStatus ?? 'REQUEST_STATUS_UNKNOWN';
  if (!plain(row) || !plain(received) || received.operatingAccount?.accountType !== 'GOOGLE_ADS'
    || received.operatingAccount?.accountId !== target.customerId || received.productDestinationId !== expected.productDestinationId
    || (received.loginAccount !== undefined && (received.loginAccount?.accountType !== 'GOOGLE_ADS'
      || received.loginAccount?.accountId !== target.loginCustomerId))
    || !statuses.has(status) || row.audienceMembersIngestionStatus !== undefined
    || row.audienceMembersRemovalStatus !== undefined || row.removeAllAudienceMembersStatus !== undefined
    || row.eventsIngestionStatus !== undefined && !plain(row.eventsIngestionStatus)
    || row.errorInfo !== undefined && !plain(row.errorInfo) || row.warningInfo !== undefined && !plain(row.warningInfo)
    || ['SUCCESS', 'FAILED', 'PARTIAL_SUCCESS'].includes(status) && count(row.eventsIngestionStatus?.recordCount) !== 1) fail('provider_failed');
  return { requestStatusPerDestination: [{ destination: expected, requestStatus: status,
    eventsIngestionStatus: { recordCount: count(row.eventsIngestionStatus?.recordCount) },
    errorInfo: { errorCounts: summaries(row.errorInfo?.errorCounts) }, warningInfo: { warningCounts: summaries(row.warningInfo?.warningCounts) } }] };
}
module.exports = { PROVIDER, COHORT, SCOPES, OPERATIONS, bindingSchema, validateBinding, validate, resource,
  assertEnhanced, scopeDigest, body, ingestResult, statusResult, providerId };
