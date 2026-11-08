'use strict';

// Identity selection only. Historical V2 metadata never grants another scope,
// supplies credentials, or permits skipping current scope/asset exclusions.
const { Op, literal } = require('sequelize');
const C = require('./metaMarketingEnrollment.contract');
const G = require('./metaMarketingLegacyRecovery.service');
const fail = () => C.fail('meta_enrollment_identity_review', 409);
const need = value => { if (!value) fail(); };
const date = value => value instanceof Date && Number.isFinite(+value);
const FIELDS = ['id', 'userId', 'metaUserId', 'broker_app_id', 'credentials_external',
  [literal('(accessToken IS NULL)'), 'credentials_absent']];

function witness(raw, enrollment, flow, { appId, subjectId, canonical, legacy }) {
  // snapshotRecord validates stored canonical JSON/hash, not a live legacy
  // credential. Do not call foreign-scope assertActive/committed or read tokens.
  let recovery, origin, candidate;
  try {
    recovery = G.snapshotRecord(raw);
    origin = C.request(enrollment);
    candidate = C.candidate(JSON.parse(flow.candidate_metadata), flow);
  } catch { fail(); }
  need(recovery.snapshot.version === 2 && ['active', 'retired'].includes(recovery.state)
    && date(recovery.activated_at) && date(recovery.bound_at)
    && +recovery.bound_at >= +recovery.prepared_at && +recovery.bound_at < +recovery.expires_at
    && +recovery.activated_at >= +recovery.bound_at
    && recovery.app_id === appId && recovery.meta_user_id === subjectId
    && Number(recovery.source_connection_id) === Number(legacy.id)
    && Number(G.canonicalId(recovery)) === Number(canonical.id));
  const original = recovery.snapshot.inventory.connections.find(row => Number(row.id) === Number(legacy.id));
  need(original && original.userId === legacy.userId && original.metaUserId === legacy.metaUserId
    && original.broker_app_id === legacy.broker_app_id
    && Number(original.credentials_external) === Number(legacy.credentials_external));
  need(['active', 'revoke_pending', 'revoked', 'superseded'].includes(origin.state)
    && date(origin.activated_at) && date(origin.prepared_at) && +origin.activated_at >= +origin.prepared_at
    && origin.mappingIds.length === origin.selected.length && origin.mappingIds.length > 0
    && C.HASH.test(origin.selection_digest || '')
    && origin.enrollment_id === recovery.enrollment_id && origin.flow_id === recovery.flow_id
    && origin.scope_key === recovery.scope_key && origin.clinic_ids === recovery.clinic_ids
    && origin.app_id === appId && origin.meta_user_id === subjectId
    && Number(origin.meta_connection_id) === Number(canonical.id)
    && origin.candidate_digest === recovery.candidate_digest);
  need(flow && ['staged', 'cancel_pending', 'cancelled'].includes(flow.state)
    && flow.flow_id === recovery.flow_id && flow.scope_key === recovery.scope_key
    && flow.clinic_ids === recovery.clinic_ids && flow.app_id === appId
    && Number(flow.actor_user_id) === Number(recovery.prepared_by_user_id)
    && Number(origin.actor_user_id) === Number(flow.actor_user_id)
    && origin.connection_ref === flow.connection_ref && origin.scope_digest === flow.scope_digest
    && origin.flow_digest === C.sourceDigest(flow)
    && candidate.tokenType === 'USER' && candidate.appId === appId && candidate.subjectId === subjectId
    && candidate.digest === recovery.candidate_digest);
  need(recovery.mappingIds.every(id => origin.mappingIds.includes(id)));
  try { G.selection({ version: 2, newPageCount: recovery.snapshot.newPageCount,
    aliases: recovery.snapshot.inventory.aliases.filter(alias => recovery.mappingIds.includes(Number(alias.id))) }, origin.selected); }
  catch { fail(); }
  // Lifecycle state, retirement/completion timestamps, old credential expiry
  // and current credential epoch are deliberately not identity dependencies.
  return [recovery.recovery_id, recovery.snapshot_digest, recovery.flow_id, recovery.enrollment_id,
    recovery.candidate_digest, recovery.activated_at.toISOString(), origin.flow_digest,
    origin.selection_digest, origin.activated_at.toISOString()];
}

