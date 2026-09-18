'use strict';
const express = require('express');
const { createGoogleDestinationJournal, safe, status } = require('../services/googleDestinationJournal.service');
const { positive } = require('../services/googleAdsBrokerScope.service');
const { googleConversionRequestContext } = require('../lib/googleConversionRequestContext');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
function requested(req, family) {
  const body = req.body;
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(req.query || {}).length) fail('invalid_request');
  const scopeFields = Object.keys(body).filter(key => ['clinic_id','group_id'].includes(key));
  if (scopeFields.length !== 1 || !positive(body[scopeFields[0]])) fail('invalid_request');
  const expected = ['customer_id','request_id',scopeFields[0], ...(family === 'authorize' ? ['plan_id','targets','confirm_authorization'] : family === 'revoke' ? ['input'] : family === 'list' ? ['cursor','plan_id'] : [])];
  if (Object.keys(body).sort().join(',') !== expected.sort().join(',')
    || typeof body.customer_id !== 'string' || !/^[0-9]{10}$/.test(body.customer_id) || body.customer_id === '0000000000'
    || typeof body.request_id !== 'string' || !UUID.test(body.request_id)
    || !['authorize','list'].includes(family) && (typeof req.params.authorizationId !== 'string' || !UUID.test(req.params.authorizationId))) fail('invalid_request');
  if (family === 'authorize' && body.confirm_authorization !== true) fail('google_destination_confirmation_required');
  return { scope: { clinicId: scopeFields[0] === 'clinic_id' ? Number(body.clinic_id) : null,
    groupId: scopeFields[0] === 'group_id' ? Number(body.group_id) : null, assignmentScope: scopeFields[0] === 'clinic_id' ? 'clinic' : 'group' },
    customerId: body.customer_id, input: family === 'list' ? { cursor: structuredClone(body.cursor), planId: body.plan_id }
      : family === 'authorize' ? { planId: body.plan_id, targets: structuredClone(body.targets) }
      : { authorizationId: req.params.authorizationId, ...(family === 'revoke' ? { input: structuredClone(body.input) } : {}) },
    options: { requestId: body.request_id, confirmAuthorization: body.confirm_authorization === true } };
}
function createRouter({ models = () => require('../../models'), sessions = require('../services/accessSession.service'),
  resolveRuntime = (...args) => require('../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime(...args),
  journal = createGoogleDestinationJournal({ models, sessions }) } = {}) {
  const router = express.Router();
  const handle = family => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const value = requested(req, family);
      const context = await googleConversionRequestContext(req, value, { models, sessions, resolveRuntime, sessionError: 'google_destination_session_required' });
      const result = family === 'list' ? await journal.list(context, value.input, { requestId: value.options.requestId })
        : await journal.execute(context, family, value.input, value.options);
      return res.status(result.commandState === 'attempted' ? 202 : 200).json({ success: true, ...result });
    } catch (error) { return res.status(status(error)).json({ success: false, error: safe(error) }); }
  };
  router.post('/', handle('authorize'));
  router.post('/list', handle('list'));
  for (const family of ['status','revoke']) router.post(`/:authorizationId/${family}`, handle(family));
  return router;
}
module.exports = { createRouter, requested };
