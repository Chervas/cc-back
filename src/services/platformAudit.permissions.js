'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID } = require('../../services/platform-audit/src/event');
const { FEATURE_KEYS, ROLE_CODES, PERMISSION_ACTIONS } = require('../../services/platform-audit/src/access-policy-contract');
const unavailable = () => ({ status: 503, body: { message: 'Permission operation unavailable', error: 'permission_audit_unavailable' } });
const positive = v => (typeof v === 'number' && Number.isSafeInteger(v) || typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v)) && Number(v) > 0 && Number(v) <= 2147483647;
const normalized = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
function inputFor(action, req) {
  if (!PERMISSION_ACTIONS.includes(action)) throw Error();
  const mutation = action === 'permission.override.change'; const raw = (mutation ? req.body : req.query) || {};
  const allowed = action === 'permission.catalog.read' ? [] : action === 'permission.assignments.read' ? ['scope_type', 'scope_id']
    : mutation ? ['scope_type', 'scope_id', 'feature_key', 'role_code', 'state', 'effect'] : ['scope_type', 'scope_id', 'feature_key'];
  if (Object.keys(raw).some(k => !allowed.includes(k))) throw Error();
  if (['feature_key', 'role_code', 'state', 'effect'].some(k => raw[k] != null && typeof raw[k] !== 'string')) throw Error();
  const scoped = raw.scope_type !== undefined || raw.scope_id !== undefined;
  const scope = scoped ? { type: normalized(raw.scope_type), id: String(raw.scope_id) } : { type: 'platform', id: null };
  if (scoped && (!['clinic', 'group'].includes(scope.type) || !positive(raw.scope_id)) || !scoped && (mutation || action === 'permission.assignments.read')) throw Error();
  const featureKey = raw.feature_key ? normalized(raw.feature_key) : mutation ? 'marketing' : null;
  if (featureKey !== null && !FEATURE_KEYS.includes(featureKey)) throw Error();
  const roleCode = mutation ? normalized(raw.role_code) : null;
  let requestedEffect = null;
  if (mutation) {
    if (!ROLE_CODES.includes(roleCode)) throw Error();
    const effect = normalized(raw.state ?? raw.effect ?? '');
    if (!['', 'null', 'inherit', 'allow', 'deny'].includes(effect)) throw Error();
    requestedEffect = ['', 'null', 'inherit'].includes(effect) ? 'inherit' : effect;
    if (raw.state != null && raw.effect != null && normalized(raw.state) !== normalized(raw.effect)) throw Error();
  }
  return { scope, featureKey, roleCode, requestedEffect };
}
function createCapture({ repository, sequelize, catalog, enabled = () => process.env.PLATFORM_AUDIT_PERMISSIONS_ENABLED, now = () => new Date() }) {
  return { async run(action, req, work) {
    const flag = enabled(); if (![undefined, '', 'true', 'false'].includes(flag)) return unavailable();
    const active = flag === 'true'; const mutation = action === 'permission.override.change';
    if (!positive(req.userData?.userId)) return { status: 401, body: { message: 'Auth failed!' } };
    let valid = true; let fields;
    try { fields = inputFor(action, req); } catch { valid = false; fields = { scope: { type: 'platform', id: null }, featureKey: null, roleCode: null, requestedEffect: null }; }
    const base = { version: 4, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: now().toISOString(), action,
      stage: 'attempted', outcome: 'unknown', reason: 'request_received', actor: { type: 'user', id: String(req.userData.userId) },
      sessionRef: typeof req.authSession?.id === 'string' && UUID.test(req.authSession.id) ? req.authSession.id : null,
      ...fields, previousEffect: null, resultCount: null, scopeClinicCount: null, authorizationBasis: 'not_evaluated',
      authorizationPolicyVersion: createHash('sha256').update('access-policy-full-scope-v1\0').update(JSON.stringify(catalog())).digest('hex'), capturePolicy: 'permissions-durable-v1' };
    const ctx = { transaction: undefined, previousEffect: null, basis: 'not_evaluated', count: 0,
      authorize(basis, count) { this.basis = basis; this.count = count; } };
    const complete = async (response, transaction) => {
      if (!active) return;
      const ok = response.status >= 200 && response.status < 300;
      const denied = [400, 401, 403, 404].includes(response.status);
      await repository.append({ ...base, eventId: randomUUID(), occurredAt: now().toISOString(), stage: 'completed',
        outcome: ok ? 'success' : denied ? 'denied' : 'error',
        reason: ok ? mutation ? ctx.previousEffect === base.requestedEffect ? 'override_unchanged' : 'override_changed' : 'records_prepared'
          : denied ? response.status === 400 ? 'request_invalid' : 'access_denied' : 'operation_unconfirmed',
        authorizationBasis: denied ? response.status === 400 ? 'not_evaluated' : 'scope_denied' : ctx.basis,
        previousEffect: ok && mutation ? ctx.previousEffect : null, scopeClinicCount: ctx.count,
        resultCount: ok ? mutation ? ctx.previousEffect === base.requestedEffect ? 0 : 1
          : action === 'permission.catalog.read' ? response.body.features.length : action === 'permission.assignments.read' ? response.body.total : response.body.items.length : 0,
      }, { transaction });
    };
    if (active) {
      try { const health = await repository.health(now(), { includeUnresolved: false });
        if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) return unavailable();
        await repository.append(base);
      } catch { return unavailable(); }
    }
    let response;
    try {
      if (!valid) response = { status: 400, body: { message: 'Invalid permission request' } };
      else {
        const perform = async transaction => {
          ctx.transaction = transaction; let status = 200; let result;
          const sink = { status(value) { status = value; return this; }, json(body) { if (result) throw Error('permission_response_duplicate'); result = { status, body }; return this; } };
          await work(req, sink, ctx); if (!result) throw Error('permission_response_missing');
          if (transaction && result.status >= 400) throw { response: result };
          await complete(result, transaction); return result;
        };
        if (mutation) response = await sequelize.transaction({ isolationLevel: 'SERIALIZABLE' }, perform);
        else return await perform();
      }
    } catch (error) { response = error?.response || unavailable(); }
    // On successful mutation the completion was committed with the override.
    if (!valid || response.status >= 400) {
      try { await complete(response); } catch { return unavailable(); }
    }
    return response;
  } };
}
let singleton;
module.exports = { inputFor, createCapture, async run(action, req, work) {
  if (!singleton) {
    const models = require('../../models');
    singleton = createCapture({ sequelize: models.sequelize, repository: require('./platformAudit.repository').createRepository(models.PlatformAuditEvent),
      catalog: require('../lib/access-policy').getAccessPolicyCatalog });
  }
  return singleton.run(action, req, work);
} };
