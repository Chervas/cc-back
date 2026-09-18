'use strict';
const express = require('express');
const { createGoogleAdsActionJournal, safe, status } = require('../services/googleAdsActionJournal.service');
const { positive } = require('../services/googleAdsBrokerScope.service');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
function requested(req, family) {
  const body = req.body;
  if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(req.query || {}).length) fail('invalid_request');
  const scopeFields = Object.keys(body).filter(key => ['clinic_id', 'group_id'].includes(key));
  if (scopeFields.length !== 1 || !positive(body[scopeFields[0]])) fail('invalid_request');
  const expected = ['customer_id', 'request_id', scopeFields[0], ...(family === 'prepare' ? ['mode', 'currency', 'targets']
    : family === 'apply' ? ['confirm_external_mutation'] : family === 'cancel' ? ['input'] : [])];
  if (Object.keys(body).sort().join(',') !== expected.sort().join(',')
    || typeof body.customer_id !== 'string' || !/^[0-9]{10}$/.test(body.customer_id) || body.customer_id === '0000000000'
    || typeof body.request_id !== 'string' || !UUID.test(body.request_id)
    || family !== 'prepare' && (typeof req.params.planId !== 'string' || !UUID.test(req.params.planId))) fail('invalid_request');
  if (family === 'apply' && body.confirm_external_mutation !== true) fail('google_action_confirmation_required');
  return { scope: { clinicId: scopeFields[0] === 'clinic_id' ? Number(body.clinic_id) : null,
    groupId: scopeFields[0] === 'group_id' ? Number(body.group_id) : null,
    assignmentScope: scopeFields[0] === 'clinic_id' ? 'clinic' : 'group' }, customerId: body.customer_id,
  input: family === 'prepare' ? structuredClone({ mode: body.mode, currency: body.currency, targets: body.targets })
    : { planId: req.params.planId, ...(family === 'cancel' ? { input: structuredClone(body.input) } : {}) },
  options: { requestId: body.request_id, confirmExternalMutation: body.confirm_external_mutation === true } };
}
function createRouter({ models = () => require('../../models'), sessions = require('../services/accessSession.service'),
  resolveRuntime = (...args) => require('../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime(...args),
  journal = createGoogleAdsActionJournal({ models, sessions }) } = {}) {
  const router = express.Router(), getModels = () => typeof models === 'function' ? models() : models;
  const handle = family => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const value = requested(req, family); let claims;
      try { claims = await sessions.verify(sessions.bearer(req.headers.authorization)); }
      catch { fail('google_action_session_required'); }
      if (claims.sessionVersion !== 1 || !positive(claims.userId) || !UUID.test(claims.jti)
        || !Number.isSafeInteger(claims.exp * 1000)) fail('google_action_session_required');
      const actor = { userId: Number(claims.userId), sessionRef: claims.jti, expiresAt: claims.exp * 1000 };
      const m = getModels(); let expectedIds;
      const beforeExecute = async ({ transaction } = {}) => {
        const clinics = await m.Clinica.findAll({ attributes: ['id_clinica'], raw: true, logging: false,
          where: value.scope.groupId ? { grupoClinicaId: value.scope.groupId } : { id_clinica: value.scope.clinicId },
          order: [['id_clinica', 'ASC']], limit: 1001, ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
        const ids = clinics.map(row => Number(row.id_clinica));
        if (!ids.length || ids.length > 1000 || ids.some(id => !positive(id)) || new Set(ids).size !== ids.length
          || expectedIds && JSON.stringify(ids) !== JSON.stringify(expectedIds)) return false;
        if (!await hasMarketingClinicScopeAccess({ userId: actor.userId, clinicIds: ids, access: 'write',
          membershipModel: { findAll: options => m.UsuarioClinica.findAll({ ...options, logging: false,
            ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) }) } })) return false;
        expectedIds ||= ids; return true;
      };
      if (!await beforeExecute()) fail('scope_denied');
      const runtime = await resolveRuntime({ userId: actor.userId, customerId: value.customerId, ...value.scope, requireBroker: true });
      const scopeKey = value.scope.assignmentScope + ':' + (value.scope.clinicId || value.scope.groupId);
      const result = await journal.execute({ actor, scopeKey, runtime, beforeExecute }, family, value.input, value.options);
      return res.status(result.commandState === 'attempted' ? 202 : 200).json({ success: true, ...result });
    } catch (error) { return res.status(status(error)).json({ success: false, error: safe(error) }); }
  };
  router.post('/', handle('prepare'));
  for (const family of ['validate', 'apply', 'status', 'cancel']) router.post(`/:planId/${family}`, handle(family));
  return router;
}
module.exports = { createRouter, requested };
