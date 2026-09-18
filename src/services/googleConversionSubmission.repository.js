'use strict';
const { createHash, randomUUID } = require('node:crypto');
const C = require('../../services/integrations-broker/src/google-data-manager-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { safe } = require('./googleDataManagerBrokerClient.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positive = value => ['number', 'string'].includes(typeof value) && /^[1-9][0-9]{0,19}$/.test(String(value))
  && (typeof value !== 'number' || Number.isSafeInteger(value)) && BigInt(value) <= 18446744073709551615n;
const plain = row => row?.get ? row.get({ plain: true }) : row;
const terminal = state => ['succeeded', 'partial_success', 'failed'].includes(state);
const accepted = state => state === 'accepted' || terminal(state);
const MARKER = 'broker_submission_id';
const auditFields = ['id', 'dedupeKey', 'clinicaId', 'grupoClinicaId', 'intakeConfigId', 'googleConnectionId',
  'googleConnectionAssignmentId', 'assignmentScope', 'destinationKey', 'connectionSource', 'customerId', 'loginCustomerId',
  'conversionAction', 'eventName', 'eventId', 'clickIdType', 'clickIdHash', 'consentStatus', 'attemptCount', 'requestMetadata',
  'attemptedAt', 'created_at', 'status', 'reason', 'providerRequestId', 'responseMetadata', 'history',
  'completedAt', 'lastErrorCode', 'lastErrorMessage'];
function auditDigest(attempt) {
  const row = plain(attempt), metadata = { ...row.requestMetadata }; delete metadata[MARKER];
  const keys = auditFields.filter(key => !['status', 'reason', 'providerRequestId', 'responseMetadata', 'history',
    'completedAt', 'lastErrorCode', 'lastErrorMessage'].includes(key));
  return digest(Object.fromEntries(keys.map(key => [key, key === 'requestMetadata' ? metadata
    : row[key] instanceof Date ? row[key].toISOString() : row[key] ?? null])));
}
const dto = row => ({ submissionId: row.submission_id, attemptId: String(row.attempt_id), state: row.state,
  providerRequestId: row.provider_request_id, conversionActionId: row.conversion_action_id, lastError: row.last_error });
function createGoogleConversionSubmissionRepository({ models, assertContext, deliveryIdentity, activeSince, now = () => new Date() }) {
  if (typeof assertContext !== 'function' || !deliveryIdentity || Object.keys(deliveryIdentity).sort().join(',') !== 'audience,keyId'
    || !['audience', 'keyId'].every(key => typeof deliveryIdentity[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(deliveryIdentity[key]))
    || typeof activeSince !== 'string' || !Number.isFinite(Date.parse(activeSince)) || new Date(activeSince).toISOString() !== activeSince) fail('broker_configuration_invalid');
  const startAt = Date.parse(activeSince), deliveryDigest = digest({ ...deliveryIdentity, activeSince });
  const getModels = () => typeof models === 'function' ? models() : models;
  const options = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, logging: false });
  const trans = work => getModels().sequelize.transaction(work);
  function date() { const value = now(); if (!(value instanceof Date) || !Number.isFinite(+value) || +value < startAt) fail('broker_cohort_disabled'); return value; }
  async function scope(account, context, transaction) {
    const row = await assertContext(account, context, { transaction });
    if (!row || row.discoveryOnly !== false || !positive(row.id) || !positive(row.googleConnectionId)
      || !/^clinic:[1-9][0-9]{0,9}$/.test(row.tenantRef || '') || row.assetRef !== 'ads:' + row.customerId) fail('broker_binding_invalid');
    return row;
  }
  function matchScope(row, captured) {
    if (row.scope_digest !== digest(captured) || row.delivery_digest !== deliveryDigest) fail('conversion_submission_conflict');
  }
  async function audit(id, transaction) {
    if (!positive(id)) fail('invalid_request');
    const row = await getModels().GoogleAdsConversionUploadAttempt.findByPk(id, { ...options(transaction), attributes: auditFields });
    if (!row) fail('conversion_submission_conflict'); return row;
  }
  function matchAudit(row, attempt) {
    if (String(row.attempt_id) !== String(attempt.id) || row.dedupe_key !== attempt.dedupeKey
      || attempt.requestMetadata?.[MARKER] !== row.submission_id || auditDigest(attempt) !== row.audit_digest) fail('conversion_submission_conflict');
    if (attempt.status !== (accepted(row.state) ? row.state : 'pending')) fail('conversion_submission_conflict');
  }
  async function load(input, transaction) {
    if (typeof input.submissionId !== 'string' || !UUID.test(input.submissionId)) fail('invalid_request');
    // All paths lock attempt first, then journal, preventing cross-operation deadlocks.
    const attempt = await audit(input.attemptId, transaction);
    const row = await getModels().GoogleConversionSubmission.findByPk(input.submissionId, options(transaction));
    if (!row) fail('conversion_submission_conflict');
    const captured = await scope(input.account, input.context, transaction);
    matchScope(row, captured); matchAudit(row, attempt); return { row, attempt };
  }
  async function applyReceipt(row, attempt, state, receipt, transaction) {
    if (row.provider_request_id && receipt.providerRequestId && row.provider_request_id !== receipt.providerRequestId) fail('broker_response_invalid');
    if (terminal(row.state)) {
      if (state !== 'accepted' && state !== row.state) fail('broker_response_invalid');
      return dto(row); // A late PROCESSING response never downgrades a terminal result.
    }
    if (row.state === 'prepared') fail('conversion_submission_conflict');
    const at = date(), isTerminal = terminal(state);
    const providerId = receipt.providerRequestId || row.provider_request_id;
    await row.update({ state, provider_request_id: providerId, acknowledged_at: row.acknowledged_at || at,
      updated_at: at, completed_at: isTerminal ? at : null, last_error: null }, options(transaction));
    const reason = state === 'accepted' ? 'provider_processing' : state === 'failed' ? 'provider_processing_failed'
      : state === 'partial_success' ? 'provider_partial_success' : null;
    await attempt.update({ status: state, reason, providerRequestId: providerId, completedAt: isTerminal ? at : null,
      history: isTerminal ? [...(Array.isArray(attempt.history) ? attempt.history : []), { status: attempt.status,
        reason: attempt.reason || null, attempted_at: attempt.attemptedAt, completed_at: attempt.completedAt || null,
        error_code: attempt.lastErrorCode || null, error_message: attempt.lastErrorMessage || null }].slice(-20) : attempt.history,
      lastErrorCode: state === 'failed' ? 'DATA_MANAGER_PROCESSING_FAILED' : null,
      lastErrorMessage: state === 'failed' ? 'Google Data Manager rechazó la conversión durante el procesamiento' : null,
      responseMetadata: { ...(attempt.responseMetadata || {}), transport: 'google_data_manager', delivery_mode: 'broker',
        request_accepted: true, result_count: 0, partial_failure: false, has_job_id: false,
        broker_submission_id: row.submission_id, processing_status: state === 'accepted' ? 'PROCESSING' : state.toUpperCase(),
        ...(receipt.warningCount !== undefined ? { warning_count: receipt.warningCount } : {}),
        ...(receipt.destinations ? { diagnostics_checked_at: at.toISOString(), destinations: receipt.destinations } : {}) },
    }, options(transaction));
    return dto(row);
  }
  return {
    async reserve({ account, context, attemptId, dedupeKey, payload }) {
      C.validate(C.OPERATIONS.ingest, payload); const data = structuredClone(payload), payloadDigest = digest(data);
      if (typeof dedupeKey !== 'string' || !/^[a-f0-9]{64}$/.test(dedupeKey)) fail('invalid_request');
      return trans(async transaction => {
        const attempt = await audit(attemptId, transaction), captured = await scope(account, context, transaction);
        const old = await getModels().GoogleConversionSubmission.findOne({ where: { dedupe_key: dedupeKey }, ...options(transaction) });
        if (old) {
          matchScope(old, captured); matchAudit(old, attempt);
          if (old.payload_digest !== payloadDigest) fail('idempotency_conflict'); return dto(old);
        }
        const at = date(), metadata = attempt.requestMetadata;
        if (attempt.dedupeKey !== dedupeKey || attempt.requestMetadata && Object.hasOwn(attempt.requestMetadata, MARKER)
          || attempt.status !== 'pending' || Number(attempt.attemptCount) !== 1 || attempt.providerRequestId != null
          || !(attempt.created_at instanceof Date) || +attempt.created_at < startAt || +attempt.created_at > +at
          || !(attempt.attemptedAt instanceof Date) || +attempt.attemptedAt < startAt || +attempt.attemptedAt > +at
          || +attempt.attemptedAt < +at - 300000 || Date.parse(data.event.timestamp) < startAt || Date.parse(data.event.timestamp) > +at)
          fail('conversion_history_not_eligible');
        if (Number(attempt.googleConnectionId) !== captured.googleConnectionId || attempt.customerId !== captured.customerId
          || (attempt.loginCustomerId || null) !== captured.loginCustomerId
          || (attempt.assignmentScope === 'group' ? 'group:' + attempt.grupoClinicaId : 'clinic:' + attempt.clinicaId) !== captured.scopeKey
          || attempt.clinicaId != null && !captured.clinicIds.includes(Number(attempt.clinicaId))
          || attempt.conversionAction !== `customers/${captured.customerId}/conversionActions/${data.conversionActionId}`
          || attempt.eventName !== data.eventName || (attempt.eventId || null) !== data.event.transactionId
          || attempt.consentStatus !== 'GRANTED' || (attempt.clickIdType || null) !== (data.event.clickId?.type || null)
          || (attempt.clickIdHash || null) !== (data.event.clickId ? hash(data.event.clickId.value) : null)
          || !metadata || metadata.currency !== data.event.currency
          || metadata.conversion_occurred_at != null && metadata.conversion_occurred_at !== data.event.timestamp
          || data.eventSource !== (metadata.consent_source === 'google_ads_native_crm' ? 'OTHER' : 'WEB')
          || (metadata.value_amount ?? 0) !== data.event.value
          || (metadata.explicit_ad_user_data_consent_status || 'UNSPECIFIED') !== (data.event.adUserData || 'UNSPECIFIED')
          || (metadata.visitor_ad_personalization_consent_status || 'UNSPECIFIED') !== (data.event.adPersonalization || 'UNSPECIFIED')
          || Number(metadata.user_identifier_count || 0) !== data.event.userIdentifiers.length
          || (metadata.enhanced_conversion_authorization_digest || null) !== data.event.enhancedPolicyDigest) fail('conversion_submission_conflict');
        const row = await getModels().GoogleConversionSubmission.create({ submission_id: randomUUID(), attempt_id: attempt.id,
          dedupe_key: dedupeKey, mapping_id: captured.id, google_connection_id: captured.googleConnectionId,
          connection_ref: captured.connectionRef, asset_ref: captured.assetRef, tenant_ref: captured.tenantRef,
          customer_id: captured.customerId, login_customer_id: captured.loginCustomerId,
          conversion_action_id: data.conversionActionId, event_name: data.eventName,
          scope_digest: digest(captured), delivery_digest: deliveryDigest, audit_digest: auditDigest(attempt), payload_digest: payloadDigest,
          state: 'prepared', provider_request_id: null, created_at: at, updated_at: at,
          attempted_at: null, acknowledged_at: null, completed_at: null, last_error: null }, options(transaction));
        await attempt.update({ requestMetadata: { ...metadata, [MARKER]: row.submission_id } }, options(transaction));
        await scope(account, context, transaction); return dto(row);
      });
    },
    begin(input) {
      C.validate(C.OPERATIONS.ingest, input.payload); const expectedDigest = digest(input.payload);
      return trans(async transaction => {
        const { row } = await load(input, transaction);
        if (row.payload_digest !== expectedDigest) fail('idempotency_conflict');
        if (row.state !== 'prepared') return { ...dto(row), dispatch: false };
        const at = date();
        if (+at - +row.created_at > 300000) fail('conversion_history_not_eligible');
        await row.update({ state: 'attempted', attempted_at: at, updated_at: at }, options(transaction));
        return { ...dto(row), dispatch: true };
      });
    },
    inspect: input => trans(async transaction => dto((await load(input, transaction)).row)),
    unknown(input, error) {
      // Persist delivery uncertainty even if permission was revoked while the
      // request was in flight. This grants no access, does not issue any request,
      // and can only update the exact already-attempted local record.
      return trans(async transaction => {
        if (!UUID.test(input.submissionId || '')) fail('invalid_request');
        const attempt = await audit(input.attemptId, transaction);
        const row = await getModels().GoogleConversionSubmission.findByPk(input.submissionId, options(transaction));
        if (!row || row.delivery_digest !== deliveryDigest) fail('conversion_submission_conflict'); matchAudit(row, attempt);
        if (row.state !== 'attempted' && row.state !== 'unknown') return dto(row);
        const at = date(), code = safe(error);
        await row.update({ state: 'unknown', last_error: code, updated_at: at }, options(transaction));
        await attempt.update({ status: 'pending', reason: 'broker_outcome_unknown', completedAt: null,
          lastErrorCode: code, lastErrorMessage: 'Resultado de envío pendiente de conciliación; no se reenviará automáticamente' }, options(transaction));
        return dto(row);
      });
    },
    acknowledge(input, result) {
      if (!result || result.accepted !== true || result.submissionId !== input.submissionId || !C.providerId(result.requestId)
        || !Number.isInteger(result.warningCount) || result.warningCount < 0 || result.warningCount > 100) fail('broker_response_invalid');
      return trans(async transaction => { const { row, attempt } = await load(input, transaction);
        return applyReceipt(row, attempt, 'accepted', { providerRequestId: result.requestId, warningCount: result.warningCount }, transaction); });
    },
    reconcile(input, result) {
      return trans(async transaction => {
        const { row, attempt } = await load(input, transaction); let projected;
        if (!result || Object.keys(result).sort().join(',') !== 'requestId,requestStatusPerDestination,submissionId'
          || result.submissionId !== row.submission_id || !C.providerId(result.requestId)) fail('broker_response_invalid');
        try { projected = C.statusResult(result, { customerId: row.customer_id, loginCustomerId: row.login_customer_id,
          destination: { conversionActionId: row.conversion_action_id } }); } catch { fail('broker_response_invalid'); }
        if (canonical(projected.requestStatusPerDestination) !== canonical(result.requestStatusPerDestination)) fail('broker_response_invalid');
        const status = result.requestStatusPerDestination[0]?.requestStatus;
        const state = { SUCCESS: 'succeeded', FAILED: 'failed', PARTIAL_SUCCESS: 'partial_success' }[status] || 'accepted';
        const destinations = projected.requestStatusPerDestination.map(entry => ({ status: entry.requestStatus,
          customer_id: entry.destination.operatingAccount.accountId, conversion_action_id: entry.destination.productDestinationId,
          record_count: entry.eventsIngestionStatus.recordCount,
          errors: entry.errorInfo.errorCounts.slice(0, 20).map(item => ({ reason: item.reason, record_count: item.recordCount })),
          warnings: entry.warningInfo.warningCounts.slice(0, 20).map(item => ({ reason: item.reason, record_count: item.recordCount })) }));
        return applyReceipt(row, attempt, state, { providerRequestId: result.requestId, destinations }, transaction);
      });
    },
  };
}
module.exports = { createGoogleConversionSubmissionRepository, MARKER, auditDigest };
