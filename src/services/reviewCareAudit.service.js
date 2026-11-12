'use strict';

const patientReads = require('./platformAudit.patientReads');
const { MAX_CLINICS, MAX_PATIENTS, positive } = require('../../services/platform-audit/src/patient-read-contract');

const ACTION = 'patient.list';
const problem = status => Object.assign(new Error(status === 401 ? 'La sesión ya no está disponible.'
  : status === 403 ? 'El acceso ya no está disponible.' : 'La lectura no está disponible temporalmente.'),
{ status, code: status === 401 ? 'auth_invalid' : status === 403 ? 'review_care_forbidden' : 'review_care_audit_unavailable' });
const closed = error => problem(error?.status === 401
  || ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error?.name) ? 401
  : error?.status === 403 || error?.message === 'access_policy_forbidden' ? 403 : 503);

function ids(values, max) {
  if (!Array.isArray(values) || values.some(value => !['number', 'string'].includes(typeof value) || !positive(String(value)))) {
    throw problem(503);
  }
  const result = [...new Set(values.map(String))].sort((a, b) => Number(a) - Number(b));
  if (result.length > max) throw problem(503);
  return Object.freeze(result);
}

function metadataFor(value) {
  if (!value || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'clinicIds,includesSensitive,patientIds,resultCount'
    || !Number.isSafeInteger(value.resultCount) || value.resultCount < 0 || value.resultCount > 1000000000
    || typeof value.includesSensitive !== 'boolean') throw problem(503);
  const clinicIds = ids(value.clinicIds, MAX_CLINICS), patientIds = ids(value.patientIds, MAX_PATIENTS);
  if ((patientIds.length || value.includesSensitive) && !clinicIds.length) throw problem(503);
  return Object.freeze({ clinicIds, patientIds, resultCount: value.resultCount, includesSensitive: value.includesSensitive });
}

function requestSnapshot(req) {
  if (!req || !['number', 'string'].includes(typeof req.userData?.userId)
    || !positive(String(req.userData.userId)) || typeof req.headers?.authorization !== 'string') throw problem(401);
  // Keep the authenticated request's real identity in RAM. Each invocation owns
  // a different WeakMap key, including parallel reads on the same HTTP request.
  return Object.freeze({ ...req, headers: Object.freeze({ ...req.headers }), userData: Object.freeze({ ...req.userData }),
    authSession: req.authSession ? Object.freeze({ ...req.authSession }) : undefined });
}

/** Wrap clinical reads/snapshot calculation only, never a send, write or enqueue. */
function createReviewCareAudit({ capture, db, sessions } = {}) {
  const models = () => db || require('../../models');
  const sessionService = () => sessions || require('./accessSession.service');
  async function verifySession(req) {
    const service = sessionService(), actorId = String(req.userData.userId), sessionRef = req.authSession?.id ?? null;
    const token = service.bearer(req.headers.authorization);
    const claims = await service.verify(token);
    const verifiedRef = claims?.sessionVersion || claims?.authDelegation ? claims.jti : null;
    if (String(claims?.userId) !== actorId || verifiedRef !== sessionRef) throw problem(401);
  }
  let currentCapture = capture;
  function audit() {
    currentCapture ||= patientReads.createCapture({
      repository: () => require('./platformAudit.repository').createRepository(models().PlatformAuditEvent),
      transaction: fn => models().sequelize.transaction(fn), verifySession,
    });
    if (typeof currentCapture.run !== 'function') throw problem(503);
    return currentCapture;
  }

  return { async run({ req, revalidate, work } = {}) {
    try {
      if (typeof revalidate !== 'function' || typeof work !== 'function') throw problem(503);
      const internalReq = requestSnapshot(req), prepared = {};
      const recheck = async () => { await verifySession(internalReq); await revalidate(); };
      let performed = false, ready = false, value;
      const response = await audit().run(ACTION, internalReq, async (auditReq, res) => {
        if (performed || auditReq !== internalReq) throw problem(503);
        performed = true;
        // The existing capture omits rechecks when disabled. These checks stay
        // mandatory in either mode and also surround the read itself.
        await recheck();
        const result = await work();
        if (!result || Array.isArray(result) || Object.keys(result).sort().join(',') !== 'metadata,value') throw problem(503);
        const metadata = metadataFor(result.metadata);
        value = result.value;
        patientReads.track(internalReq, metadata, recheck);
        await recheck();
        ready = true;
        // Clinical content never becomes an audit response body or event field.
        res.status(200).json(prepared);
      });
      if (response?.status !== 200) throw problem(response?.status === 401 ? 401 : response?.status === 403 ? 403 : 503);
      if (!ready || response.body !== prepared) throw problem(503);
      return value;
    } catch (error) { throw closed(error); }
  } };
}

let instance;
function current() { return instance ||= createReviewCareAudit(); }

module.exports = { createReviewCareAudit, current };
