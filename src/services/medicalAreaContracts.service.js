'use strict';

const { createHash } = require('node:crypto');
const definitions = require('../lib/medical-area-contracts');
const { createMedicalAreaAdoptionService } = require('./medicalAreaAdoption.service');

function problem(code, statusCode = 409) {
  return Object.assign(new Error(code), { code, statusCode, status: statusCode });
}

// Sort object keys, never arrays: the ordering of steps/fields is significant.
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function contractHash(contract) {
  return createHash('sha256').update(canonicalJson(contract)).digest('hex');
}

function positiveId(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw problem(name + '_invalid', 400);
  return n;
}

function assertUnits(code, payload) {
  const base = definitions.getBaseContractForArea(code).nutrition_measurement_fields;
  for (const [key, field] of Object.entries(payload?.nutrition_measurement_fields || {})) {
    if (base[key] && field?.unit !== undefined && field.unit !== base[key].unit) {
      throw problem('medical_area_measurement_unit_fixed:' + key, 422);
    }
  }
}

function exposeRevision(row) {
  const r = row?.get ? row.get({ plain: true }) : row;
  const contract = definitions.parseStoredContract(r?.contract_json);
  if (!r || !contract || contract.code !== r.code || contractHash(contract) !== r.content_hash) {
    throw problem('medical_area_revision_corrupt', 503);
  }
  // Deliberately no merge with current defaults: published configurations are
  // complete snapshots, not overrides that change on the next code deployment.
  return { ...JSON.parse(JSON.stringify(contract)), revision: {
    id: Number(r.id), number: Number(r.revision_number), hash: r.content_hash,
  } };
}

