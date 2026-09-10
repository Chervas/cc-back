'use strict';

const crypto = require('node:crypto');

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function googleDeliveryContext({ cfgRecord, signalPolicyRecord = cfgRecord, runtime, policy, campaignId }) {
  const account = runtime?.account; const connection = runtime?.connection;
  const refs = policy?.policyRefs;
  if (!policy?.applicable || !policy.allowed || !Array.isArray(refs) || !refs.length
    || refs.some(ref => !ref || typeof ref.setting_id !== 'string' || !['clinic', 'group'].includes(ref.scope_type)
      || !positiveId(ref.scope_id) || !positiveId(ref.version))
    || !/^[0-9]{1,64}$/.test(campaignId || '') || !positiveId(account?.id) || !positiveId(connection?.id)
    || Number(account.googleConnectionId) !== Number(connection.id) || !connection.googleUserId
    || !['clinic', 'group'].includes(account.assignmentScope)
    || !positiveId(account.assignmentScope === 'group' ? account.grupoClinicaId : account.clinicaId)
    || !positiveId(cfgRecord?.id) || !positiveId(signalPolicyRecord?.id)) return null;
  const recordKey = record => ({ id: Number(record.id), scope: record.assignment_scope,
    clinic: record.clinic_id || null, group: record.group_id || null,
    google: record.config?.google_ads || null, consent: record.config?.features?.consent_mode_enabled === true,
    policy: record.config?.campaigns?.workspace_policy || null,
    locations: (Array.isArray(record.config?.locations) ? record.config.locations : [])
      .map(row => Number(row?.id ?? row?.clinic_id)).sort((a, b) => a - b) });
  return { schema_version: 1, campaign_id: campaignId,
    fingerprint: hash({ records: [recordKey(cfgRecord), recordKey(signalPolicyRecord)],
      policies: [...refs].sort((a, b) => a.setting_id.localeCompare(b.setting_id)),
      mapping: { id: Number(account.id), scope: account.assignmentScope, clinic: account.clinicaId || null,
        group: account.grupoClinicaId || null, customer: account.customerId },
      connection: { id: Number(connection.id), identity: connection.googleUserId,
        scopes: String(connection.scopes || '').split(/[\s,]+/).filter(Boolean).sort() },
      source: runtime.connectionSource, login: runtime.loginCustomerId || null,
    }) };
}

module.exports = { googleDeliveryContext };
