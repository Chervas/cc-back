'use strict';
const { randomUUID } = require('node:crypto'); const { Op, fn, col } = require('sequelize');
const fs = require('node:fs'); const path = require('node:path');
const { KINDS, FIELDS, validate, fromBinding, fail, positive } = require('./googlePropertyRevocation.contract');
const { fromRevocation } = require('../../services/platform-audit/src/google-property-disconnect-event');
const { createRepository } = require('./platformAudit.repository'); const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const SAFE = new Set(['invalid_request', 'invalid_signature', 'scope_denied', 'operation_denied', 'connection_blocked', 'asset_revoked',
  'request_replayed', 'idempotency_conflict', 'outcome_unknown', 'rate_limited', 'audit_unavailable', 'broker_timeout', 'broker_unavailable',
  'broker_response_invalid', 'broker_configuration_invalid', 'google_property_revocation_unavailable']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_property_revocation_unavailable';
const validIds = ids => Array.isArray(ids) && ids.length <= 1000 && ids.every(id => positive(String(id))) && new Set(ids.map(Number)).size === ids.length;
const bounded = async (read, max) => { const rows = await read(); if (!Array.isArray(rows) || rows.length > max) fail(); return rows; };
function conflict() {
  throw Object.assign(Error('La propiedad también se utiliza fuera del ámbito de desconexión.'), { code: 'scope_disconnect_shared_asset_conflict', httpStatus: 409 });
}
async function assertScope({ models, transaction, clinicIds, bindings, mappings }) {
  const allowed = new Set(clinicIds.map(Number));
  for (const [kind, spec] of Object.entries(KINDS)) {
    const ids = [...new Set([...bindings[kind].map(r => Number(r.mapping_id)), ...(mappings[kind] || []).map(r => Number(r.id))])];
    if (!validIds(ids)) fail(); if (!ids.length) continue;
    const lock = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false, limit: 1001 };
    const shared = await bounded(() => models.GroupAssetClinicAssignment.findAll({ ...lock,
      where: { assetType: 'google.' + kind, assetId: { [Op.in]: ids } }, attributes: ['clinicaId'] }), 1000);
    if (shared.some(r => !positive(String(r.clinicaId)))) fail();
    if (shared.some(r => !allowed.has(Number(r.clinicaId)))) conflict();
    const groups = await bounded(() => models.GrupoClinica.findAll({ ...lock,
      where: { [spec.modeField]: 'group', [spec.primaryField]: { [Op.in]: ids } }, attributes: ['id_grupo'] }), 1000);
    if (groups.some(r => !positive(String(r.id_grupo)))) fail();
    if (groups.length) {
      const members = await bounded(() => models.Clinica.findAll({ ...lock,
        where: { grupoClinicaId: { [Op.in]: groups.map(r => Number(r.id_grupo)) } }, attributes: ['id_clinica'] }), 1000);
      if (members.some(r => !positive(String(r.id_clinica)))) fail();
      if (members.some(r => !allowed.has(Number(r.id_clinica)))) conflict();
    }
  }
}
async function enqueue({ models, transaction, connectionId, clinicIds, actorId, sessionRef = null, mappings = {},
  enabled = process.env.GOOGLE_PROPERTY_REVOCATION_ENABLED, now = new Date() }) {
  if (!transaction || !positive(String(connectionId)) || !validIds(clinicIds)) fail(); if (!clinicIds.length) return 0;
  const where = { google_connection_id: Number(connectionId), clinica_id: { [Op.in]: clinicIds.map(Number) } };
  const options = { where, transaction, lock: transaction.LOCK.UPDATE, limit: 201, raw: true, logging: false };
  const bindings = {}; let total = 0;
  for (const [kind, spec] of Object.entries(KINDS)) {
    bindings[kind] = await bounded(() => models[spec.model].findAll({ ...options, order: [['mapping_id', 'ASC']] }), 200);
    total += bindings[kind].length;
    if (new Set(bindings[kind].map(r => Number(r.mapping_id))).size !== bindings[kind].length) fail();
  }
  if (total > 200) fail();
  const previous = await bounded(() => models.GooglePropertyBrokerRevocation.findAll({ ...options, order: [['tuple_hash', 'ASC']] }), 200);
  const old = new Map(previous.map(row => [row.tuple_hash, validate(row)])); const intents = new Map(old);
  await assertScope({ models, transaction, clinicIds, bindings, mappings });
  // A managed mapping cannot be unlinked by treating a missing registry row as
  // legacy. Only its original binding or an already durable tombstone suffices.
  for (const [kind, spec] of Object.entries(KINDS)) {
    for (const mapping of mappings[kind] || []) {
      if (mapping.broker_read_connection_ref == null && mapping.broker_read_asset_ref == null) continue;
      if (bindings[kind].some(row => Number(row.mapping_id) === Number(mapping.id))) continue;
      const covered = [...old.values()].some(row => row.kind === kind && row.clinica_id === Number(mapping.clinicaId)
        && row.google_connection_id === Number(mapping.googleConnectionId) && row.resource === mapping[spec.mappingResourceField]
        && row.connection_ref === mapping.broker_read_connection_ref && row.asset_ref === mapping.broker_read_asset_ref);
      if (!covered) fail();
    }
  }
  if (!total && !previous.length) return 0;
  if (enabled !== 'true' || !positive(String(actorId))) fail();
  for (const [kind, spec] of Object.entries(KINDS)) {
    const rows = bindings[kind]; if (!rows.length) continue;
    const current = await bounded(() => models[spec.mappingModel].findAll({ transaction, lock: transaction.LOCK.UPDATE,
      where: { id: { [Op.in]: rows.map(r => Number(r.mapping_id)) } }, limit: 201, raw: true, logging: false,
      attributes: ['id', 'clinicaId', 'googleConnectionId', spec.mappingResourceField, 'broker_read_connection_ref', 'broker_read_asset_ref'] }), 200);
    for (const binding of rows) {
      const identity = fromBinding(kind, binding);
      if (identity.google_connection_id !== Number(connectionId) || !clinicIds.map(Number).includes(identity.clinica_id)) fail();
      const mapping = current.find(row => Number(row.id) === Number(binding.mapping_id));
      if (mapping && (Number(mapping.clinicaId) !== identity.clinica_id || Number(mapping.googleConnectionId) !== identity.google_connection_id
        || mapping[spec.mappingResourceField] !== identity.resource || mapping.broker_read_connection_ref !== identity.connection_ref
        || mapping.broker_read_asset_ref !== identity.asset_ref)) fail();
      const prior = intents.get(identity.tuple_hash);
      if (prior) { if (FIELDS.some(key => String(prior[key]) !== String(identity[key]))) fail(); continue; }
      intents.set(identity.tuple_hash, validate({ ...identity, request_id: randomUUID(), actor_user_id: Number(actorId),
        requested_at: now, next_attempt_at: now, state: 'pending' }));
    }
  }
  if (intents.size > 200) fail();
  const additions = [...intents.values()].filter(r => !old.has(r.tuple_hash));
  const audit = createRepository(models.PlatformAuditEvent);
  if (additions.length) {
    const health = await audit.health(now, { includeUnresolved: false, transaction });
    if (health.pending + additions.length > 10000 || health.oldestAgeSeconds >= 3600) fail();
    for (const row of additions) {
      await models.GooglePropertyBrokerRevocation.create(row, { transaction });
      await audit.append(fromRevocation(row, 'attempted', now, sessionRef), { transaction });
    }
  }
  for (const [kind, spec] of Object.entries(KINDS)) {
    if (bindings[kind].length) await models[spec.model].update({ state: 'blocked' }, {
      where: { ...where, mapping_id: { [Op.in]: bindings[kind].map(r => Number(r.mapping_id)) } }, transaction, logging: false });
  }
  return [...intents.values()].filter(r => r.state === 'pending').length;
}
function createRevocationRepository(models) {
  const model = models.GooglePropertyBrokerRevocation; const audit = createRepository(models.PlatformAuditEvent);
  return {
    claim(now) {
      return models.sequelize.transaction(async transaction => {
        const row = await model.findOne({ where: { state: 'pending', next_attempt_at: { [Op.lte]: now },
          [Op.or]: [{ lease_until: null }, { lease_until: { [Op.lt]: now } }] }, transaction, lock: transaction.LOCK.UPDATE,
          skipLocked: true, order: [['requested_at', 'ASC'], ['tuple_hash', 'ASC']], logging: false });
        if (!row) return null;
        await row.update({ lease_token: randomUUID(), lease_until: new Date(now.getTime() + 120000),
          attempts: Math.min(1000000000, Number(row.attempts) + 1) }, { transaction, logging: false });
        return row.get({ plain: true });
      });
    },
    confirm(claim, now) {
      return models.sequelize.transaction(async transaction => {
        const row = await model.findByPk(claim.tuple_hash, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (!row || row.state !== 'pending' || row.lease_token !== claim.lease_token || new Date(row.lease_until).getTime() <= now.getTime()) return false;
        if (['request_id', 'actor_user_id', ...FIELDS].some(k => String(row[k]) !== String(claim[k]))
          || new Date(row.requested_at).getTime() !== new Date(claim.requested_at).getTime()) fail();
        await audit.append(fromRevocation(validate(row.get({ plain: true })), 'completed', now), { transaction });
        await row.update({ state: 'confirmed', confirmed_at: now, lease_token: null, lease_until: null, last_error: null }, { transaction, logging: false });
        return true;
      });
    },
    async retry(row, code, now) {
      await model.update({ lease_token: null, lease_until: null, last_error: SAFE.has(code) ? code : 'google_property_revocation_unavailable',
        next_attempt_at: new Date(now.getTime() + Math.min(3600000, 1000 * 2 ** Math.min(Number(row.attempts), 12))) },
      { where: { tuple_hash: row.tuple_hash, state: 'pending', lease_token: row.lease_token }, logging: false });
    },
    async health() { return { pending: await model.count({ where: { state: 'pending' }, logging: false }) }; },
  };
}
function createRevocationWorker({ repository, clients, enabled = () => process.env.GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED === 'true', now = () => new Date() }) {
  let running = false;
  return { async run() {
    if (!enabled() || running) return { status: 'completed', skipped: true, reason: 'google_property_revocation_worker_disabled_or_busy' };
    running = true; let confirmed = 0; let failed = 0;
    try {
      const deadline = now().getTime() + 30000;
      for (let count = 0; count < 20 && now().getTime() < deadline; count++) {
        const row = await repository.claim(now()); if (!row) break;
        try {
          validate(row); const remaining = deadline - now().getTime(); if (remaining <= 0) throw Object.assign(Error('broker_timeout'), { code: 'broker_timeout' });
          const result = await clients[row.kind].execute({ requestId: row.request_id, operation: KINDS[row.kind].contract.REVOKE_OPERATION,
            tenantRef: `clinic:${row.clinica_id}`, connectionRef: row.connection_ref, assetRef: row.asset_ref, payload: {} }, { timeoutMs: Math.min(10000, remaining) });
          if (result?.requestId !== row.request_id || !result.data || Object.keys(result.data).join(',') !== 'revoked' || result.data.revoked !== true) {
            throw Object.assign(Error('broker_response_invalid'), { code: 'broker_response_invalid' });
          }
          if (!await repository.confirm(row, now())) fail(); confirmed++;
        } catch (error) { failed++; await repository.retry(row, safe(error), now()); }
      }
      return { status: failed ? 'failed' : 'completed', retryable: false, confirmed, failed, ...await repository.health() };
    } catch (error) { return { status: 'failed', retryable: false, confirmed, failed, error: safe(error) }; }
    finally { running = false; }
  } };
}
async function status(clinicIds, models = require('../../models')) {
  if (!validIds(clinicIds) || !clinicIds.length) fail();
  const rows = await models.GooglePropertyBrokerRevocation.findAll({ where: { clinica_id: { [Op.in]: clinicIds.map(Number) } },
    attributes: ['state', [fn('COUNT', col('tuple_hash')), 'total']], group: ['state'], raw: true, logging: false });
  if (!Array.isArray(rows) || rows.length > 2 || rows.some(r => !['pending', 'confirmed'].includes(r.state) || !Number.isSafeInteger(Number(r.total)) || Number(r.total) < 0)) fail();
  const pending = Number(rows.find(r => r.state === 'pending')?.total || 0); const confirmed = Number(rows.find(r => r.state === 'confirmed')?.total || 0);
  return { status: pending ? 'pending' : confirmed ? 'confirmed' : 'none', pending_assets: pending, confirmed_assets: confirmed };
}
function privateFile(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail();
    const stat = fs.statSync(filename); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail();
    return fs.readFileSync(filename);
  } catch { throw Object.assign(Error('broker_configuration_invalid'), { code: 'broker_configuration_invalid' }); }
}
const clients = Object.fromEntries(Object.keys(KINDS).map(kind => {
  let cached; const prefix = kind === 'search_console' ? 'GOOGLE_SEARCH_CONSOLE_BROKER_' : 'GOOGLE_ANALYTICS_BROKER_';
  return [kind, { execute(command, budget) {
    cached ||= createIntegrationsBrokerClient({ origin: process.env[prefix + 'ORIGIN'], audience: process.env[prefix + 'AUDIENCE'],
      keyId: process.env[prefix + 'CONTROL_KEY_ID'], privateKey: privateFile(process.env[prefix + 'CONTROL_KEY_FILE']),
      ca: privateFile(process.env[prefix + 'CA_FILE']), timeoutMs: 10000 });
    return cached.execute(command, budget);
  } }];
}));
let worker;
module.exports = { async enqueue(args) {
  try { return await enqueue(args); } catch (error) { if (error?.code === 'scope_disconnect_shared_asset_conflict') throw error; fail(); }
}, status, createRevocationRepository, createRevocationWorker, safe, async run() {
  if (process.env.GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED !== 'true') return { status: 'completed', skipped: true, reason: 'google_property_revocation_worker_disabled' };
  worker ||= createRevocationWorker({ repository: createRevocationRepository(require('../../models')), clients }); return worker.run();
} };
