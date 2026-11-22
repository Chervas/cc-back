'use strict';

const C = require('../services/metaMarketingOAuth.contract');
const { graphId } = require('../../services/integrations-broker/src/meta-marketing-contract');
const codes = new Set(['meta_instagram_unavailable','meta_instagram_invalid','meta_instagram_expired','meta_instagram_rate_limited',
  'meta_instagram_scope_changed','meta_instagram_scope_forbidden','meta_instagram_connection_required','meta_instagram_session_required',
  'meta_instagram_attempt_in_progress','meta_instagram_permissions_required']);

function createRouter({ service = require('../services/metaMarketingInstagramExtension.service'), sessions = require('../services/accessSession.service') } = {}) {
  const router = require('express').Router({ strict: true });
  const handler = name => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      const claims = await sessions.verify(require('../services/accessSession.service').bearer(req.headers.authorization));
      if (claims.sessionVersion !== 1 || !C.UUID.test(claims.jti) || !C.positive(claims.userId)) C.fail('meta_instagram_session_required', 401);
      const body = req.body === undefined ? {} : req.body;
      const id = req.query.clinic_id;
      if (Object.keys(req.query).join(',') !== 'clinic_id' || typeof id !== 'string'
          || !/^[1-9][0-9]{0,9}$/.test(id) || !C.positive(Number(id))
          || !C.exact(body, name === 'confirm' ? 'instagramId,candidateDigest' : '')
          || (['confirm','cancel'].includes(name) && !C.UUID.test(req.params.id))
          || (name === 'confirm' && (!graphId(body.instagramId) || typeof body.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.candidateDigest)))) {
        C.fail('meta_instagram_invalid', 400);
      }
      const input = { scopeKey: 'clinic:' + id, actorId: claims.userId, sessionRef: claims.jti, sessionExpiresAt: new Date(claims.exp * 1000) };
      return res.json(await (name === 'confirm' ? service.confirm(input, req.params.id, body) : service[name](input, req.params.id)));
    } catch (error) {
      const invalidSession = ['JsonWebTokenError','TokenExpiredError','NotBeforeError'].includes(error?.name);
      const status = invalidSession ? 401 : [400,401,403,409,429].includes(error?.httpStatus) ? error.httpStatus : 503;
      const code = codes.has(error?.code) ? error.code
        : { 400:'meta_instagram_invalid',401:'meta_instagram_session_required',403:'meta_instagram_scope_forbidden',409:'meta_instagram_scope_changed' }[status] || 'meta_instagram_unavailable';
      return res.status(status).json({ success: false, error: code });
    }
  };
  router.get('/instagram-extension', handler('overview'));
  router.post('/instagram-extension', handler('begin'));
  router.post('/instagram-extension/:id/confirmation', handler('confirm'));
  router.delete('/instagram-extension/:id', handler('cancel'));
  return router;
}

module.exports = { createRouter };
