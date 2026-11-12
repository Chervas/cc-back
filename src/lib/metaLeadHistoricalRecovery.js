'use strict';

// A historical recovery is not a fresh customer request. The marker is stored
// with the lead's attribution transaction, never inferred from provider fields.
const { randomUUID } = require('node:crypto');
const proofs = new WeakMap();
const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = () => { throw Object.assign(Error('meta_lead_recovery_proof_invalid'), { code: 'meta_lead_recovery_proof_invalid' }); };

function providerInstant(value) {
  if (typeof value !== 'string') fail();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!m || Number(m[1]) < 1000 || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1
    || Number(m[3]) > new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate()
    || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59 || !Number.isFinite(Date.parse(value))) fail();
  return new Date(value).toISOString();
}

function issue({ actorId, clinicId, event, source, providerCreatedAt, batchId = randomUUID(), recoveredAt = new Date() }) {
  const at = recoveredAt instanceof Date ? recoveredAt : new Date(recoveredAt);
  const created = providerInstant(providerCreatedAt);
  if (!positive(actorId) || !positive(clinicId) || !event
    || !['lead_id', 'page_id', 'form_id'].every(key => graphId(event[key]))
    || event.ad_id !== null && !graphId(event.ad_id)
    || !['accepted_receipt', 'provider_form_recovery'].includes(source)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(batchId)
    || !Number.isFinite(at.getTime()) || Date.parse(created) > at.getTime()) fail();
  const token = Object.freeze({});
  proofs.set(token, { actorId, clinicId, source, batchId, providerCreatedAt: created, recoveredAt: at.toISOString(), event: { ...event } });
  return token;
}

function forPersistence(proof, event, clinicId, providerCreatedAt) {
  const value = proof && proofs.get(proof);
  if (!value || value.clinicId !== Number(clinicId)
    || ['lead_id', 'page_id', 'form_id', 'ad_id'].some(key => value.event[key] !== event?.[key])
    || value.providerCreatedAt !== providerInstant(providerCreatedAt)) fail();
  return { version: 1, source: value.source, batch_id: value.batchId, actor_user_id: value.actorId,
    clinic_id: value.clinicId, provider_created_at: value.providerCreatedAt, recovered_at: value.recoveredAt, automatic_messages: 'suppressed' };
}

function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function suppressesAutomaticReply(models, lead, { transaction } = {}) {
  if (lead?.external_source !== 'meta_leadgen') return false;
  if (!positive(Number(lead.id)) || !positive(Number(lead.clinica_id)) || !graphId(lead.external_id)
    || !models?.LeadAttributionAudit?.findAll) fail();
  const rows = await models.LeadAttributionAudit.findAll({ where: { lead_intake_id: Number(lead.id) },
    attributes: ['raw_payload', 'attribution_steps'], limit: 101, raw: true, logging: false,
    ...(transaction ? { transaction } : {}) });
  if (!Array.isArray(rows) || rows.length > 100) fail();
  for (const row of rows) {
    const steps = object(row.attribution_steps), marker = steps?.meta_historical_recovery;
    if (marker === undefined) continue;
    const raw = object(row.raw_payload);
    if (raw?.provider !== 'meta_leadgen' || raw.lead_id !== lead.external_id || marker?.version !== 1
      || marker.clinic_id !== Number(lead.clinica_id) || marker.automatic_messages !== 'suppressed'
      || marker.provider_created_at !== providerInstant(raw.provider_created_at)) fail();
    return true;
  }
  return false;
}

module.exports = { issue, forPersistence, suppressesAutomaticReply };
