'use strict';
const C = require('../../services/integrations-broker/src/google-data-manager-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { createGoogleConversionSubmissionRepository, MARKER } = require('./googleConversionSubmission.repository');
const { createGoogleConversionDelivery } = require('./googleConversionDelivery.service');
const { safe } = require('./googleDataManagerBrokerClient.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
const VERSION = 'broker_delivery_version';
const owned = row => row?.requestMetadata && (Object.hasOwn(row.requestMetadata, VERSION) || Object.hasOwn(row.requestMetadata, MARKER));
const record = row => ({ id: Number(row.id), assignment_scope: row.assignment_scope ?? null,
  clinic_id: row.clinic_id ?? null, group_id: row.group_id ?? null, config: row.config ?? null });
const configuration = () => ({ audience: process.env.GOOGLE_ADS_BROKER_AUDIENCE,
  keyId: process.env.GOOGLE_ADS_BROKER_KEY_ID, activeSince: process.env.GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE });
const localErrors = new Set(['conversion_submission_conflict', 'conversion_history_not_eligible', 'conversion_receipt_persistence_failed']);

function buildPayload({ conversionAction, eventName, eventSource, timestamp, eventId, value, currency,
  advertisingConsent, adUserData, adPersonalization, clickId, userIdentifiers, enhancedPolicyDigest }) {
  const action = /^customers\/\d{10}\/conversionActions\/([1-9][0-9]{0,19})$/.exec(conversionAction || '');
  if (!action) fail('invalid_request');
  return C.validate(C.OPERATIONS.ingest, { conversionActionId: action[1], eventName, eventSource,
    event: { timestamp, transactionId: eventId || null, value, currency, advertisingConsent,
      adUserData, adPersonalization, clickId: clickId ? { type: clickId.type, value: clickId.value } : null,
      userIdentifiers: userIdentifiers.map(row => ({ type: row.emailAddress ? 'email' : 'phone', sha256: row.emailAddress || row.phoneNumber })),
      enhancedPolicyDigest: userIdentifiers.length ? enhancedPolicyDigest : null } });
}

async function uploadManagedGoogleConversion({ runtime, models, auditModel, values, event, sourceRecords,
  revalidate, delivery, now = () => new Date(), enabled = () => process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true' }) {
  try {
    if (runtime?.deliveryMode !== 'broker' || typeof revalidate !== 'function') fail('broker_binding_invalid');
    const capturedRecords = sourceRecords.filter(Boolean).map(row => structuredClone(record(row)));
    const initialConfiguration = configuration();
    const guard = async () => {
      if (!enabled()) fail('broker_cohort_disabled');
      if (canonical(configuration()) !== canonical(initialConfiguration)) fail('broker_configuration_invalid');
      const captured = await runtime.broker.assert(runtime.account, runtime.brokerContext);
      const clinicIds = values.clinicaId == null ? captured.clinicIds : [Number(values.clinicaId)];
      for (const id of clinicIds) {
        if (!captured.clinicIds.includes(id)) fail('scope_denied');
        const clinic = await models.Clinica.findByPk(id, { attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'], raw: true, logging: false });
        if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)
          || values.grupoClinicaId != null && Number(clinic.grupoClinicaId) !== Number(values.grupoClinicaId)) fail('conversion_paused');
      }
      for (const before of capturedRecords) {
        if (!Number.isSafeInteger(before.id) || before.id < 1
          || (before.assignment_scope === 'clinic' ? Number(before.clinic_id) !== Number(values.clinicaId)
            : before.assignment_scope !== 'group' || Number(before.group_id) !== captured.groupId
              || Number(before.group_id) !== Number(values.grupoClinicaId))) fail('scope_denied');
        const fresh = await models.IntakeConfig.findByPk(before.id, {
          attributes: ['id', 'assignment_scope', 'clinic_id', 'group_id', 'config'], raw: true, logging: false });
        if (!fresh || canonical(record(fresh)) !== canonical(before)) fail('conversion_paused');
      }
      if (await revalidate() !== true) fail('conversion_paused');
      if (canonical(configuration()) !== canonical(initialConfiguration)) fail('broker_configuration_invalid');
      if (!enabled()) fail('broker_cohort_disabled');
      return true;
    };
    await guard();
    if (!delivery) {
      const { audience, keyId, activeSince } = initialConfiguration;
      delivery = createGoogleConversionDelivery({ broker: runtime.broker, enabled,
        repository: createGoogleConversionSubmissionRepository({ models, assertContext: runtime.broker.assert,
          deliveryIdentity: { audience, keyId }, activeSince, now }) });
    }
    const at = now();
    let attempt = await auditModel.findOne({ where: { dedupeKey: values.dedupeKey } });
    // Creation is insert-only. A separate marker closes the legacy route during
    // the interval before the journal reserves its UUID, including a process crash.
    const timestamp = event.timestamp || attempt?.requestMetadata?.conversion_occurred_at || at.toISOString();
    buildPayload({ ...event, timestamp });
    if (!attempt) {
      try {
        attempt = await auditModel.create({ ...values, requestMetadata: { ...values.requestMetadata,
          [VERSION]: 1, conversion_occurred_at: timestamp }, status: 'pending', reason: null,
          attemptCount: 1, attemptedAt: at, created_at: at, updated_at: at, completedAt: null, history: [] });
      } catch (error) {
        if (error?.name !== 'SequelizeUniqueConstraintError' && error?.original?.code !== 'ER_DUP_ENTRY') throw error;
        attempt = await auditModel.findOne({ where: { dedupeKey: values.dedupeKey } });
        if (!attempt) throw error;
      }
    }
    if (attempt.requestMetadata?.[VERSION] !== 1) fail('conversion_history_not_eligible');
    const resolvedTimestamp = event.timestamp || attempt.requestMetadata.conversion_occurred_at;
    const metadata = { ...attempt.requestMetadata }; delete metadata[MARKER];
    const expected = { ...values.requestMetadata, [VERSION]: 1, conversion_occurred_at: resolvedTimestamp };
    if (canonical(metadata) !== canonical(expected)) fail('conversion_submission_conflict');
    for (const field of ['clinicaId', 'grupoClinicaId', 'intakeConfigId', 'assignmentScope', 'destinationKey',
      'googleConnectionId', 'googleConnectionAssignmentId', 'connectionSource', 'customerId', 'loginCustomerId',
      'conversionAction', 'eventName', 'eventId', 'clickIdType', 'clickIdHash', 'consentStatus']) {
      if ((attempt[field] ?? null) !== (values[field] ?? null)) fail('conversion_submission_conflict');
    }
    const payload = buildPayload({ ...event, timestamp: resolvedTimestamp });
    const result = await delivery.submit({ account: runtime.account, context: runtime.brokerContext,
      attemptId: attempt.id, dedupeKey: values.dedupeKey, payload, beforeExecute: guard });
    const accepted = ['accepted', 'succeeded', 'partial_success'].includes(result.state);
    return { sent: result.dispatch === true && accepted, accepted,
      reason: accepted ? result.dispatch ? 'provider_processing'
        : result.state === 'succeeded' ? 'duplicate_already_succeeded' : 'duplicate_already_accepted'
        : result.state === 'failed' ? 'provider_error' : 'broker_outcome_unknown',
      ...(result.state === 'failed' ? { error_code: 'DATA_MANAGER_PROCESSING_FAILED' } : {}),
      audit_id: attempt.id, submission_id: result.submissionId,
      ...(accepted ? { result: { requestId: result.providerRequestId } } : {}) };
  } catch (error) { fail(localErrors.has(error?.code) ? error.code : safe(error)); }
}
module.exports = { uploadManagedGoogleConversion, buildPayload, owned, VERSION };
