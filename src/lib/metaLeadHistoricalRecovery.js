'use strict';

// A historical recovery is not a fresh customer request. The marker is stored
// with the lead's attribution transaction, never inferred from provider fields.
const { randomUUID, createHash } = require('node:crypto');
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

function issue(value) { return createProof({ ...value, actorKind: 'user' }); }

function createProof({ actorId, actorKind, clinicId, event, source, providerCreatedAt, cutoffBefore = null, policyDigest = null,
  batchId = randomUUID(), recoveredAt = new Date() }) {
  const at = recoveredAt instanceof Date ? recoveredAt : new Date(recoveredAt);
  const created = providerInstant(providerCreatedAt);
  const system = actorKind === 'system' && actorId === null && source === 'late_provider_receipt';
  const user = actorKind === 'user' && positive(actorId) && ['accepted_receipt', 'provider_form_recovery'].includes(source);
  if (!(user || system) || !positive(clinicId) || !event
    || !['lead_id', 'page_id', 'form_id'].every(key => graphId(event[key]))
    || event.ad_id !== null && !graphId(event.ad_id)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(batchId)
    || !Number.isFinite(at.getTime()) || Date.parse(created) > at.getTime()
    || system && (!/^[a-f0-9]{64}$/.test(policyDigest || '') || providerInstant(cutoffBefore) <= created)) fail();
  const token = Object.freeze({});
  proofs.set(token, { actorId, actorKind, clinicId, source, batchId, cutoffBefore, policyDigest,
    providerCreatedAt: created, recoveredAt: at.toISOString(), event: { ...event } });
  return token;
}

function cutoffPolicy(raw, now = new Date()) {
  const invalid = () => { throw Object.assign(Error('meta_lead_recovery_cutoff_invalid'), { code: 'meta_lead_recovery_cutoff_invalid' }); };
  let value; try { value = JSON.parse(raw); } catch (_) { invalid(); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== 'before,connectionId,pages,scopeKey,version'
    || value.version !== 1 || value.scopeKey !== 'group:29' || value.connectionId !== 172
    || !Array.isArray(value.pages) || value.pages.length !== 2 || typeof value.before !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.before)) invalid();
  let before; try { before = providerInstant(value.before); } catch (_) { invalid(); }
  if (!Number.isFinite(+now) || Date.parse(before) > +now) invalid();
  const expected = new Map([['100586185397014',66],['162719417401326',72]]), seen = new Set();
  for (const page of value.pages) {
    if (!page || Object.getPrototypeOf(page) !== Object.prototype || Object.keys(page).sort().join(',') !== 'clinicId,pageId'
      || expected.get(page.pageId) !== page.clinicId || seen.has(page.pageId)) invalid();
    seen.add(page.pageId);
  }
  const policy = { ...value, before, pages: [...value.pages].sort((a,b) => a.clinicId - b.clinicId) };
  return { ...policy, digest: createHash('sha256').update(JSON.stringify(policy)).digest('hex') };
}

async function forLateProviderReceipt({ event, clinic, retrieved, transaction, recoveredAt = new Date(), env = process.env }) {
  const raw = env.META_MARKETING_LEAD_RECOVERY_CUTOFF_POLICY;
  if (raw === undefined || raw === '' || ![66,72].includes(Number(clinic?.id_clinica))) return null;
  const policy = cutoffPolicy(raw, recoveredAt);
  if (typeof retrieved?.authority?.assert !== 'function') fail();
  const current = await retrieved.authority.assert({ transaction });
  if (current?.page?.scopeKey !== policy.scopeKey || current.page.connectionId !== policy.connectionId) return null;
  const target = policy.pages.find(page => page.pageId === event?.page_id);
  if (!target) return null;
  const clinicId = Number(clinic.id_clinica);
  if (target.clinicId !== clinicId || Number(clinic.grupoClinicaId) !== 29 || current.page.id !== event.page_id
    || current.account?.scopeKey !== policy.scopeKey || current.account.connectionId !== policy.connectionId
    || current.route?.recipientClinicId !== clinicId || Number(retrieved.connectionId) !== policy.connectionId
    || retrieved.lead?.id !== event.lead_id || retrieved.lead.form_id !== event.form_id
    || event.ad_id !== null && retrieved.lead.ad_id !== event.ad_id) fail();
  const created = providerInstant(retrieved.lead.created_time);
  if (Date.parse(created) > +recoveredAt) fail();
  if (created >= policy.before) return null;
  return createProof({ actorId: null, actorKind: 'system', clinicId, event, source: 'late_provider_receipt', providerCreatedAt: created,
    cutoffBefore: policy.before, policyDigest: policy.digest, recoveredAt });
}

function forPersistence(proof, event, clinicId, providerCreatedAt) {
  const value = proof && proofs.get(proof);
  if (!value || value.clinicId !== Number(clinicId)
    || ['lead_id', 'page_id', 'form_id', 'ad_id'].some(key => value.event[key] !== event?.[key])
    || value.providerCreatedAt !== providerInstant(providerCreatedAt)) fail();
  return { version: 1, source: value.source, batch_id: value.batchId, actor_kind: value.actorKind, actor_user_id: value.actorId,
    clinic_id: value.clinicId, provider_created_at: value.providerCreatedAt, recovered_at: value.recoveredAt, automatic_messages: 'suppressed',
    ...(value.actorKind === 'system' ? { cutoff_before: value.cutoffBefore, policy_digest: value.policyDigest } : {}) };
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
    if (marker.source === 'late_provider_receipt') {
      if (marker.actor_kind !== 'system' || marker.actor_user_id !== null || !/^[a-f0-9]{64}$/.test(marker.policy_digest || '')
        || providerInstant(marker.cutoff_before) <= marker.provider_created_at) fail();
    } else if (!['accepted_receipt', 'provider_form_recovery'].includes(marker.source)
      || !positive(marker.actor_user_id) || ![undefined,'user'].includes(marker.actor_kind)) fail();
    return true;
  }
  return false;
}

module.exports = { issue, forPersistence, suppressesAutomaticReply, forLateProviderReceipt, cutoffPolicy };
