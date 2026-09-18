'use strict';
const express = require('express');
const C = require('../services/googleAdsEnrollment.contract');
const defaults = require('../services/googleAdsEnrollment.service');
function createRouter({ service = defaults, sessions, authorizeScope, resolveConnection }) {
  const router = express.Router();
  function requested(req) {
    const post = req.method === 'POST'; const values = post ? req.body : req.query;
    if (!values || typeof values !== 'object' || Array.isArray(values) || post && Object.keys(req.query).length) C.fail();
    const keys = Object.keys(values); const scopeFields = keys.filter(k => ['clinic_id','group_id'].includes(k));
    if (scopeFields.length !== 1 || keys.some(k => !scopeFields.includes(k) && !(post && ['customerId','enrollmentId'].includes(k)))) C.fail();
    const field = scopeFields[0]; if (!C.positive(values[field])) C.fail();
    if (post && (keys.length !== 3 || !C.UUID.test(values.enrollmentId) || typeof values.customerId !== 'string'
      || !/^\d{10}$/.test(values.customerId) || values.customerId === '0000000000')) C.fail();
    return { scopeKey: (field === 'clinic_id' ? 'clinic:' : 'group:') + Number(values[field]), values };
  }
  async function authorize(req, expected, connectionRequired) {
    let claims;
    try { claims = await sessions.verify(sessions.bearer(req.headers.authorization)); }
    catch { C.fail('google_discovery_session_required'); }
    if (claims.sessionVersion !== 1 || !C.UUID.test(claims.jti) || !C.positive(claims.userId) || !Number.isSafeInteger(claims.exp * 1000)) C.fail('google_discovery_session_required');
    let authorization;
    try { authorization = await authorizeScope(req, 'write'); }
    catch { C.fail('google_discovery_scope_forbidden'); }
    const { scopeKey } = requested(req);
    if (!authorization.requested || scopeKey !== (authorization.assignmentScope === 'group'
      ? 'group:' + Number(authorization.groupId) : 'clinic:' + Number(authorization.clinicId))) C.fail('google_discovery_scope_forbidden');
    const input = { scopeKey, clinicIds: C.clinicIds(authorization.clinicIds), actorId: Number(claims.userId),
      sessionRef: claims.jti, sessionExpiresAt: claims.exp * 1000 };
    if (connectionRequired) {
      const resolved = await resolveConnection(req, { allowLegacyUserFallback: false, metadataOnly: true });
      if (!resolved.connection || !C.positive(resolved.connection.id) || resolved.scope?.scopeKey !== scopeKey) C.fail('google_ads_enrollment_scope_unconfigured');
      input.connectionId = Number(resolved.connection.id);
    }
    if (expected && JSON.stringify(input) !== JSON.stringify(expected)) C.fail('google_ads_enrollment_scope_conflict');
    return input;
  }
  const handle = (action, connectionRequired) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const { values } = requested(req); const input = await authorize(req, null, connectionRequired);
      const result = action === 'discover' ? await service.discover(input)
        : action === 'enqueue' ? await service.enqueue(input, { enrollmentId: values.enrollmentId, customerId: values.customerId })
          : await service.read(input, req.params.enrollmentId);
      await authorize(req, input, connectionRequired);
      return res.status(action === 'enqueue' ? 202 : 200).json({ success: true, ...result });
    } catch (error) { return res.status(defaults.status(error)).json({ success: false, error: defaults.safe(error) }); }
  };
  router.get('/accounts', handle('discover', true));
  router.post('/requests', handle('enqueue', true));
  router.get('/requests/:enrollmentId', handle('read', false));
  return router;
}
module.exports = { createRouter };
