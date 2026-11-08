'use strict';
const C = require('../services/metaMarketingEnrollment.contract');
const { safe } = require('../services/metaLeadReceptionSetup.service');
function createRouter({ service = require('../services/metaLeadReceptionSetup.service'), sessions = require('../services/accessSession.service') } = {}) {
  const router = require('express').Router({ strict: true });
  const handler = action => async (req, res) => {
    res.set('Cache-Control', 'private, no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Content-Type-Options', 'nosniff');
    try {
      const claims = await sessions.verify(require('../services/accessSession.service').bearer(req.headers.authorization));
      if (claims.sessionVersion !== 1 || !C.UUID.test(claims.jti) || !C.positive(claims.userId)
        || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()) C.fail('meta_oauth_session_required', 401);
      if (Object.keys(req.query).sort().join(',') !== 'assignment_scope,clinic_id' || req.query.assignment_scope !== 'clinic'
        || typeof req.query.clinic_id !== 'string' || !/^[1-9][0-9]{0,9}$/.test(req.query.clinic_id) || !C.positive(Number(req.query.clinic_id))) C.fail('meta_lead_setup_invalid', 400);
      if (action === 'execute' && !/^[1-9][0-9]{0,9}$/.test(req.params.id)) C.fail('meta_lead_setup_invalid', 400);
      if (action === 'overview' && req.body !== undefined && Object.keys(req.body).length) C.fail('meta_lead_setup_invalid', 400);
      const input = { scopeKey: 'clinic:' + req.query.clinic_id, actorId: claims.userId, sessionRef: claims.jti, sessionExpiresAt: new Date(claims.exp * 1000) };
      return res.json(action === 'execute' ? await service.execute(input, Number(req.params.id), req.body) : await service.overview(input));
    } catch (error) {
      const status = ['JsonWebTokenError', 'TokenExpiredError'].includes(error?.name) ? 401
        : [400, 401, 403, 409, 429].includes(error?.httpStatus) ? error.httpStatus : 503;
      return res.status(status).json({ success: false, error: safe(error) });
    }
  };
  router.get('/lead-reception', handler('overview'));
  router.post('/lead-reception/pages/:id', handler('execute'));
  return router;
}
module.exports = { createRouter };
