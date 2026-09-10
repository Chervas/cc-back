'use strict';

const crypto = require('node:crypto');
const { resolveWebMeasurementMarketingState } = require('./campaignMeasurementReadiness.service');

const fail = code => { throw Object.assign(new Error(code), { code }); };

async function resolveWorkspaceWebSignalContext({ models, clinic, recordId, transaction = null, records: suppliedRecords = null }) {
  const clinicId = Number(clinic?.id_clinica);
  if (!Number.isSafeInteger(clinicId) || clinicId < 1 || ![true, 1, '1'].includes(clinic.estado_clinica)) fail('workspace_signal_clinic_inactive');
  const options = { raw: true, transaction };
  const clinicRecord = suppliedRecords ? suppliedRecords.clinicRecord
    : await models.IntakeConfig.findOne({ where: { assignment_scope: 'clinic', clinic_id: clinicId }, ...options });
  const groupRecord = suppliedRecords ? suppliedRecords.groupRecord : clinic.grupoClinicaId ? await models.IntakeConfig.findOne({
    where: { assignment_scope: 'group', group_id: clinic.grupoClinicaId }, ...options,
  }) : null;
  const scope = { assignment_scope: 'clinic', clinic_id: clinicId, group_id: clinic.grupoClinicaId || null };
  const records = { clinicRecord, groupRecord };
  const state = resolveWebMeasurementMarketingState(scope, { records });
  const record = state.record;
  if (!record || state.source === 'group_fallback' || !Number.isSafeInteger(Number(recordId))
    || Number(recordId) < 1 || Number(record.id) !== Number(recordId)
    || record.assignment_scope !== state.assignment_scope
    || Number(record.assignment_scope === 'group' ? record.group_id : record.clinic_id)
      !== Number(record.assignment_scope === 'group' ? clinic.grupoClinicaId : clinicId)) fail('workspace_signal_web_scope_changed');
  if (record.config?.features?.consent_mode_enabled !== true) fail('workspace_signal_web_consent_required');
  // Widget appearance and advertising destinations are not installation ownership or consent.
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    clinic: clinicId, group: clinic.grupoClinicaId || null, id: Number(record.id), scope: state.assignment_scope,
    domains: record.domains || null, key: record.hmac_key || null,
    locations: (Array.isArray(record.config?.locations) ? record.config.locations : [])
      .map(row => Number(row?.id ?? row?.clinic_id)).sort((a, b) => a - b),
    consent: record.config.features.consent_mode_enabled,
  })).digest('hex');
  return { record, records, fingerprint, groupId: clinic.grupoClinicaId || null };
}

module.exports = { resolveWorkspaceWebSignalContext };
