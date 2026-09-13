'use strict';
const { randomUUID } = require('node:crypto'); const { Op } = require('sequelize');
const fs = require('node:fs'); const path = require('node:path');
const { ADS, IDENTITY_FIELDS, FIELDS, tupleHash, identity, validate, ids, storedIds, scopeKey, fail, positive } = require('./googleAdsRevocation.contract');
const { binding, customer, identity: mappingIdentity, BINDING_FIELDS, MAPPING_FIELDS } = require('./googleAdsBrokerScope.service');
const { fromRevocation } = require('../../services/platform-audit/src/google-ads-disconnect-event');
const { createRepository } = require('./platformAudit.repository'); const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const SAFE = new Set(['invalid_request', 'invalid_signature', 'scope_denied', 'operation_denied', 'connection_blocked', 'asset_revoked',
  'request_replayed', 'idempotency_conflict', 'outcome_unknown', 'rate_limited', 'audit_unavailable', 'broker_timeout', 'broker_unavailable',
  'broker_response_invalid', 'broker_configuration_invalid', 'google_ads_revocation_unavailable']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_ads_revocation_unavailable';
const bounded = rows => { if (!Array.isArray(rows) || rows.length > 1000) fail(); return rows; };
const marked = row => row.broker_read_connection_ref != null || row.broker_read_asset_ref != null;
const same = (a, b, fields = IDENTITY_FIELDS) => fields.every(k => String(a[k]) === String(b[k]));
const conflict = () => { throw Object.assign(Error('La cuenta Ads también se utiliza fuera del ámbito de desconexión.'),
  { code: 'scope_disconnect_shared_asset_conflict', httpStatus: 409 }); };
async function enqueue({ models, transaction, connectionId, scope, clinicIds, actorId, sessionRef = null, mappings = [],
  enabled = process.env.GOOGLE_ADS_REVOCATION_ENABLED, now = new Date() }) {
  if (!transaction || !positive(String(connectionId))) fail();
  const allowedIds = ids(clinicIds, true); const allowed = new Set(allowedIds);
  const requestedScope = scopeKey(`${scope.assignmentScope}:${scope.assignmentScope === 'group' ? scope.groupId : scope.clinicId}`);
  const lock = { transaction, lock: transaction.LOCK.UPDATE, limit: 1001, raw: true, logging: false };
  bounded(mappings);
  const requestedCustomers = [...new Set(mappings.flatMap(row => { try { return [customer(row.customerId)]; } catch { return []; } }))];
  const where = { [Op.or]: [{ google_connection_id: Number(connectionId) },
    ...(requestedCustomers.length ? [{ customer_id: { [Op.in]: requestedCustomers } }] : [])] };
  let records = bounded(await models.GoogleAdsBrokerBinding.findAll({ ...lock, where, attributes: BINDING_FIELDS,
    order: [['customer_id', 'ASC'], ['mapping_id', 'ASC']] })).map(binding);
  let previous = bounded(await models.GoogleAdsBrokerRevocation.findAll({ ...lock, where, order: [['tuple_hash', 'ASC']] })).map(validate);
  if (!records.length && !previous.length) { if (mappings.some(marked)) fail(); return 0; }
  const selected = mappings.map(row => ({ row, identity: mappingIdentity(row) }));
  const customers = [...new Set([...requestedCustomers, ...records.map(r => r.customer_id), ...previous.map(r => r.customer_id)])];
  if (customers.length > 1000) fail();
  // Include aliases and registries under another SQL connection, not just the
  // rows selected by the disconnect endpoint's local scope query.
  const customerWhere = { customer_id: { [Op.in]: customers } };
  records = bounded(await models.GoogleAdsBrokerBinding.findAll({ ...lock, where: customerWhere, attributes: BINDING_FIELDS,
    order: [['customer_id', 'ASC'], ['mapping_id', 'ASC']] })).map(binding);
  previous = bounded(await models.GoogleAdsBrokerRevocation.findAll({ ...lock, where: customerWhere, order: [['tuple_hash', 'ASC']] })).map(validate);
  if (new Set(records.map(r => r.customer_id + ':' + r.mapping_id)).size !== records.length
    || new Set(previous.map(r => r.tuple_hash)).size !== previous.length) fail();
  const mappingIds = ids([...selected.map(r => r.identity.id), ...records.map(r => r.mapping_id), ...previous.flatMap(r => storedIds(r.mapping_ids))], true);
  const aliases = customers.flatMap(id => [id, `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`]);
  const current = bounded(await models.ClinicGoogleAdsAccount.findAll({ ...lock, attributes: MAPPING_FIELDS, order: [['id', 'ASC']],
    where: { [Op.or]: [{ customerId: { [Op.in]: aliases } }, ...(mappingIds.length ? [{ id: { [Op.in]: mappingIds } }] : [])] } }));
  if (current.some(row => ![true, false, 0, 1].includes(row.isActive))) fail();
  const active = current.filter(row => [true, 1].includes(row.isActive));
  const allIds = ids([...mappingIds, ...current.map(r => r.id)], true);
  const shared = allIds.length ? bounded(await models.GroupAssetClinicAssignment.findAll({ ...lock,
    attributes: ['assetId', 'clinicaId'], order: [['id', 'ASC']],
    where: { assetType: 'google.ads_account', assetId: { [Op.in]: allIds } } })) : [];
  if (shared.some(r => !positive(String(r.clinicaId)) || !allIds.includes(Number(r.assetId)))) fail();
  const scopes = [...records.map(r => r.scope_key), ...previous.map(r => r.scope_key), ...active.map(r => mappingIdentity(r).scopeKey)];
  const groupIds = ids([...scopes, requestedScope].filter(k => k.startsWith('group:')).map(k => k.split(':')[1]), true);
  const members = groupIds.length ? bounded(await models.Clinica.findAll({ ...lock, attributes: ['id_clinica', 'grupoClinicaId'],
    order: [['id_clinica', 'ASC']], where: { grupoClinicaId: { [Op.in]: groupIds } } })) : [];
  if (members.some(r => !positive(String(r.id_clinica)) || !groupIds.includes(Number(r.grupoClinicaId)))) fail();
  const ownerIds = key => key.startsWith('clinic:') ? [Number(key.split(':')[1])]
    : members.filter(r => Number(r.grupoClinicaId) === Number(key.split(':')[1])).map(r => Number(r.id_clinica));
  const old = new Map(previous.map(r => [r.tuple_hash, r])); const tuples = new Map(previous.map(r => [r.tuple_hash, identity(r)]));
  for (const record of records) {
    const value = identity({ ...record, tuple_hash: tupleHash(record) }); const existing = tuples.get(value.tuple_hash);
    if (existing && !same(existing, value)) fail(); tuples.set(value.tuple_hash, value);
    const mapping = current.find(r => Number(r.id) === record.mapping_id);
    if (mapping) {
      const owner = mappingIdentity(mapping);
      if (owner.customerId !== record.customer_id || owner.googleConnectionId !== record.google_connection_id
        || owner.scopeKey !== record.scope_key || owner.loginCustomerId !== record.login_customer_id
        || mapping.broker_read_connection_ref !== record.connection_ref || mapping.broker_read_asset_ref !== record.asset_ref) fail();
    }
  }
  // Marked mappings with a missing binding require their own durable history.
  for (const { row, identity: owner } of selected) {
    if (!marked(row) || records.some(r => r.mapping_id === owner.id && r.customer_id === owner.customerId)) continue;
    if (!previous.some(r => storedIds(r.mapping_ids).includes(owner.id) && r.customer_id === owner.customerId
      && Number(r.google_connection_id) === owner.googleConnectionId && r.login_customer_id === owner.loginCustomerId
      && r.connection_ref === row.broker_read_connection_ref && r.asset_ref === row.broker_read_asset_ref)) fail();
  }
  const intents = []; const blocked = [];
  for (const value of tuples.values()) {
    const related = records.filter(r => r.customer_id === value.customer_id);
    const histories = previous.filter(r => r.customer_id === value.customer_id);
    const live = active.filter(r => mappingIdentity(r).customerId === value.customer_id);
    const accountIds = ids([...related.map(r => r.mapping_id), ...histories.flatMap(r => storedIds(r.mapping_ids)), ...live.map(r => r.id)], true);
    const owners = [...related.map(r => r.scope_key), ...histories.map(r => r.scope_key), ...live.map(r => mappingIdentity(r).scopeKey)];
    const affected = ids([value.tenant_clinic_id, ...owners.flatMap(ownerIds), ...histories.flatMap(r => storedIds(r.clinic_ids)),
      ...shared.filter(r => accountIds.includes(Number(r.assetId))).map(r => r.clinicaId)]);
    if (!affected.some(id => allowed.has(id)) && !owners.includes(requestedScope)) continue;
    if (affected.some(id => !allowed.has(id)) || owners.some(k => k.startsWith('group:') && k !== requestedScope)) conflict();
    if (requestedScope.startsWith('group:') && affected.some(id => !ownerIds(requestedScope).includes(id))) conflict();
    if (value.google_connection_id !== Number(connectionId) || related.some(r => !same(identity({ ...r, tuple_hash: tupleHash(r) }), value))) fail();
    for (const row of live) {
      const owner = mappingIdentity(row);
      if (owner.googleConnectionId !== value.google_connection_id || owner.loginCustomerId !== value.login_customer_id
        || row.broker_read_connection_ref !== value.connection_ref || row.broker_read_asset_ref !== value.asset_ref
        || !related.some(r => r.mapping_id === owner.id) && !histories.some(r => storedIds(r.mapping_ids).includes(owner.id))) fail();
    }
    const prior = old.get(value.tuple_hash);
    if (prior && (affected.some(id => !storedIds(prior.clinic_ids).includes(id)) || !same(prior, value))) fail();
    const intent = prior || validate({ ...value, scope_key: requestedScope, clinic_ids: JSON.stringify(affected), mapping_ids: JSON.stringify(accountIds),
      request_id: randomUUID(), actor_user_id: Number(actorId), requested_at: now, next_attempt_at: now, state: 'pending' });
    intents.push(intent); blocked.push(...related);
  }
  if (!intents.length) return 0;
  if (intents.length > 200 || enabled !== 'true' || !positive(String(actorId))) fail();
  const additions = intents.filter(row => !old.has(row.tuple_hash)); const audit = createRepository(models.PlatformAuditEvent);
  if (additions.length) {
    const health = await audit.health(now, { includeUnresolved: false, transaction });
    if (health.pending + additions.length > 10000 || health.oldestAgeSeconds >= 3600) fail();
    for (const row of additions) {
      await models.GoogleAdsBrokerRevocation.create(row, { transaction });
      await audit.append(fromRevocation(row, 'attempted', now, sessionRef), { transaction });
    }
  }
  for (const row of blocked) await models.GoogleAdsBrokerBinding.update({ state: 'blocked' }, {
    where: { customer_id: row.customer_id, mapping_id: row.mapping_id }, transaction, logging: false });
  return intents.filter(row => row.state === 'pending').length;
}
function createRevocationRepository(models) {
  const model = models.GoogleAdsBrokerRevocation; const audit = createRepository(models.PlatformAuditEvent);
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
      await model.update({ lease_token: null, lease_until: null, last_error: SAFE.has(code) ? code : 'google_ads_revocation_unavailable',
        next_attempt_at: new Date(now.getTime() + Math.min(3600000, 1000 * 2 ** Math.min(Number(row.attempts), 12))) },
      { where: { tuple_hash: row.tuple_hash, state: 'pending', lease_token: row.lease_token }, logging: false });
    },
    async health() { return { pending: await model.count({ where: { state: 'pending' }, logging: false }) }; },
  };
}
function createRevocationWorker({ repository, client, enabled = () => process.env.GOOGLE_ADS_REVOCATION_WORKER_ENABLED === 'true', now = () => new Date() }) {
  let running = false;
  return { async run() {
    if (!enabled() || running) return { status: 'completed', skipped: true, reason: 'google_ads_revocation_worker_disabled_or_busy' };
    running = true; let confirmed = 0; let failed = 0;
    try {
      const deadline = now().getTime() + 30000;
      for (let count = 0; count < 20 && now().getTime() < deadline; count++) {
        const row = await repository.claim(now()); if (!row) break;
        try {
          validate(row); const remaining = deadline - now().getTime(); if (remaining <= 0) throw Object.assign(Error('broker_timeout'), { code: 'broker_timeout' });
          const result = await client.execute({ requestId: row.request_id, operation: ADS.REVOKE_OPERATION,
            tenantRef: `clinic:${row.tenant_clinic_id}`, connectionRef: row.connection_ref, assetRef: row.asset_ref, payload: {} }, { timeoutMs: Math.min(10000, remaining) });
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
  const allowed = new Set(ids(clinicIds));
  const rows = bounded(await models.GoogleAdsBrokerRevocation.findAll({ where: { tenant_clinic_id: { [Op.in]: [...allowed] } },
    attributes: ['state', 'clinic_ids'], raw: true, logging: false, limit: 1001 }));
  const counts = { pending: 0, confirmed: 0 };
  for (const row of rows) {
    if (!['pending', 'confirmed'].includes(row.state)) fail();
    if (storedIds(row.clinic_ids).every(id => allowed.has(id))) counts[row.state]++;
  }
  return { status: counts.pending ? 'pending' : counts.confirmed ? 'confirmed' : 'none', pending_assets: counts.pending, confirmed_assets: counts.confirmed };
}
function privateFile(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) fail();
    const stat = fs.statSync(filename); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) fail();
    return fs.readFileSync(filename);
  } catch { throw Object.assign(Error('broker_configuration_invalid'), { code: 'broker_configuration_invalid' }); }
}
let cachedClient;
const client = { execute(command, budget) {
  const prefix = 'GOOGLE_ADS_BROKER_';
  cachedClient ||= createIntegrationsBrokerClient({ origin: process.env[prefix + 'ORIGIN'], audience: process.env[prefix + 'AUDIENCE'],
    keyId: process.env[prefix + 'CONTROL_KEY_ID'], privateKey: privateFile(process.env[prefix + 'CONTROL_KEY_FILE']),
    ca: privateFile(process.env[prefix + 'CA_FILE']), timeoutMs: 10000 });
  return cachedClient.execute(command, budget);
} };
let worker;
module.exports = { async enqueue(args) {
  try { return await enqueue(args); } catch (error) { if (error?.code === 'scope_disconnect_shared_asset_conflict') throw error; fail(); }
}, status, createRevocationRepository, createRevocationWorker, safe, async run() {
  if (process.env.GOOGLE_ADS_REVOCATION_WORKER_ENABLED !== 'true') return { status: 'completed', skipped: true, reason: 'google_ads_revocation_worker_disabled' };
  worker ||= createRevocationWorker({ repository: createRevocationRepository(require('../../models')), client }); return worker.run();
} };
