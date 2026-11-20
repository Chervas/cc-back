'use strict';
const express = require('express');
const { isGlobalAdmin } = require('../lib/role-helpers');
const { createWorkspace } = require('../services/dpdWorkspace.service');
const cookie = 'cc_dpd_reader';
const options = { path: '/api/dpd/guest', httpOnly: true, secure: true, sameSite: 'strict' };

function createRouter(service, auth = require('./auth.middleware')) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const run = fn => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
      if ([400,403,409].includes(e.status)) return res.status(e.status).json({ message: e.message });
      next(e);
    }
  };
  router.post('/guest/open', run(async (req, res) => {
    const session = await service.redeem(req.body || {});
    res.cookie(cookie, session, { ...options, maxAge: 8 * 3600000 }).sendStatus(204);
  }));
  router.get('/guest', run(async (req, res) => {
    if (!await service.checkSession(req.cookies?.[cookie])) return res.sendStatus(403);
    res.json(await service.read(false));
  }));
  router.post('/guest/logout', run(async (req, res) => {
    await service.logout(req.cookies?.[cookie]);
    res.clearCookie(cookie, options).sendStatus(204);
  }));
  router.use(auth, (req, res, next) => {
    if (req.authDelegation || !isGlobalAdmin(req.userData?.userId)) return res.sendStatus(403);
    next();
  });
  router.get('/', run(async (req, res) => res.json(await service.read(true))));
  router.put('/entries/:key', run(async (req, res) => res.json(await service.save(req.params.key, req.body || {}, req.userData.userId))));
  router.post('/invitation', run(async (req, res) => res.json(await service.invite(req.body || {}, req.userData.userId))));
  router.post('/invitation/revoke', run(async (req, res) => res.json(await service.revoke(req.body?.revision, req.userData.userId))));
  return router;
}
module.exports = createRouter(createWorkspace(require('../../models').DpdWorkspaceEntry));
module.exports.createRouter = createRouter;
