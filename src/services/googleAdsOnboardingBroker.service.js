'use strict';
const { randomUUID } = require('node:crypto');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { mapConversionActionRow, buildSuggestedMapping, buildClinicaclickManagedMapping,
  inspectCanonicalConversion } = require('./googleAdsConversionPreparation.service');
const ADS = 'https://www.googleapis.com/auth/adwords';
const DM = 'https://www.googleapis.com/auth/datamanager';
const scopes = value => [...new Set(String(value || '').split(/[\s,]+/).filter(Boolean))].sort();
const fail = code => { throw Object.assign(Error(code), { code, httpStatus: code === 'scope_denied' ? 403 : 409 }); };

// Read/validate only. There is no event body, token, action mutation or ingestion
// method at this boundary. The caller owns the current user/scope ACL check.
function createGoogleAdsOnboardingBroker({ runtime, models, clinicIds, beforeExecute, now = Date.now, deadlineAt = null }) {
  if (runtime?.deliveryMode !== 'broker' || typeof beforeExecute !== 'function'
    || !Array.isArray(clinicIds) || !clinicIds.length
    || clinicIds.some(id => !Number.isSafeInteger(id) || id < 1)) fail('broker_binding_invalid');
  const { broker, account, brokerContext, customerId, loginCustomerId } = runtime;
  const connection = { id: Number(runtime.connection?.id), subject: runtime.connection?.googleUserId,
    scopes: scopes(runtime.connection?.scopes) };
  const selectedClinics = [...new Set(clinicIds)].sort((a, b) => a - b);
  const deadline = Math.min(now() + 55000, deadlineAt ?? Infinity);
  let captured, listed;
  const remaining = max => {
    const value = Math.min(max, deadline - now());
    if (value < 1) fail('broker_timeout');
    return value;
  };
  const guard = async (dataManager = false, verifiedContext = null, transaction = null) => {
    remaining(15000);
    if (await beforeExecute() !== true) fail('scope_denied');
    const locked = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
    const current = verifiedContext || await broker.assert(account, brokerContext, transaction ? { transaction } : undefined);
    if (current.customerId !== customerId || (current.loginCustomerId || null) !== (loginCustomerId || null)
      || current.googleConnectionId !== connection.id || current.googleSubject !== connection.subject
      || selectedClinics.some(id => !current.clinicIds.includes(id))) fail('broker_binding_invalid');
    const identity = canonical(current);
    if (captured && captured !== identity) fail('broker_binding_invalid');
    captured = identity;
    const fresh = await models.GoogleConnection.findByPk(connection.id, {
      attributes: ['id', 'googleUserId', 'scopes'], raw: true, logging: false, ...locked });
    if (!fresh || Number(fresh.id) !== connection.id || fresh.googleUserId !== connection.subject
      || canonical(scopes(fresh.scopes)) !== canonical(connection.scopes)
      || !connection.scopes.includes(ADS) || dataManager && !connection.scopes.includes(DM)) fail('scope_denied');
    for (const id of selectedClinics) {
      const clinic = await models.Clinica.findByPk(id, {
        attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'], raw: true, logging: false, ...locked });
      if (!clinic || Number(clinic.id_clinica) !== id || ![true, 1, '1'].includes(clinic.estado_clinica)
        || current.groupId != null && Number(clinic.grupoClinicaId) !== current.groupId) fail('conversion_paused');
    }
    remaining(15000); return true;
  };
  return {
    async settings() {
      const rows = await broker.read(account, brokerContext, 'conversion_settings', {},
        { timeoutMs: remaining(15000), beforeExecute: current => guard(false, current) });
      if (rows.length !== 1) fail('broker_response_invalid');
      return structuredClone(rows[0]);
    },
    async list({ includeAllTypes = false } = {}) {
      await guard();
      const rows = await broker.read(account, brokerContext, 'conversion_actions', {},
        { timeoutMs: remaining(15000), beforeExecute: () => guard() });
      await guard();
      const actions = rows.map(mapConversionActionRow)
        .filter(action => action.id && action.status !== 'REMOVED' && (includeAllTypes || action.type === 'UPLOAD_CLICKS'))
        .sort((a, b) => Number(b.status === 'ENABLED') - Number(a.status === 'ENABLED'));
      listed = { actions, suggested_mapping: buildSuggestedMapping(actions), clinicaclick_mapping: buildClinicaclickManagedMapping(actions) };
      return structuredClone(listed);
    },
    async validate({ conversionActionId, event }) {
      await guard(true);
      if (!listed) fail('canonical_conversion_action_required');
      const problem = inspectCanonicalConversion({ listed, customerId, conversionActionId, event });
      if (problem) fail(problem);
      const response = await broker.conversion(account, brokerContext, 'validate', {
        conversionActionId, eventName: event, eventSource: 'WEB',
      }, { requestId: randomUUID(), beforeExecute: () => guard(true), timeoutMs: remaining(12000) });
      await guard(true);
      if (response?.validated !== true || response.warningCount !== 0) fail('DATA_MANAGER_VALIDATION_UNCONFIRMED');
      return { validated: true, validate_only: true };
    },
    async assert({ transaction = null, requireDataManager = false } = {}) {
      const checkDelivery = () => {
        if (requireDataManager && (process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED !== 'true'
          || String(process.env.RUNTIME_ROLE || '').toLowerCase() === 'gateway')) fail('broker_cohort_disabled');
      };
      checkDelivery();
      await guard(requireDataManager, null, transaction);
      checkDelivery();
      return true;
    },
  };
}
module.exports = { createGoogleAdsOnboardingBroker };
