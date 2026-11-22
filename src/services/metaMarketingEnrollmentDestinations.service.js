'use strict';

const { Op } = require('sequelize');
const C = require('./metaMarketingEnrollment.contract');
const { createAdmission } = require('./metaMarketingAdmission.service');
const { connectionRef } = require('../../services/integrations-broker/src/meta-marketing-admission-contract');

const TABLE = 'MetaMarketingEnrollmentDestinationPlans';
const VERSION = 1;
const POLICY_FIELDS = {
  ad_account: { updated: 'meta_ad_account_assignment_updated_at' },
  facebook_page: { updated: 'facebook_assignment_updated_at', mode: 'facebook_assignment_mode', primary: 'facebook_primary_asset_id' },
  instagram_business: { updated: 'instagram_assignment_updated_at', mode: 'instagram_assignment_mode', primary: 'instagram_primary_asset_id' },
};
const KINDS = Object.keys(POLICY_FIELDS);
const SETTINGS_FIELDS = Object.values(POLICY_FIELDS).flatMap(Object.values);
const invalid = () => C.fail('meta_enrollment_invalid', 400);
const review = () => C.fail('meta_enrollment_assignment_review', 409);
const opts = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false });
const groupScope = scopeKey => /^group:[1-9][0-9]{0,9}$/.test(scopeKey);
const dynamic = (scopeKey, ref) => groupScope(scopeKey) && connectionRef(scopeKey) === ref;
const missingTable = error => [error?.original, error?.parent, error].some(value => value?.code === 'ER_NO_SUCH_TABLE');

function normalize(plan, clinicIds, selected) {
  if (!C.exact(plan, 'version,rows') || plan.version !== VERSION || !Array.isArray(plan.rows)
    || plan.rows.length !== clinicIds.length) invalid();
  const refs = new Set(selected.map(asset => asset.assetRef));
  const kinds = KINDS.filter(kind => selected.some(asset => asset.kind === kind));
  const expectedIds = new Set(clinicIds), byId = new Map();
  let assigned = 0;
  for (const row of plan.rows) {
    if (!C.exact(row, 'clinicId,assignments') || !expectedIds.has(row.clinicId) || byId.has(row.clinicId)
      || !C.exact(row.assignments, kinds.join(','))) invalid();
    const assignments = {};
    for (const kind of kinds) {
      const ref = row.assignments[kind];
      if (ref !== null && (typeof ref !== 'string' || !refs.has(ref) || !ref.startsWith('meta-' + kind + ':'))) invalid();
      if (ref !== null) assigned++;
      assignments[kind] = ref;
    }
    byId.set(row.clinicId, { clinicId: row.clinicId, assignments });
  }
  // The existing enrollment binding verifier admits at most 1,000 share rows.
  if (assigned > 1000) invalid();
  return { version: VERSION, rows: clinicIds.map(id => byId.get(id)) };
}

function fingerprint(row, encoded) {
  return C.hash(JSON.stringify(['meta-marketing-enrollment-destinations/1', row.enrollment_id, row.flow_id,
    row.scope_key, row.clinic_ids, row.scope_digest, row.candidate_digest, row.assets, encoded]));
}

function assignmentDigest(base, destinations) {
  return destinations ? C.hash(JSON.stringify(['meta-marketing-enrollment-assignment-destinations/1', base, destinations.digest])) : base;
}

