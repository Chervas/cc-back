'use strict';
const { randomUUID } = require('node:crypto'); const { Op, fn, col } = require('sequelize');
const { fromRevocation, OPERATION, positive } = require('../../services/platform-audit/src/integration-disconnect-event');
const { createRepository } = require('./platformAudit.repository');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const fs = require('node:fs'); const path = require('node:path');
const fail = code => { throw Object.assign(Error(code), { code, httpStatus: 503 }); };
const SAFE = new Set(['invalid_request', 'invalid_signature', 'scope_denied', 'operation_denied', 'connection_blocked', 'asset_revoked',
  'request_replayed', 'idempotency_conflict', 'outcome_unknown', 'rate_limited', 'audit_unavailable', 'broker_timeout',
  'broker_unavailable', 'broker_response_invalid', 'broker_configuration_invalid', 'gbp_revocation_unavailable']);
const safe = error => SAFE.has(error?.code) ? error.code : 'gbp_revocation_unavailable';
const IDS = ['external_location_id', 'connection_ref', 'asset_ref', 'clinica_id', 'google_connection_id'];
function validate(row) {
  fromRevocation(row, 'attempted', new Date(row.requested_at));
  if (!positive(String(row.google_connection_id)) || !/^[1-9]\d{0,29}$/.test(row.external_location_id)
    || row.asset_ref.split(':')[2] !== row.external_location_id) fail('gbp_revocation_unavailable');
  return row;
}
async function enqueue({ models, transaction, connectionId, clinicIds, actorId, sessionRef,
  enabled = process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED, now = new Date() }) {
  if (!transaction || !positive(String(connectionId)) || !Array.isArray(clinicIds) || clinicIds.some(id => !positive(String(id)))) fail('gbp_revocation_unavailable');
  if (!clinicIds.length) return 0;
  const where = { google_connection_id: Number(connectionId), clinica_id: { [Op.in]: clinicIds } };
  const bindings = await models.BusinessProfileBrokerBinding.findAll({ where, transaction, lock: transaction.LOCK.UPDATE,
    order: [['external_location_id', 'ASC']], limit: 101, raw: true });
  const previous = await models.BusinessProfileBrokerRevocation.findAll({ where, transaction, lock: transaction.LOCK.UPDATE,
    order: [['external_location_id', 'ASC']], limit: 101, raw: true });
  if (!bindings.length && !previous.length) return 0;
  if (enabled !== 'true' || !positive(String(actorId)) || bindings.length > 100 || previous.length > 100) fail('gbp_revocation_unavailable');
  if (previous.some(r => !['pending', 'confirmed'].includes(r.state))) fail('gbp_revocation_unavailable');
  const old = new Map(previous.map(r => [r.external_location_id, validate(r)])); const pending = new Set(previous.filter(r => r.state === 'pending').map(r => r.external_location_id));
  const audit = createRepository(models.PlatformAuditEvent); const health = await audit.health(now, { includeUnresolved: false, transaction });
  if (health.pending + bindings.length > 10000 || health.oldestAgeSeconds >= 3600) fail('gbp_revocation_unavailable');
  for (const binding of bindings) {
    if (old.has(binding.external_location_id)) {
      if (IDS.some(key => String(old.get(binding.external_location_id)[key]) !== String(binding[key]))) fail('gbp_revocation_unavailable');
      continue;
    }
    const row = validate({ ...Object.fromEntries(IDS.map(k => [k, binding[k]])), request_id: randomUUID(),
      actor_user_id: Number(actorId), requested_at: now, next_attempt_at: now, state: 'pending' });
    await models.BusinessProfileBrokerRevocation.create(row, { transaction });
    await audit.append(fromRevocation(row, 'attempted', now, sessionRef), { transaction }); pending.add(row.external_location_id);
  }
  return pending.size;
}
function createRevocationRepository(models) {
  const model = models.BusinessProfileBrokerRevocation; const audit = createRepository(models.PlatformAuditEvent);
  return {
    async claim(now) {
      return models.sequelize.transaction(async transaction => {
        const row = await model.findOne({ where: { state: 'pending', next_attempt_at: { [Op.lte]: now },
          [Op.or]: [{ lease_until: null }, { lease_until: { [Op.lt]: now } }] }, transaction, lock: transaction.LOCK.UPDATE,
          skipLocked: true, order: [['requested_at', 'ASC'], ['external_location_id', 'ASC']] });
        if (!row) return null;
        const lease = randomUUID(); await row.update({ lease_token: lease, lease_until: new Date(now.getTime() + 120000),
          attempts: Math.min(1000000000, Number(row.attempts) + 1) }, { transaction });
        return row.get({ plain: true });
      });
    },
    async confirm(claim, now) {
      return models.sequelize.transaction(async transaction => {
        const row = await model.findByPk(claim.external_location_id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!row || row.state !== 'pending' || row.lease_token !== claim.lease_token || new Date(row.lease_until).getTime() <= now.getTime()) return false;
        if (['request_id', 'actor_user_id', ...IDS].some(k => String(row[k]) !== String(claim[k]))) fail('gbp_revocation_unavailable');
        await audit.append(fromRevocation(validate(row.get({ plain: true })), 'completed', now), { transaction });
        await row.update({ state: 'confirmed', confirmed_at: now, lease_token: null, lease_until: null, last_error: null }, { transaction });
        return true;
      });
    },
    async retry(row, code, now) {
      await model.update({ lease_token: null, lease_until: null, last_error: SAFE.has(code) ? code : 'gbp_revocation_unavailable',
        next_attempt_at: new Date(now.getTime() + Math.min(3600000, 1000 * 2 ** Math.min(Number(row.attempts), 12))) },
      { where: { external_location_id: row.external_location_id, state: 'pending', lease_token: row.lease_token } });
    },
    async health() {
      const pending = await model.count({ where: { state: 'pending' } });
      return { pending };
    },
  };
}
function createRevocationWorker({ repository, client, enabled = () => process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_WORKER_ENABLED === 'true', now = () => new Date() }) {
  let running = false;
  return { async run() {
    if (!enabled() || running) return { status: 'completed', skipped: true, reason: 'gbp_revocation_worker_disabled_or_busy' };
    running = true; let confirmed = 0; let failed = 0;
    try {
      const deadline = now().getTime() + 30000;
      for (let count = 0; count < 20 && now().getTime() < deadline; count++) {
        const row = await repository.claim(now()); if (!row) break;
        try {
          validate(row); const remaining = deadline - now().getTime(); if (remaining <= 0) fail('broker_timeout');
          const result = await client.execute({ requestId: row.request_id, operation: OPERATION, tenantRef: `clinic:${row.clinica_id}`,
            connectionRef: row.connection_ref, assetRef: row.asset_ref, payload: {} }, { timeoutMs: Math.min(10000, remaining) });
          if (result.requestId !== row.request_id || !result.data || Object.keys(result.data).join(',') !== 'revoked' || result.data.revoked !== true) fail('broker_response_invalid');
          if (!await repository.confirm(row, now())) fail('gbp_revocation_unavailable');
          confirmed++;
        } catch (error) { failed++; await repository.retry(row, safe(error), now()); }
      }
      return { status: failed ? 'failed' : 'completed', retryable: false, confirmed, failed, ...await repository.health() };
    } catch (error) { return { status: 'failed', retryable: false, confirmed, failed, error: safe(error) }; }
    finally { running = false; }
  } };
}
function privateFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail('broker_configuration_invalid');
  const stat = fs.statSync(filename); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail('broker_configuration_invalid');
  return fs.readFileSync(filename);
}
let client; let worker;
module.exports = { enqueue, createRevocationRepository, createRevocationWorker, validate,
  async status(clinicIds, models = require('../../models')) {
    if (!Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 1000 || clinicIds.some(id => !positive(String(id)))) fail('gbp_revocation_unavailable');
    const rows = await models.BusinessProfileBrokerRevocation.findAll({ where: { clinica_id: { [Op.in]: clinicIds } },
      attributes: ['state', [fn('COUNT', col('external_location_id')), 'total']], group: ['state'], raw: true });
    if (rows.some(r => !['pending', 'confirmed'].includes(r.state) || !Number.isSafeInteger(Number(r.total)) || Number(r.total) < 0)) fail('gbp_revocation_unavailable');
    const pending = Number(rows.find(r => r.state === 'pending')?.total || 0); const confirmed = Number(rows.find(r => r.state === 'confirmed')?.total || 0);
    return { status: pending ? 'pending' : confirmed ? 'confirmed' : 'none', pending_assets: pending, confirmed_assets: confirmed };
  }, async run() {
  if (process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_WORKER_ENABLED !== 'true') return { status: 'completed', skipped: true, reason: 'gbp_revocation_worker_disabled' };
  worker ||= createRevocationWorker({ repository: createRevocationRepository(require('../../models')), client: { execute(command, options) {
    client ||= createIntegrationsBrokerClient({ origin: process.env.INTEGRATIONS_BROKER_ORIGIN, audience: process.env.INTEGRATIONS_BROKER_AUDIENCE,
      keyId: process.env.GOOGLE_BUSINESS_PROFILE_BROKER_CONTROL_KEY_ID, privateKey: privateFile(process.env.GOOGLE_BUSINESS_PROFILE_BROKER_CONTROL_KEY_FILE),
      ca: privateFile(process.env.INTEGRATIONS_BROKER_CA_FILE), timeoutMs: 10000 }); return client.execute(command, options);
  } } });
  return worker.run();
} };
