'use strict';
const express = require('express');
function createRouter({ service = require('../services/delegatedSession.service'),
  sessions = require('../services/accessSession.service'), auth = require('./auth.middleware') } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const exact = (body, keys) => body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).sort().join(',') === keys.split(',').sort().join(',');
  const respond = handler => async (req, res) => {
    try { return res.json(await handler(req)); }
    catch (error) {
      const known = /^(?:auth_delegation_(?:unavailable|origin_rejected|request_invalid|handoff_invalid|target_forbidden|limit)|delegated_operation_requires_own_session|auth_invalid)$/.test(error.code || '');
      const invalid = ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name);
      return res.status(known ? error.status : invalid ? 401 : 503).json({ error: known ? error.code : invalid ? 'auth_invalid' : 'auth_delegation_unavailable' });
    }
  };
  router.get('/capabilities', auth, respond(req => service.capabilities({ token: sessions.bearer(req.headers.authorization) })));
  router.post('/', auth, respond(req => {
    if (!exact(req.body, 'targetUserId,pkceChallenge,tabNonce')) throw Object.assign(Error(), { code: 'auth_delegation_request_invalid', status: 400 });
    return service.create({ ...req.body, token: sessions.bearer(req.headers.authorization), origin: req.get('origin') });
  }));
  // No ordinary login middleware or principal-token fallback on this endpoint.
  router.post('/exchange', respond(req => {
    if (!exact(req.body, 'handoff,pkceVerifier,tabNonce')) throw Object.assign(Error(), { code: 'auth_delegation_request_invalid', status: 400 });
    return service.exchange({ ...req.body, origin: req.get('origin') });
  }));
  router.post('/:id/revoke', auth, respond(req => {
    if (!exact(req.body, '')) throw Object.assign(Error(), { code: 'auth_delegation_request_invalid', status: 400 });
    return service.revoke({ token: sessions.bearer(req.headers.authorization), delegationId: req.params.id });
  }));
  return router;
}
module.exports = { createRouter };