function labelsFor(selected, display) {
  if (!Array.isArray(display) || display.length > 100) return [];
  return selected.flatMap(({ assetRef, id }) => {
    const matches = display.filter(item => item?.assetRef === assetRef);
    const value = matches.length === 1 ? matches[0].name : undefined;
    if (typeof value !== 'string' || value.length > 255 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return [];
    const name = value.trim();
    return name && name.replace(/^act_/, '') !== id ? [{ assetRef, name }] : [];
  });
}

function createDestinations({ models, enabled = () => process.env.META_MARKETING_GROUP_DESTINATION_PLAN_ENABLED === 'true',
  admitted = createAdmission().enabled }) {
  const P = models.MetaMarketingEnrollmentDestinationPlan;

  async function available(scopeKey, transaction, ref) {
    if (!P || !groupScope(scopeKey) || !enabled() || !admitted(scopeKey) || ref !== undefined && !dynamic(scopeKey, ref)) return false;
    return models.sequelize.getQueryInterface().tableExists(TABLE, { transaction, logging: false });
  }

  function prepare(row, candidate) {
    const destinationPlan = normalize(candidate, C.clinics(row.clinic_ids), C.assets(JSON.parse(row.assets)));
    return { plan: destinationPlan, digest: fingerprint(row, JSON.stringify(destinationPlan)) };
  }

  async function read(row, transaction) {
    if (!P || !dynamic(row.scope_key, row.connection_ref)) return null;
    let stored;
    try { stored = await P.findByPk(row.enrollment_id, opts(transaction)); }
    catch (error) { if (missingTable(error)) return null; throw error; }
    if (!stored) return null;
    let parsed;
    try { parsed = prepare(row, JSON.parse(stored.plan)); } catch { C.fail(); }
    if (JSON.stringify(parsed.plan) !== stored.plan || parsed.digest !== stored.digest) C.fail();
    return { ...parsed, pendingAssetLabels: labelsFor(row.selected, stored.asset_labels) };
  }

  async function create(row, destinations, chosen, transaction) {
    await P.create({ enrollment_id: row.enrollment_id, plan: JSON.stringify(destinations.plan), digest: destinations.digest,
      asset_labels: labelsFor(row.selected, chosen) },
      { transaction, logging: false });
  }

  async function assertClean(row, transaction) {
    if (!dynamic(row.scope_key, row.connection_ref)) review();
    const groupId = Number(row.scope_key.slice(6)), clinicIds = C.clinics(row.clinic_ids), options = opts(transaction);
    // The enrollment authority locks and checks exact current membership
    // before entering this guard. Scope overlap is also denied by Owner.
    const group = await models.GrupoClinica.findByPk(groupId, { ...options, attributes: SETTINGS_FIELDS });
    if (!group || Object.values(POLICY_FIELDS).some(policy => group[policy.updated] !== null ||
      policy.mode && (group[policy.mode] !== 'clinic' || group[policy.primary] !== null))) review();
    const assetTypes = { [Op.in]: KINDS.map(kind => 'meta.' + kind) };
    if (await models.GroupAssetClinicAssignment.findOne({ ...options, attributes: ['id'],
      where: { assetType: assetTypes, [Op.or]: [{ grupoClinicaId: groupId }, { clinicaId: { [Op.in]: clinicIds } }] } })) review();
    if (await models.ClinicMetaAsset.findOne({ ...options, attributes: ['id'],
      where: { assetType: { [Op.in]: KINDS }, [Op.or]: [{ grupoClinicaId: groupId }, { clinicaId: { [Op.in]: clinicIds } }] } })) review();
    if (await models.MetaMarketingBrokerBinding.findOne({ ...options, attributes: ['mapping_id'],
      where: { scope_key: { [Op.in]: [row.scope_key, ...clinicIds.map(id => 'clinic:' + id)] } } })) review();
  }

  async function activate(row, destinations, mappings, transaction, now) {
    const groupId = Number(row.scope_key.slice(6)), ids = new Map(mappings.map(mapping => [mapping.assetRef, mapping.id]));
    const shares = [], updates = {};
    for (const { clinicId, assignments } of destinations.plan.rows) {
      for (const [kind, ref] of Object.entries(assignments)) {
        if (ref === null) continue;
        const assetId = ids.get(ref);
        if (!C.positive(assetId)) review();
        shares.push({ grupoClinicaId: groupId, assetType: 'meta.' + kind, assetId, clinicaId: clinicId });
      }
    }
    // An explicit empty destination creates no share, but still makes the
    // kind authoritative. Leaving the timestamp null would inherit all assets.
    for (const kind of Object.keys(destinations.plan.rows[0].assignments)) {
      const policy = POLICY_FIELDS[kind];
      updates[policy.updated] = now;
      if (policy.mode) { updates[policy.mode] = 'clinic'; updates[policy.primary] = null; }
    }
    if (shares.length) await models.GroupAssetClinicAssignment.bulkCreate(shares, { transaction, logging: false });
    const [changed] = await models.GrupoClinica.update(updates, { where: { id_grupo: groupId }, transaction, logging: false });
    if (changed !== 1) review();
  }

  return { available, read, prepare, create, assertClean, activate };
}

module.exports = { VERSION, createDestinations, assignmentDigest, normalize };