function createMedicalAreaContractsService(models) {
  const { MedicalAreaContract: Head, MedicalAreaContractRevision: Revision,
    ClinicMedicalAreaContract: Pin, Clinica, sequelize } = models;

  async function getMedicalAreaContracts({ clinicId = null, transaction } = {}) {
    const scoped = clinicId !== null && clinicId !== undefined;
    const query = { include: [{ model: Revision, as: 'revision', required: true }],
      order: [['code', 'ASC']], transaction };
    const rows = scoped
      ? await Pin.findAll({ ...query, where: { clinic_id: positiveId(clinicId, 'clinic_id') } })
      : await Head.findAll({ ...query, where: { active: true } });
    if (!rows.length) throw problem('medical_area_configuration_not_initialized', 503);
    const contracts = {};
    for (const row of rows) {
      const contract = exposeRevision(row.revision);
      if (contract.code !== row.code) throw problem('medical_area_revision_scope_mismatch', 503);
      contracts[row.code] = contract;
    }
    if (!contracts[definitions.FALLBACK_CODE]) throw problem('medical_area_configuration_incomplete', 503);
    return { version: definitions.VERSION, source: 'backend-db',
      configuration_scope: scoped ? 'clinic' : 'system', clinic_id: scoped ? Number(clinicId) : null,
      fallback_code: definitions.FALLBACK_CODE, contracts };
  }

  async function getContractForArea(code, options) {
    const response = await getMedicalAreaContracts(options);
    const contract = response.contracts[definitions.normalizeCode(code)];
    if (!contract) throw problem('medical_area_not_configured', 409);
    return contract;
  }

  async function getRecordedContract(code, revisionId = null, { transaction } = {}) {
    const area = definitions.normalizeCode(code);
    const row = revisionId == null
      ? await Revision.findOne({ where: { code: area, revision_number: 1 }, transaction })
      : await Revision.findByPk(positiveId(revisionId, 'revision_id'), { transaction });
    if (!row || row.code !== area) throw problem('medical_area_revision_scope_mismatch', 503);
    return exposeRevision(row);
  }

  async function upsertMedicalAreaContract(code, payload, updatedBy, { expectedRevisionId } = {}) {
    const normalizedCode = definitions.normalizeCode(code);
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(normalizedCode)) throw problem('medical_area_code_invalid', 422);
    if (payload?.code && payload.code !== normalizedCode) throw problem('medical_area_code_mismatch', 422);
    if (expectedRevisionId == null) throw problem('medical_area_revision_required', 428);
    const expected = positiveId(expectedRevisionId, 'expected_revision_id');
    const actor = positiveId(updatedBy, 'actor_id');
    assertUnits(normalizedCode, payload);
    const contract = definitions.normalizeContractPayload(normalizedCode, payload);
    const hash = contractHash(contract);
    return sequelize.transaction(async transaction => {
      // Small admin-only catalogue: consistent ordered locks also serialize
      // the first publication of custom areas without a gap-lock race.
      const heads = await Head.findAll({ order: [['code', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
      const head = heads.find(h => h.code === normalizedCode);
      const baseHead = head || heads.find(h => h.code === definitions.FALLBACK_CODE);
      if (!baseHead?.revision_id) throw problem('medical_area_configuration_not_initialized', 503);
      if (Number(baseHead.revision_id) !== expected) throw problem('medical_area_revision_conflict');
      const previous = await Revision.findByPk(baseHead.revision_id, { transaction });
      exposeRevision(previous);
      if (previous.code !== baseHead.code) throw problem('medical_area_revision_scope_mismatch', 503);
      const submittedSnapshot = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'revision'));
      if (head && contractHash(submittedSnapshot) === previous.content_hash) return exposeRevision(previous);
      if (head && previous.content_hash === hash) return exposeRevision(previous);
      const revision = await Revision.create({ code: normalizedCode, contract_json: contract,
        content_hash: hash, revision_number: head ? previous.revision_number + 1 : 1, created_by: actor }, { transaction });
      // Keep the old table readable for rolling deployment/rollback, but clinic
      // runtime consumers use their pin and never this mutable system head.
      const update = { contract_json: contract, version: 'revision-' + revision.revision_number,
        revision_id: revision.id, active: true, updated_by: actor };
      if (head) await head.update(update, { transaction });
      else await Head.create({ code: normalizedCode, ...update }, { transaction });
      return exposeRevision(revision);
    });
  }

  async function initializeClinic(clinicId, { transaction, actorId = null } = {}) {
    if (!transaction) throw problem('medical_area_initialization_requires_transaction', 500);
    const id = positiveId(clinicId, 'clinic_id');
    const clinic = await Clinica.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!clinic) throw problem('clinic_not_found', 404);
    // Serialize with publications, so all copied heads belong to one consistent
    // cut. This runs once at onboarding, never on the availability hot path.
    const heads = await Head.findAll({ where: { active: true }, order: [['code', 'ASC']],
      transaction, lock: transaction.LOCK.UPDATE });
    if (!heads.length || heads.some(h => !h.revision_id)) throw problem('medical_area_configuration_not_initialized', 503);
    const existing = await Pin.count({ where: { clinic_id: id }, transaction });
    if (existing) throw problem('medical_area_clinic_already_initialized');
    await Pin.bulkCreate(heads.map(head => ({ clinic_id: id, code: head.code,
      revision_id: head.revision_id, updated_by: actorId })), { transaction });
  }

  const adoption = createMedicalAreaAdoptionService(models, { exposeRevision, contractHash });

  return { getMedicalAreaContracts, getContractForArea, upsertMedicalAreaContract,
    initializeClinic, adoptClinicRevision: adoption.adopt, getRecordedContract,
    reviewClinicRevision: adoption.review, listClinicVersions: adoption.list,
    getClinicRevisionHistory: adoption.history };
}

// Lazy loading keeps pure contract tests and migration preparation free of app
// startup, environment credentials, workers and model bootstrap side effects.
let live;
const service = () => (live ||= createMedicalAreaContractsService(require('../../models')));
module.exports = { ...definitions, contractHash, assertUnits, exposeRevision,
  createMedicalAreaContractsService,
  getMedicalAreaContracts: (...args) => service().getMedicalAreaContracts(...args),
  getContractForArea: (...args) => service().getContractForArea(...args),
  upsertMedicalAreaContract: (...args) => service().upsertMedicalAreaContract(...args),
  initializeClinic: (...args) => service().initializeClinic(...args),
  adoptClinicRevision: (...args) => service().adoptClinicRevision(...args),
  getRecordedContract: (...args) => service().getRecordedContract(...args),
  reviewClinicRevision: (...args) => service().reviewClinicRevision(...args),
  listClinicVersions: (...args) => service().listClinicVersions(...args),
  getClinicRevisionHistory: (...args) => service().getClinicRevisionHistory(...args),
};
