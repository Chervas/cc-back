'use strict';

// The supplied manual is preserved as a single unapproved document. This command
// never derives treatment assignments, aftercare instructions or clinical rules.
const { hash } = require('./adapter');
const { normalizeProtocol } = require('../../services/treatmentDocumentation.service');
const CLINIC_ID = 72;
const GROUP_ID = 29;
const TITLE = 'Aparatología corporal · manual pendiente de validación';
const SOURCE_PREFIX = 'cliniccloud:manual-corporal:';
const error = code => Object.assign(new Error(code), { code });
const plain = value => value?.toJSON ? value.toJSON() : value;
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

function protocolState(raw) {
  const row = plain(raw);
  return { id: Number(row.id), clinic_id: Number(row.clinic_id), title: row.title,
    kind: row.kind, status: row.status, version: Number(row.version), content: row.content,
    source: row.source || null, treatment_ids: decode(row.treatment_ids || []),
    created_by: row.created_by == null ? null : Number(row.created_by),
    updated_by: row.updated_by == null ? null : Number(row.updated_by),
    approved_by: row.approved_by == null ? null : Number(row.approved_by),
    approved_at: row.approved_at ? new Date(String(row.approved_at).includes('T') ? row.approved_at : String(row.approved_at).replace(' ', 'T') + 'Z').toISOString() : null };
}

function sourcePayload(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes) || !sourceBytes.length || sourceBytes.length > 1024 * 1024) throw error('PROTOCOL_SOURCE_INVALID');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  if (!content.includes('BS MEDICAL') || !content.includes('pendiente de validación médica') || !content.includes('APARATOLOGÍA CORPORAL')) throw error('PROTOCOL_SOURCE_NOT_EXPECTED_MANUAL');
  const sourceHash = hash(sourceBytes);
  const payload = normalizeProtocol({ title: TITLE, kind: 'protocol', status: 'draft',
    content, source: `${SOURCE_PREFIX}sha256:${sourceHash}; actor_kind=system_import; Protocolo_Aparatologia.md; documento aportado pendiente de validación médica`, treatment_ids: [] });
  return { sourceHash, payload };
}

function matchesImported(row, payload) {
  return row.clinic_id === CLINIC_ID && row.version === 1 && row.status === 'draft'
    && row.approved_by === null && row.approved_at === null
    && ['title', 'kind', 'content', 'source'].every(key => row[key] === payload[key])
    && Array.isArray(row.treatment_ids) && row.treatment_ids.length === 0;
}

function buildProtocolDraftPlan({ sourceBytes, existing = [] }) {
  const { sourceHash, payload } = sourcePayload(sourceBytes);
  const before = existing.map(protocolState).sort((a, b) => a.id - b.id);
  if (before.length > 1 || before.length === 1 && !matchesImported(before[0], payload)) throw error('PROTOCOL_SOURCE_COLLISION_REQUIRES_REVIEW');
  const plan = { version: 1, kind: 'cliniccloud_manual_protocol_draft', clinic_id: CLINIC_ID, group_id: GROUP_ID,
    source_file: 'Protocolo_Aparatologia.md', source_sha256: sourceHash, source_bytes: sourceBytes.length,
    payload, payload_sha256: hash(payload), before, before_sha256: hash(before),
    proposed_action: before.length ? 'already_imported' : 'create_draft',
    constraints: { status: 'draft', associations: 'none', activation: false, messages: false,
      recovery: 'Archive only the created record if its current state still equals the committed after-hash. Preserve revisions; never restore the shared database.' } };
  return { ...plan, plan_sha256: hash(plan) };
}

function validatePlan(plan, sourceBytes, approvedHash) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw error('PROTOCOL_PLAN_INVALID');
  const { plan_sha256: supplied, ...unsigned } = plan;
  if (!/^[a-f0-9]{64}$/.test(approvedHash || '') || approvedHash !== supplied || hash(unsigned) !== supplied) throw error('PROTOCOL_PLAN_HASH_MISMATCH');
  const reconstructed = buildProtocolDraftPlan({ sourceBytes, existing: plan.before });
  if (reconstructed.plan_sha256 !== supplied) throw error('PROTOCOL_PLAN_SOURCE_MISMATCH');
  return reconstructed;
}

async function readProtocolImportState(db, transaction) {
  const { Op } = db.Sequelize;
  const rows = await db.TreatmentProtocol.findAll({ where: { clinic_id: CLINIC_ID,
    [Op.or]: [{ title: TITLE }, { source: { [Op.like]: `${SOURCE_PREFIX}%` } }] },
    order: [['id', 'ASC']], transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  return rows.map(protocolState);
}

async function applyProtocolDraftPlan({ db, service, plan, approvedHash, sourceBytes, journal }) {
  const verified = validatePlan(plan, sourceBytes, approvedHash);
  for (const key of ['before', 'written', 'committed']) if (typeof journal?.[key] !== 'function') throw error('PROTOCOL_DURABLE_JOURNAL_REQUIRED');
  const outcome = await db.sequelize.transaction(async transaction => {
    const clinic = await db.Clinica.findOne({ where: { id_clinica: CLINIC_ID }, attributes: ['id_clinica', 'grupoClinicaId'], transaction, lock: transaction.LOCK.UPDATE });
    if (!clinic || Number(clinic.grupoClinicaId) !== GROUP_ID) throw error('PROTOCOL_CLINIC_GROUP_CHANGED');
    const current = await readProtocolImportState(db, transaction);
    if (current.length === 1 && matchesImported(current[0], verified.payload)) {
      const result = { action: 'already_imported', protocol_id: current[0].id, version: current[0].version, after_sha256: hash(current[0]), database_written: false };
      await journal.before({ plan_sha256: verified.plan_sha256, before: current, before_sha256: hash(current), actor_kind: 'system_import', actor_id: null, action: result.action });
      return result;
    }
    if (current.length || hash(current) !== verified.before_sha256 || verified.proposed_action !== 'create_draft') throw error('PROTOCOL_IMPORT_SNAPSHOT_CHANGED');
    await journal.before({ plan_sha256: verified.plan_sha256, source_sha256: verified.source_sha256,
      before: current, before_sha256: hash(current), actor_kind: 'system_import', actor_id: null, action: 'create_draft' });
    const saved = await service.save({ clinicId: CLINIC_ID, actorId: null, payload: verified.payload, transaction,
      importedSource: { actor_kind: 'system_import', source_system: 'cliniccloud', source_sha256: verified.source_sha256 } });
    const after = protocolState(saved.item);
    if (!matchesImported(after, verified.payload)) throw error('PROTOCOL_CANONICAL_RESULT_INVALID');
    const result = { action: 'created_draft', protocol_id: after.id, version: after.version, after_sha256: hash(after), database_written: true };
    // Fsync-backed write-ahead record must succeed BEFORE committing the DB.
    await journal.written({ ...result, after, plan_sha256: verified.plan_sha256, actor_kind: 'system_import', actor_id: null });
    return result;
  });
  // A crash here is reconciled by the source-hash replay path; never blindly retry insert.
  await journal.committed(outcome);
  return { ...outcome, clinic_id: CLINIC_ID, associations_created: 0, approved: false, messages_sent: 0 };
}

module.exports = { CLINIC_ID, GROUP_ID, TITLE, SOURCE_PREFIX, sourcePayload, protocolState, buildProtocolDraftPlan,
  validatePlan, matchesImported, readProtocolImportState, applyProtocolDraftPlan };
