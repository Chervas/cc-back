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
      if ([400,403,404,409,410,429,503].includes(e.status)) return res.status(e.status).json({ message: e.message });
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
  const contracts = require('../services/dpdContracts.service');
  const Contract = () => require('../../models').DpdContract;
  for (const action of ['view','review','code','sign']) {
    router.post('/signature/:id/'+action, run(async(req,res)=>res.json(await contracts.operate(req.params.id,action,req.body||{},null))));
  }
  async function download(req,res,admin) {
    const row=await Contract().findByPk(req.params.id,{attributes:['secret_hash','expires','status','pdf'],logging:false});
    if(!admin) contracts.check(row,req.body?.key);
    if(!row?.pdf || row.status!=='firmado')return res.sendStatus(404);
    res.type('application/pdf').attachment('Contrato-Clinica-Click.pdf').send(row.pdf);
  }
  router.post('/signature/:id/pdf',run((req,res)=>download(req,res,false)));
  router.post('/signature/:id/receipt',run(async(req,res)=>{
    const row=await Contract().findByPk(req.params.id,{attributes:['status','dossier'],logging:false});
    const receipt=row?.dossier?.receipt;
    if(!receipt || typeof req.body?.key!=='string' || contracts.hash(req.body.key)!==receipt.hash || Date.parse(receipt.until)<=Date.now()) return res.status(410).json({message:'Por seguridad, el enlace ha caducado. Solicita una copia nueva a tu proveedor.'});
    return download(req,res,true);
  }));
  router.use(auth, (req, res, next) => {
    if (req.authDelegation || !isGlobalAdmin(req.userData?.userId)) return res.sendStatus(403);
    next();
  });
  router.get('/targets',run(async(req,res)=>res.json(await contracts.targets(req.query.q))));
  router.get('/contracts',run(async(req,res)=>res.json((await Contract().findAll({attributes:['id','target','email','status','expires','issued'],order:[['issued','DESC']],logging:false})).map(contracts.state))));
  router.post('/contracts',run(async(req,res)=>res.status(201).json(await contracts.issue(req.body||{},req.userData.userId))));
  for(const action of ['view','regenerate']){
    router.post('/contracts/:id/'+action,run(async(req,res)=>res.json(await contracts.operate(req.params.id,action,req.body||{},req.userData.userId))));
  }
  router.get('/contracts/:id/pdf',run((req,res)=>download(req,res,true)));
  router.get('/', run(async (req, res) => res.json(await service.read(true))));
  router.put('/entries/:key', run(async (req, res) => res.json(await service.save(req.params.key, req.body || {}, req.userData.userId))));
  router.post('/invitation', run(async (req, res) => res.json(await service.invite(req.body || {}, req.userData.userId))));
  router.post('/invitation/revoke', run(async (req, res) => res.json(await service.revoke(req.body?.revision, req.userData.userId))));
  return router;
}
module.exports = createRouter(createWorkspace(require('../../models').DpdWorkspaceEntry));
module.exports.createRouter = createRouter;
