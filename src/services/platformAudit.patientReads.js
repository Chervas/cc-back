'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, pack } = require('../../services/platform-audit/src/event');
const { PATIENT_READ_ACTIONS, MAX_CLINICS, MAX_PATIENTS, IDS_PER_EVENT, positive } = require('../../services/platform-audit/src/patient-read-contract');
const contexts = new WeakMap();
const unavailable = () => ({ status: 503, body: { message: 'La lectura no está disponible temporalmente.', error: 'patient_read_audit_unavailable' } });
const fail = () => { throw Error('patient_read_audit_unavailable'); };
function idsFor(input, max) {
  if (!Array.isArray(input)) fail();
  const ids = [...new Set(input.map(String))].sort((a, b) => Number(a) - Number(b));
  if (ids.length > max || ids.some(id => !positive(id))) fail();
  return ids;
}
function track(req, metadata, revalidate = async () => {}) {
  const context = contexts.get(req); if (!context) return;
  try {
    if (context.metadata || typeof revalidate !== 'function') fail();
    const value = typeof metadata === 'function' ? metadata() : metadata;
    if (!value || Object.keys(value).some(key => !['clinicIds', 'patientIds', 'resultCount', 'includesSensitive'].includes(key))) fail();
    const clinicIds = idsFor(value.clinicIds, MAX_CLINICS); const patientIds = idsFor(value.patientIds, MAX_PATIENTS);
    if (!Number.isSafeInteger(value.resultCount) || value.resultCount < 0 || value.resultCount > 1000000000 || typeof value.includesSensitive !== 'boolean'
      || (patientIds.length || value.includesSensitive) && !clinicIds.length) fail();
    context.metadata = { clinicIds, patientIds, resultCount: value.resultCount, includesSensitive: value.includesSensitive };
    context.revalidate = revalidate;
  } catch (error) {
    // Domain handlers may catch this error and prepare their own 500. Preserve
    // capture failure so the wrapper still emits its closed 503 contract.
    context.captureFailed = true; throw error;
  }
}
function createCapture({ repository, transaction, verifySession, enabled = () => process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED, now = () => new Date() }) {
  const repo = () => typeof repository === 'function' ? repository() : repository;
  async function recheck(req, context) { await verifySession(req); await context.revalidate(); }
  return { async run(action, req, work) {
    const flag = enabled(); if (![undefined, '', 'false', 'true'].includes(flag) || !PATIENT_READ_ACTIONS.includes(action)) return unavailable();
    const active = flag === 'true';
    const context = { metadata: null, revalidate: async () => {} };
    const actorId = String(req.userData?.userId); if (!positive(actorId)) return { status: 401, body: { message: 'Auth failed!' } };
    const base = { version: 6, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: now().toISOString(), action,
      stage: 'attempted', outcome: 'unknown', reason: 'request_received', actor: { type: 'user', id: actorId },
      sessionRef: typeof req.authSession?.id === 'string' && UUID.test(req.authSession.id) ? req.authSession.id : null,
      scope: { type: 'platform', id: null }, clinicIds: [], patientIds: [], patientCount: null, resultCount: null, includesSensitive: null,
      batchIndex: 0, batchCount: 1, resultSetDigest: null, authorizationPolicyVersion: 'patient-read-scope-v1', capturePolicy: 'patient-reads-durable-v1' };
    const event = changes => ({ ...base, eventId: randomUUID(), occurredAt: now().toISOString(), ...changes });
    const failure = status => ({ stage: 'completed', outcome: [400, 401, 403, 404].includes(status) ? 'denied' : 'error',
      reason: status === 400 ? 'request_invalid' : [401, 403].includes(status) ? 'access_denied' : status === 404 ? 'resource_missing' : 'operation_unconfirmed' });
    let status = 200; let response; let completed = false; let begun = false;
    try {
      if (active) {
        await verifySession(req);
        const health = await repo().health(now(), { includeUnresolved: false });
        if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) return unavailable();
        await repo().append(base); begun = true; contexts.set(req, context);
      }
      const sink = { status(value) { if (!Number.isInteger(value) || value < 100 || value > 599) fail(); status = value; return this; },
        json(body) { if (response) fail(); response = { status, body }; return this; } };
      await work(req, sink);
      if (context.captureFailed) fail();
      if (!response) fail();
      if (!active) return response;
      if (response.status < 200 || response.status >= 300) { await repo().append(event(failure(response.status))); return response; }
      if (!context.metadata) fail();
      await recheck(req, context);
      const metadata = context.metadata; const patientCount = metadata.patientIds.length;
      const batchCount = Math.max(1, Math.ceil(patientCount / IDS_PER_EVENT));
      const resultSetDigest = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
      const rows = Array.from({ length: batchCount }, (_, batchIndex) => event({ stage: 'completed', outcome: 'success', reason: 'response_prepared',
        scope: { type: metadata.clinicIds.length === 1 ? 'clinic' : metadata.clinicIds.length ? 'clinic_set' : 'platform',
          id: metadata.clinicIds.length === 1 ? metadata.clinicIds[0] : null },
        ...metadata, patientIds: metadata.patientIds.slice(batchIndex * IDS_PER_EVENT, (batchIndex + 1) * IDS_PER_EVENT),
        patientCount, batchIndex, batchCount, resultSetDigest }));
      rows.forEach(row => { if (Buffer.byteLength(pack(row).body) > 4096) fail(); });
      const health = await repo().health(now(), { includeUnresolved: false });
      if (health.pending + rows.length > 10000 || health.oldestAgeSeconds >= 3600) fail();
      await transaction(async sqlTransaction => { for (const row of rows) await repo().append(row, { transaction: sqlTransaction }); });
      completed = true;
      // Prepared is not delivered. A revocation while committing causes a
      // separate, content-free discard event, never a contradictory completion.
      await recheck(req, context);
      return response;
    } catch (error) {
      const sessionInvalid = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error?.name);
      const denied = sessionInvalid || error?.status === 401 || error?.status === 403 || error?.message === 'access_policy_forbidden';
      const final = denied ? { status: sessionInvalid || error?.status === 401 ? 401 : 403, body: { message: 'El acceso ya no está disponible.' } } : unavailable();
      if (active && begun) {
        try { await repo().append(event(completed ? { stage: 'discarded', outcome: denied ? 'denied' : 'error', reason: denied ? 'access_changed' : 'response_unconfirmed' }
          : failure(final.status))); } catch { return unavailable(); }
      }
      return final;
    } finally { contexts.delete(req); }
  } };
}
function patientIds(rows, { excludeRedactedRelations = false } = {}) {
  const ids = [];
  const visit = (value, depth) => {
    if (!value || depth > 4) return;
    const row = typeof value.toJSON === 'function' ? value.toJSON() : value;
    if (excludeRedactedRelations && depth > 0 && row.privacy_redacted) return;
    if (row.id_paciente != null) ids.push(row.id_paciente);
    for (const relation of row.relaciones || []) visit(relation.relacionado, depth + 1);
    for (const relation of row.tutorDe || []) visit(relation.paciente, depth + 1);
  };
  for (const row of rows) visit(row, 0);
  return idsFor(ids, MAX_PATIENTS);
}
let instance;
function wrap(action, work) {
  return async (req, res) => {
    instance ||= createCapture({
      repository: () => require('./platformAudit.repository').createRepository(require('../../models').PlatformAuditEvent),
      transaction: fn => require('../../models').sequelize.transaction(fn),
      verifySession: async req => {
        const sessions = require('./accessSession.service'); const decoded = await sessions.verify(sessions.bearer(req.headers.authorization));
        if (String(decoded.userId) !== String(req.userData?.userId)) throw Object.assign(new Error('auth_failed'), { status: 401 });
      },
    });
    const response = await instance.run(action, req, work);
    res.set('Cache-Control', 'private, no-store'); return res.status(response.status).json(response.body);
  };
}
module.exports = { createCapture, track, patientIds, wrap };