async function resolveUserIdentity({ models, appId, subjectId, expectedConnectionId = null,
  transaction = null, lock = false, requireRegistered = false, allowHistoricalReuse = false }) {
  if (!transaction || transaction.finished || lock && !transaction.LOCK?.UPDATE) C.fail('meta_enrollment_unavailable');
  const options = { raw: true, logging: false, ...(transaction ? { transaction } : {}),
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) };
  // Recovered readers acquire connection rows before the registry. Ordinary
  // writers must use that same order; never retain an earlier owner-row lock.
  const rows = await models.MetaConnection.findAll({ ...options, attributes: FIELDS,
    where: { [Op.or]: [{ metaUserId: subjectId }, ...(expectedConnectionId ? [{ id: expectedConnectionId }] : [])] },
    order: [['id', 'ASC']], limit: 3 });
  need(Array.isArray(rows) && rows.length <= 2);
  const owner = await models.MetaMarketingEnrollmentIdentity.findByPk(subjectId, options);
  const application = appId || owner?.app_id || rows[0]?.broker_app_id;
  if (!rows.length) { need(!owner && !requireRegistered && !expectedConnectionId); return { connection: null, owner: null, provenanceDigest: null }; }
  need(rows.every(row => row.metaUserId === subjectId && C.positive(Number(row.id))));
  if (owner) need(owner.meta_user_id === subjectId && owner.app_id === application);
  const canonical = rows.length === 1 ? rows[0] : rows.find(row => Number(row.id) === Number(owner?.meta_connection_id));
  need(canonical && canonical.broker_app_id === application && Number(canonical.credentials_external) === 1
    && Number(canonical.credentials_absent) === 1
    && (!expectedConnectionId || Number(canonical.id) === Number(expectedConnectionId))
    && (!owner || Number(owner.meta_connection_id) === Number(canonical.id))
    && (!requireRegistered || owner));
  if (rows.length === 1) return { connection: canonical, owner, provenanceDigest: null };
  need(allowHistoricalReuse && owner && canonical.userId === null);
  const legacy = rows.find(row => Number(row.id) !== Number(canonical.id));
  need(legacy && C.positive(Number(legacy.userId)) && legacy.broker_app_id === null
    && Number(legacy.credentials_external) === 0 && Number(legacy.credentials_absent) === 0);
  if (!models.MetaMarketingRecovery || !models.MetaMarketingEnrollmentRequest || !models.MetaMarketingOAuthRequest) {
    C.fail('meta_enrollment_unavailable');
  }
  // Nonlocking consistent history reads: an origin withdrawal must not invert
  // its enrollment -> recovery -> connection locks or revoke this identity.
  const historyOptions = { raw: true, logging: false, ...(transaction ? { transaction } : {}) };
  const records = await models.MetaMarketingRecovery.findAll({ ...historyOptions,
    where: { app_id: application, meta_user_id: subjectId, source_connection_id: Number(legacy.id),
      canonical_connection_id: null, state: { [Op.in]: ['active', 'retired'] }, activated_at: { [Op.ne]: null } },
    order: [['activated_at', 'ASC'], ['recovery_id', 'ASC']], limit: 1 });
  need(Array.isArray(records) && records.length === 1);
  const record = records[0];
  // Database failures propagate as unavailable; never classify an uncertain
  // read as identity_review, which would trigger permanent withdrawal.
  const enrollment = await models.MetaMarketingEnrollmentRequest.findByPk(record.enrollment_id, historyOptions);
  const flow = await models.MetaMarketingOAuthRequest.findByPk(record.flow_id, historyOptions);
  witness(record, enrollment, flow, { appId: application, subjectId, canonical, legacy });
  const metadata = row => [Number(row.id), row.userId, row.metaUserId, row.broker_app_id, Number(row.credentials_external)];
  // This digest pins the attested identity tuple, not a particular historical
  // witness or foreign lifecycle. A later lawful migration of the same tuple
  // cannot close an otherwise healthy enrollment. The selected historical
  // witness is nevertheless fully validated on every resolution.
  const provenanceDigest = C.hash(JSON.stringify(['canonical-user-identity-v1', application, subjectId,
    Number(owner.meta_connection_id), metadata(canonical), metadata(legacy)]));
  return { connection: canonical, owner, provenanceDigest };
}

module.exports = { resolveUserIdentity, witness, FIELDS };
