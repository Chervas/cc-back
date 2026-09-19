'use strict';
const express = require('express');
const { createGoogleConversionReceiptReview, safe, status } = require('../services/googleConversionReceiptReview.service');
const { positive } = require('../services/googleAdsBrokerScope.service');
const { googleConversionRequestContext } = require('../lib/googleConversionRequestContext');
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const fail = () => { throw Object.assign(Error('invalid_request'), { code: 'invalid_request' }); };
function requested(req, family) {
  const body = req.body;
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(req.query || {}).length) fail();
  const scope = Object.keys(body).filter(k => ['clinic_id','group_id'].includes(k));
  if (scope.length !== 1 || !positive(body[scope[0]]) || !['list','check'].includes(family)) fail();
  const keys = ['customer_id','request_id',scope[0], ...(family === 'list' ? ['cursor'] : [])];
  if (Object.keys(body).sort().join(',') !== keys.sort().join(',') || !uuid(body.request_id)
    || typeof body.customer_id !== 'string' || !/^\d{10}$/.test(body.customer_id) || body.customer_id === '0000000000'
    || family === 'check' && !uuid(req.params.submissionId)) fail();
  return { scope: { clinicId: scope[0] === 'clinic_id' ? Number(body.clinic_id) : null,
    groupId: scope[0] === 'group_id' ? Number(body.group_id) : null, assignmentScope: scope[0] === 'clinic_id' ? 'clinic' : 'group' },
    customerId: body.customer_id, input: family === 'list' ? { cursor: structuredClone(body.cursor) } : { submissionId: req.params.submissionId },
    options: { requestId: body.request_id } };
}
function createRouter({ models = () => require('../../models'), sessions = require('../services/accessSession.service'),
  resolveRuntime = (...args) => require('../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime(...args),
  review = createGoogleConversionReceiptReview({ models, sessions }) } = {}) {
  const router = express.Router();
  const handle = family => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const value = requested(req, family);
      const context = await googleConversionRequestContext(req, value, { models, sessions, resolveRuntime, sessionError: 'google_receipt_session_required' });
      const result = await review.execute(context, family, value.input, value.options);
      return res.status(200).json({ success: true, ...result });
    } catch (error) { return res.status(status(error)).json({ success: false, error: safe(error) }); }
  };
  router.post('/list', handle('list')); router.post('/:submissionId/check', handle('check')); return router;
}
module.exports = { createRouter, requested };
