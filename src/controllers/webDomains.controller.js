'use strict';

const webDomainsService = require('../services/webDomains.service');
const { withRequestContext } = require('./webProjects.controller');

const createDomain = withRequestContext(async (req, res, requestId) => {
  const result = await webDomainsService.createDomain({
    actorId: req.userData?.userId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido registrar el dominio.');

const listDomains = withRequestContext(async (req, res, requestId) => {
  const domains = await webDomainsService.listDomains({
    actorId: req.userData?.userId,
    query: req.query || {},
  });
  return res.json({ success: true, domains, request_id: requestId });
}, 'No se han podido cargar los dominios.');

const verifyDomain = withRequestContext(async (req, res, requestId) => {
  const domain = await webDomainsService.verifyDomain({
    actorId: req.userData?.userId,
    domainId: req.params.domainId,
    requestId,
  });
  return res.json({ success: true, domain, request_id: requestId });
}, 'No se ha podido verificar el dominio.');

const rotateDomainToken = withRequestContext(async (req, res, requestId) => {
  const result = await webDomainsService.rotateDomainToken({
    actorId: req.userData?.userId,
    domainId: req.params.domainId,
    requestId,
  });
  return res.json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido generar una nueva verificación del dominio.');

module.exports = {
  createDomain,
  listDomains,
  rotateDomainToken,
  verifyDomain,
};
