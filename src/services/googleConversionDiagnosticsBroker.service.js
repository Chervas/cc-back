'use strict';
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { createGoogleConversionSubmissionRepository, MARKER, auditDigest } = require('./googleConversionSubmission.repository');
const { createGoogleConversionDelivery } = require('./googleConversionDelivery.service');
const { assertGoogleConversionReceiptPolicy } = require('./googleConversionDiagnosticsPolicy.service');
const { MAPPING_FIELDS } = require('./googleAdsBrokerScope.service');
const { GOOGLE_DATA_MANAGER_SCOPE, missingGoogleScopes } = require('./googleAdsScopedRuntime.service');
const { safe: brokerSafe } = require('./googleDataManagerBrokerClient.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
const localCodes = new Set(['conversion_submission_conflict', 'conversion_history_not_eligible', 'conversion_receipt_persistence_failed']);
const safe = error => localCodes.has(error?.code) ? error.code
  : /^(workspace_|google_lead_)/.test(error?.code || '') ? 'conversion_paused' : brokerSafe(error);
const settings = env => ({ audience: env.GOOGLE_ADS_BROKER_AUDIENCE, keyId: env.GOOGLE_ADS_BROKER_KEY_ID,
  activeSince: env.GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

async function reconcileManagedGoogleConversion({ models, attemptId, now = () => new Date(), env = process.env }) {
  let repository, identity;
  try {
    const broker = require('./googleAdsBroker.service').forModels(models);
    const configured = settings(env);
    repository = createGoogleConversionSubmissionRepository({ models, assertContext: broker.assert,
      deliveryIdentity: { audience: configured.audience, keyId: configured.keyId }, activeSince: configured.activeSince, now });
    const attempt = await models.GoogleAdsConversionUploadAttempt.findByPk(attemptId, { raw: true, logging: false });
    if (!attempt || attempt.requestMetadata?.broker_delivery_version !== 1 || !uuid(attempt.requestMetadata?.[MARKER])) fail('conversion_history_not_eligible');
    const journal = await models.GoogleConversionSubmission.findByPk(attempt.requestMetadata[MARKER], { raw: true, logging: false });
    if (!journal || String(journal.attempt_id) !== String(attempt.id)) fail('conversion_submission_conflict');
    identity = { attemptId: attempt.id, submissionId: journal.submission_id };
    const enabled = () => env.GOOGLE_ADS_BROKER_ENABLED === 'true' && env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true';
    if (!enabled()) fail('broker_cohort_disabled');
    const account = await models.ClinicGoogleAdsAccount.findByPk(journal.mapping_id, { attributes: MAPPING_FIELDS, raw: true, logging: false });
    if (!account) fail('broker_binding_invalid');
    const context = await broker.prepare(account);
    if (!context) fail('broker_binding_invalid');
    const captured = await broker.assert(account, context);
    const connection = await models.GoogleConnection.findByPk(captured.googleConnectionId, {
      attributes: ['id', 'googleUserId', 'scopes'], raw: true, logging: false });
    if (!connection || connection.googleUserId !== captured.googleSubject
      || missingGoogleScopes(connection.scopes, [GOOGLE_DATA_MANAGER_SCOPE]).length) fail('scope_denied');
    const runtime = { deliveryMode: 'broker', broker, account, brokerContext: context, connection,
      connectionSource: attempt.connectionSource, loginCustomerId: captured.loginCustomerId };
    const initialAudit = auditDigest(attempt); let initialPolicy;
    const guard = async () => {
      if (!enabled()) fail('broker_cohort_disabled');
      if (canonical(settings(env)) !== canonical(configured)) fail('broker_configuration_invalid');
      await broker.assert(account, context);
      const fresh = await models.GoogleAdsConversionUploadAttempt.findByPk(attempt.id, { raw: true, logging: false });
      if (!fresh || fresh.requestMetadata?.[MARKER] !== journal.submission_id || auditDigest(fresh) !== initialAudit) fail('conversion_submission_conflict');
      const metadata = await models.GoogleConnection.findByPk(connection.id, {
        attributes: ['id', 'googleUserId', 'scopes'], raw: true, logging: false });
      if (!metadata || canonical(metadata) !== canonical(connection)) fail('scope_denied');
      const policy = await assertGoogleConversionReceiptPolicy({ models, attempt: fresh, runtime, now: now() });
      if (initialPolicy !== undefined && policy !== initialPolicy) fail('conversion_paused');
      initialPolicy = policy;
      if (canonical(settings(env)) !== canonical(configured)) fail('broker_configuration_invalid');
      await broker.assert(account, context);
      return true;
    };
    const delivery = createGoogleConversionDelivery({ repository, broker, enabled });
    const result = await delivery.reconcile({ ...identity, account, context, beforeExecute: guard });
    if (result.state === 'prepared') await repository.diagnosticError(identity, { code: 'outcome_unknown' });
    return result;
  } catch (error) {
    const code = safe(error);
    if (repository && identity) {
      try { await repository.diagnosticError(identity, { code }); }
      catch { fail('conversion_receipt_persistence_failed'); }
    }
    fail(code);
  }
}
module.exports = { reconcileManagedGoogleConversion };
