'use strict';
const express = require('express');
const auth = require('./auth.middleware');
const gateway = require('../services/whatsappOnboardingGateway.service');
const { assertGateway } = require('../lib/whatsappOnboardingBrokerClient');
const S = require('../services/whatsappAuthorizationState.contract');
const ORIGINS = new Set(['https://app.clinicaclick.com', 'https://crm.clinicaclick.com', 'https://autenticacion.clinicaclick.com']);
function createRouter({ service = gateway, listing = require('../services/whatsappAuthorizationListing.service'), activation = require('../services/whatsappPhoneActivation.service'), authenticate = auth, guard = assertGateway } = {}) {
  const router = express.Router({ strict: true });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Content-Type-Options', 'nosniff'); next();
  });
  // Static sandbox frame: no actor, account metadata or token in this response.
  // The authenticated parent supplies one attempt through a bound handshake.
  router.get('/window', (req, res, next) => {
    try { guard(); if (req.originalUrl.includes('?')) S.fail(); require('../lib/whatsappOnboardingWindow').render(res); }
    catch (error) { next(error); }
  });
  router.use((req, res, next) => {
    try {
      guard();
      if (!ORIGINS.has(req.get('origin')) || req.get('x-whatsapp-onboarding') !== '1') S.fail('whatsapp_authorization_forbidden', 403);
      if (req.method !== 'POST' || !['/begin','/finish','/status','/cancel','/authorizations','/complete'].includes(req.path) || req.originalUrl.includes('?')) S.fail();
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.get('content-type') || '') || req.get('content-encoding')) {
        return res.status(415).json({ error: { code: 'whatsapp_onboarding_json_required' } });
      }
      next();
    } catch (error) { next(error); }
  });
  router.use(authenticate);
  // Mounted before the application's general parser; do not retain rawBody.
  router.use(express.json({ limit: '8kb', inflate: false, strict: true, type: 'application/json' }));
  router.post('/authorizations', async (req, res, next) => {
    try {
      S.exact(req.body, ['scope']);
      const result = await listing.list({...req.body,userId:req.userData?.userId,sessionRef:req.authSession?.id,sessionExpiresAt:req.authSession?.expiresAt});
      res.json(result);
    } catch (error) { next(error); }
  });
  router.post('/complete',async(req,res,next)=>{
    try{S.exact(req.body,['requestId']);res.json(await activation.complete({...req.body,userId:req.userData?.userId,
      sessionRef:req.authSession?.id,sessionExpiresAt:req.authSession?.expiresAt}));}catch(error){next(error);}
  });
  for (const name of ['begin','finish','status','cancel']) router.post('/' + name, async (req, res, next) => {
    try {
      const keys = ['requestId', ...(name === 'begin' ? ['scope', ...(Object.hasOwn(req.body || {}, 'channelRole') ? ['channelRole'] : [])] : name === 'finish' ? ['state','code','wabaId','phoneId'] : [])];
      S.exact(req.body, keys);
      const input = { ...req.body, userId: req.userData?.userId, sessionRef: req.authSession?.id, sessionExpiresAt: req.authSession?.expiresAt };
      const result = await service[name](input);
      // No raw provider errors, request bodies, tokens or hashes in responses.
      res.json(result);
    } catch (error) { next(error); }
  });
  router.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'whatsapp_onboarding_body_too_large' } });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'whatsapp_authorization_invalid' } });
    const clean = gateway.safe(error);
    res.status(clean.status).json({ error: { code: clean.code }, outcomeUnknown: clean.outcomeUnknown });
  });
  return router;
}
module.exports = createRouter(); module.exports.createRouter = createRouter;
