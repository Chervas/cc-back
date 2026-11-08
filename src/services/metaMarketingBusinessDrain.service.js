'use strict';

// A handover must not strand a receipt accepted by the previous identity.
// This fence has no provider transport and never cancels or replays work.
const { createHash } = require('node:crypto');
const { Op, literal, where } = require('sequelize');
const C = require('./metaMarketingEnrollment.contract');
const B = require('../../services/integrations-broker/src/meta-marketing-business-contract');
const F = require('./metaMarketingEffectiveCredential.service');
const JOB = 'campaign_meta_lead_receive';
const ACTIVE = ['pending', 'queued', 'running', 'waiting'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value?.get ? value.get({ plain: true }) : value;
const fail = (code = 'meta_business_drain_invalid') => { throw Object.assign(Error(code), { code, httpStatus: 409 }); };
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
function snapshot(raw) {
  const e = plain(raw); let mappings, assets, clinics;
  try { mappings = json(e.mapping_ids); assets = C.assets(json(e.assets)); clinics = C.clinics(e.clinic_ids); } catch { fail(); }
  if (!C.UUID.test(e.enrollment_id) || !/^(group|clinic):[1-9][0-9]{0,9}$/.test(e.scope_key)
    || !Array.isArray(mappings) || !mappings.length || mappings.length !== assets.length
    || mappings.some((id, i) => !C.positive(id) || i > 0 && id <= mappings[i - 1])) fail();
  return { id: e.enrollment_id, scope: e.scope_key, mappings, assets, clinics, assetDigest: F.assetSetDigest(assets) };
}
function ownerProof(value, handoverId, oldGrantDigest) {
  if (!C.UUID.test(handoverId) || !C.HASH.test(oldGrantDigest) || !value || value.closed !== true
    || !Number.isSafeInteger(value.activeOperations) || value.activeOperations < 0 || !Array.isArray(value.receiptRefs)
    || value.receiptRefs.length > 1000 || value.receiptRefs.some((id, i) => !C.UUID.test(id) || i > 0 && id <= value.receiptRefs[i - 1])
    || value.receiptSetDigest !== B.drainDigest(handoverId, oldGrantDigest, value.receiptRefs)) fail();
  return { refs: value.receiptRefs.slice(), digest: value.receiptSetDigest, operations: value.activeOperations };
}
function createDrain({ models, now = () => new Date() }) {
  const R = models.MetaMarketingBusinessDrain;
  const options = transaction => {
    if (!transaction?.LOCK?.UPDATE) fail();
    return { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
  };
  async function enrollment(id, transaction) {
    const row = plain(await models.MetaMarketingEnrollmentRequest.findByPk(id, options(transaction)));
    if (!row || row.state !== 'active') fail('meta_business_drain_scope_changed');
    return snapshot(row);
  }
  const payloadValue = key => {
    if (!['page_asset_id', 'account_asset_id', 'receipt_ref'].includes(key)) fail();
    return literal("JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$." + key + "'))");
  };
  async function ready(s, refs, transaction) {
    const current = await models.JobRequest.findAll({ ...options(transaction), attributes: ['id'],
      where: { type: JOB, status: { [Op.in]: ACTIVE }, [Op.or]: [
        where(payloadValue('page_asset_id'), { [Op.in]: s.mappings.map(String) }),
        where(payloadValue('account_asset_id'), { [Op.in]: s.mappings.map(String) }),
      ] }, order: [['id', 'ASC']], limit: 1 });
    if (current.length) return false;
    if (!refs.length) return true;
    const jobs = await models.JobRequest.findAll({ ...options(transaction), attributes: ['id', 'status', 'payload', 'result_summary'],
      where: { type: JOB, status: 'completed', [Op.and]: [where(payloadValue('receipt_ref'), { [Op.in]: refs })] },
      order: [['id', 'ASC']], limit: 10001 });
    if (jobs.length > 10000) fail('meta_business_drain_capacity');
    const proofs = new Map();
    for (const job of jobs) {
      const p = json(job.payload), result = json(job.result_summary);
      if (!p || !refs.includes(p.receipt_ref) || !s.mappings.includes(p.page_asset_id) || !s.mappings.includes(p.account_asset_id)
        || !/^[1-9][0-9]{0,63}$/.test(p.lead_id || '') || !C.positive(Number(result?.lead_id))) continue;
      const lead = plain(await models.LeadIntake.findByPk(Number(result.lead_id), { ...options(transaction),
        attributes: ['id', 'clinica_id', 'external_source', 'external_id'] }));
      if (lead && lead.external_source === 'meta_leadgen' && lead.external_id === p.lead_id && s.clinics.includes(Number(lead.clinica_id))) {
        const prior = proofs.get(p.receipt_ref);
        if (prior && prior !== p.lead_id) fail();
        proofs.set(p.receipt_ref, p.lead_id);
      }
    }
    return refs.every(ref => proofs.has(ref));
  }
  function matches(row, s, handoverId, proof, oldGrantDigest) {
    if (!row || row.enrollment_id !== s.id || row.active_enrollment_id !== s.id || row.scope_key !== s.scope || row.handover_id !== handoverId
      || row.mapping_ids !== JSON.stringify(s.mappings) || row.asset_set_digest !== s.assetDigest
      || row.receipt_refs !== JSON.stringify(proof.refs) || row.old_grant_digest !== oldGrantDigest || row.drain_digest !== proof.digest
      || !['draining', 'ready'].includes(row.state) || row.released_at !== null) fail('meta_business_drain_scope_changed');
  }
  async function begin(input, { transaction, handoverId, ownerDrain, oldGrantDigest }) {
    if (!R) fail();
    const expected = snapshot(input), s = await enrollment(expected.id, transaction);
    if (hash(expected) !== hash(s)) fail('meta_business_drain_scope_changed');
    const proof = ownerProof(ownerDrain, handoverId, oldGrantDigest);
    let row = plain(await R.findByPk(handoverId, options(transaction)));
    if (!row) {
      const other = await R.findOne({ ...options(transaction), where: { active_enrollment_id: s.id } });
      if (other) fail('meta_business_drain_pending');
      row = { enrollment_id: s.id, active_enrollment_id: s.id, handover_id: handoverId, scope_key: s.scope, mapping_ids: JSON.stringify(s.mappings),
        receipt_refs: JSON.stringify(proof.refs), old_grant_digest: oldGrantDigest, asset_set_digest: s.assetDigest,
        drain_digest: proof.digest, state: 'draining', created_at: now(), updated_at: now(), released_at: null };
      await R.create(row, { transaction, logging: false });
    }
    matches(row, s, handoverId, proof, oldGrantDigest);
    const drained = proof.operations === 0 && await ready(s, proof.refs, transaction);
    await R.update({ state: drained ? 'ready' : 'draining', updated_at: now() },
      { where: { enrollment_id: s.id, handover_id: handoverId }, transaction, logging: false });
    return { drainDigest: proof.digest, ready: drained };
  }
  async function assert(id, digest, { transaction, handoverId, ownerDrain, oldGrantDigest }) {
    const s = await enrollment(id, transaction), proof = ownerProof(ownerDrain, handoverId, oldGrantDigest);
    const row = plain(await R.findByPk(handoverId, options(transaction)));
    matches(row, s, handoverId, proof, oldGrantDigest);
    if (digest !== proof.digest || proof.operations !== 0 || !await ready(s, proof.refs, transaction)) fail('meta_business_drain_pending');
    return { drainDigest: digest, ready: true };
  }
  async function release(id, { transaction, handoverId }) {
    if (!C.UUID.test(id) || !C.UUID.test(handoverId)) fail();
    // Cancellation and completion share this lock; source history is retained.
    await models.MetaMarketingEnrollmentRequest.findByPk(id, options(transaction));
    const row = plain(await R.findByPk(handoverId, options(transaction)));
    if (!row) {
      if (await R.findOne({ ...options(transaction), where: { active_enrollment_id: id } })) fail();
      return;
    }
    if (row.handover_id !== handoverId || row.enrollment_id !== id) fail();
    if (row.state !== 'released') await R.update({ state: 'released', active_enrollment_id: null, released_at: now(), updated_at: now() },
      { where: { enrollment_id: id, handover_id: handoverId }, transaction, logging: false });
  }
  async function assertAdmission(payload, { transaction }) {
    if (!R) return; // Older isolated test fixtures do not register this feature.
    if (!C.positive(payload?.page_asset_id) || !C.positive(payload?.account_asset_id) || !C.UUID.test(payload.receipt_ref)) fail();
    const bindings = await models.MetaMarketingBrokerBinding.findAll({ transaction, raw: true, logging: false, attributes: ['enrollment_id'],
      where: { mapping_id: { [Op.in]: [payload.page_asset_id, payload.account_asset_id] }, state: 'active' } });
    if (bindings.length !== 2 || bindings.some(value => value.enrollment_id !== bindings[0].enrollment_id)) fail('meta_business_drain_scope_changed');
    const s = await enrollment(bindings[0].enrollment_id, transaction);
    const locked = await models.MetaMarketingBrokerBinding.findAll({ ...options(transaction), attributes: ['enrollment_id'],
      where: { mapping_id: { [Op.in]: [payload.page_asset_id, payload.account_asset_id] }, state: 'active' } });
    if (locked.length !== 2 || locked.some(value => value.enrollment_id !== s.id)) fail('meta_business_drain_scope_changed');
    const row = plain(await R.findOne({ ...options(transaction), where: { active_enrollment_id: s.id } }));
    if (!row || row.state === 'released') return;
    let refs; try { refs = JSON.parse(row.receipt_refs); } catch { fail(); }
    if (!Array.isArray(refs) || !refs.includes(payload.receipt_ref)) fail('meta_business_drain_pending');
  }
  return { begin, assert, release, assertAdmission };
}
module.exports = { createDrain, snapshot, ownerProof };
