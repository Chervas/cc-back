'use strict';
const { randomUUID, createHash } = require('node:crypto'); const { Op } = require('sequelize');
const scope = require('./googleAdsBrokerScope.service');
const { UUID } = require('../../services/platform-audit/src/event');
const { fromMapping } = require('../../services/platform-audit/src/google-ads-mapping-event');
const { createRepository } = require('./platformAudit.repository');
const discoveryService = require('./googleAdsDiscovery.service'); const brokerService = require('./googleAdsBroker.service');
const revocations = require('./googleAdsRevocation.service');
const fail = (code = 'google_ads_mapping_invalid') => { throw Object.assign(Error(code), { code }); };
const SAFE = new Set(['google_ads_mapping_invalid', 'google_ads_mapping_disabled', 'google_ads_mapping_unavailable',
  'google_ads_mapping_scope_conflict', 'google_ads_account_not_accessible', 'scope_disconnect_shared_asset_conflict',
  'broker_binding_invalid', 'broker_cohort_disabled', 'broker_discovery_timeout', 'scope_denied', 'asset_revoked',
  'google_discovery_scope_forbidden', 'google_discovery_session_required', 'google_ads_revocation_unavailable', 'audit_unavailable']);
function input(mappings) {
  if (!Array.isArray(mappings) || !mappings.length || mappings.length > 1000) fail();
  const seen = new Set();
  return mappings.map(row => {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).sort().join(',') !== 'clinicaId,customerId'
      || !scope.positive(row.clinicaId)) fail();
    let customerId; try { customerId = scope.customer(row.customerId); } catch { fail(); }
    const key = Number(row.clinicaId) + ':' + customerId; if (seen.has(key)) fail(); seen.add(key);
    return { clinicaId: Number(row.clinicaId), customerId };
  });
}
const dto = row => Object.fromEntries(['id', 'clinicaId', 'grupoClinicaId', 'assignmentScope', 'googleConnectionId', 'customerId',
  'descriptiveName', 'currencyCode', 'timeZone', 'accountStatus', 'managerCustomerId', 'loginCustomerId', 'isActive'].map(k => [k, row[k] ?? null]));
function createGoogleAdsMapping({ models, discovery = discoveryService, broker = brokerService, audit, revoke = revocations.enqueue,
  snapshot,
  enabled = () => process.env.GOOGLE_ADS_MAPPING_ENABLED === 'true', now = () => new Date() }) {
  const assertEnabled = () => { if (!enabled()) fail('google_ads_mapping_disabled'); };
  const getModels = () => typeof models === 'function' ? models() : models;
  const load = snapshot || discoveryService.createGoogleAdsDiscoveryRepository(getModels).snapshot;
  const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const validateScope = ({ clinicIds, connectionId, scopeKey }) => {
    if (!scope.positive(connectionId) || !Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 1000
      || clinicIds.some(id => !scope.positive(id)) || new Set(clinicIds).size !== clinicIds.length
      || !/^(clinic|group):[1-9]\d{0,9}$/.test(scopeKey || '') || !scope.positive(scopeKey.split(':')[1])
      || scopeKey.startsWith('clinic:') && (clinicIds.length !== 1 || scopeKey !== 'clinic:' + clinicIds[0])) fail();
  };
  return { assertEnabled, async list(request) {
    try {
      validateScope(request); if (typeof request.revalidate !== 'function') fail();
      const deadline = now().getTime() + 30000;
      const check = async () => { await request.revalidate(); if (now().getTime() >= deadline) fail('broker_discovery_timeout'); };
      const read = () => load({ clinicIds: request.clinicIds, connectionId: request.connectionId, scopeKey: request.scopeKey, metadata: true });
      await check(); const initial = await read(); const fingerprint = hash(initial); const choices = new Map(); const visible = [];
      if (!Array.isArray(initial.bindings) || initial.bindings.length > 1000 || !Array.isArray(initial.mappings) || initial.mappings.length > 1000) fail();
      for (const raw of initial.bindings) {
        const binding = scope.binding(raw); const row = initial.mappings.find(item => Number(item.id) === binding.mapping_id);
        if (binding.state !== 'active') { if (row && [true, 1].includes(row.isActive)) fail('broker_binding_invalid'); continue; }
        if (!row || ![true, 1].includes(row.isActive)) fail('broker_binding_invalid');
        visible.push({ row, binding });
        if (!choices.has(binding.customer_id) || binding.scope_key.startsWith('group:')) choices.set(binding.customer_id, row);
      }
      if (choices.size > 20) fail(); const contexts = [];
      for (const row of choices.values()) { await check(); const context = await broker.prepare(row);
        if (!context) fail('broker_binding_invalid'); contexts.push({ row, context }); }
      const groups = new Map();
      for (const { row, binding } of visible) {
        const displayId = request.scopeKey.startsWith('clinic:') ? Number(request.clinicIds[0])
          : request.clinicIds.includes(Number(row.clinicaId)) ? Number(row.clinicaId) : binding.tenant_clinic_id;
        if (!request.clinicIds.includes(displayId)) fail('google_ads_mapping_scope_conflict');
        if (!groups.has(displayId)) {
          const clinic = initial.clinics.find(row => Number(row.id_clinica) === displayId);
          groups.set(displayId, { clinicaId: displayId, clinicName: clinic?.nombre_clinica || null, clinicAvatar: clinic?.url_avatar || null, ads: [] });
        }
        const customerId = scope.customer(row.customerId);
        groups.get(displayId).ads.push({ id: Number(row.id), customerId,
          descriptiveName: row.descriptiveName || null, currencyCode: row.currencyCode || null, timeZone: row.timeZone || null,
          accountStatus: row.accountStatus || null, assignmentScope: row.assignmentScope, grupoClinicaId: row.grupoClinicaId,
          loginCustomerId: binding.login_customer_id, managerCustomerId: binding.login_customer_id,
          formattedCustomerId: `${customerId.slice(0,3)}-${customerId.slice(3,6)}-${customerId.slice(6)}`,
          managerLinkId: null, managerLinkStatus: null, invitationStatus: null, linkedAt: null });
      }
      if (hash(await read()) !== fingerprint) fail('broker_binding_invalid');
      for (const { row, context } of contexts) { await check(); await broker.assert(row, context); }
      if (hash(await read()) !== fingerprint) fail('broker_binding_invalid'); await check();
      const output = { success: true, mappings: [...groups.values()] };
      if (Buffer.byteLength(JSON.stringify(output)) > 1048576) fail(); return output;
    } catch (error) { fail(SAFE.has(error?.code) ? error.code : 'google_ads_mapping_unavailable'); }
  }, async remove(request) {
    try {
      validateScope(request);
      if (!scope.positive(request.mappingId) || !scope.positive(request.actorId) || !UUID.test(request.sessionRef) || typeof request.authorize !== 'function') fail();
      const m = getModels();
      return await m.sequelize.transaction(async transaction => {
        const check = async () => { if (await request.authorize({ transaction, actorId: Number(request.actorId), sessionRef: request.sessionRef,
          clinicIds: request.clinicIds.slice(), scopeKey: request.scopeKey }) !== true) fail('google_discovery_scope_forbidden'); };
        await check();
        const row = await m.ClinicGoogleAdsAccount.findByPk(Number(request.mappingId), { attributes: scope.MAPPING_FIELDS,
          transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false });
        if (!row || Number(row.googleConnectionId) !== request.connectionId || row.broker_read_connection_ref == null || row.broker_read_asset_ref == null) fail('broker_binding_invalid');
        const owner = scope.identity(row);
        if (owner.scopeKey !== request.scopeKey && !(request.scopeKey.startsWith('group:') && row.assignmentScope === 'clinic'
          && request.clinicIds.includes(Number(row.clinicaId)))) fail('google_ads_mapping_scope_conflict');
        const [type, id] = request.scopeKey.split(':');
        await revoke({ models: m, transaction, connectionId: request.connectionId, scope: { assignmentScope: type,
          clinicId: type === 'clinic' ? Number(id) : null, groupId: type === 'group' ? Number(id) : null },
        clinicIds: request.clinicIds, actorId: request.actorId, sessionRef: request.sessionRef, mappings: [row], customerIds: [owner.customerId], now: now() });
        await m.ClinicGoogleAdsAccount.update({ isActive: false }, { transaction, logging: false, where: { googleConnectionId: request.connectionId,
          customerId: { [Op.in]: [owner.customerId, `${owner.customerId.slice(0,3)}-${owner.customerId.slice(3,6)}-${owner.customerId.slice(6)}`] } } });
        await check(); return { success: true };
      });
    } catch (error) { fail(SAFE.has(error?.code) ? error.code : 'google_ads_mapping_unavailable'); }
  }, async save({ selection, mappings, replaceExisting = false, actorId, sessionRef, authorize }) {
    try {
      mappings = input(mappings);
      if (typeof replaceExisting !== 'boolean' || !scope.positive(actorId) || !UUID.test(sessionRef) || typeof authorize !== 'function') fail();
      assertEnabled();
      const m = typeof models === 'function' ? models() : models; const events = audit || createRepository(m.PlatformAuditEvent);
      const correlationId = randomUUID();
      return await m.sequelize.transaction(async transaction => {
        const saved = await discovery.assertSelection(selection, { transaction });
        if (mappings.some(row => !saved.clinicIds.includes(row.clinicaId))) fail('google_ads_mapping_scope_conflict');
        // The captured scope is the complete mutation owner. An inherited group
        // account cannot be changed from an individual clinic request.
        const selected = []; const ids = new Set(); const requestedCustomers = new Set(mappings.map(row => row.customerId));
        for (const request of mappings) {
          const account = saved.accounts.find(row => row.customerId === request.customerId);
          if (!account || account.isManager) fail('google_ads_account_not_accessible');
          const candidates = saved.bindings.filter(row => row.customer_id === request.customerId && row.scope_key === saved.scopeKey
            && (saved.scopeKey.startsWith('group:') || row.scope_key === 'clinic:' + request.clinicaId));
          if (candidates.length !== 1) fail('google_ads_mapping_scope_conflict');
          const binding = candidates[0]; const mapping = saved.mappings.find(row => Number(row.id) === binding.mapping_id);
          if (!mapping) fail();
          if (ids.has(binding.mapping_id)) {
            if (!saved.scopeKey.startsWith('group:')) fail();
            const previous = selected.find(item => item.binding.mapping_id === binding.mapping_id);
            if (request.clinicaId < previous.request.clinicaId) previous.request = request;
            continue;
          }
          ids.add(binding.mapping_id);
          selected.push({ mapping, binding, account, request });
        }
        const removed = replaceExisting ? saved.mappings.filter(row => [true, 1].includes(row.isActive)
          && !requestedCustomers.has(scope.customer(row.customerId))) : [];
        const removedCustomers = [...new Set(removed.map(row => scope.customer(row.customerId)))];
        if (removed.some(row => scope.scopeOf(row) !== saved.scopeKey
          && !(saved.scopeKey.startsWith('group:') && row.assignmentScope === 'clinic' && saved.clinicIds.includes(Number(row.clinicaId))))) {
          fail('google_ads_mapping_scope_conflict');
        }
        const check = async () => {
          if (!enabled()) fail('google_ads_mapping_disabled');
          if (await authorize({ transaction, actorId: Number(actorId), sessionRef, clinicIds: saved.clinicIds.slice(), scopeKey: saved.scopeKey }) !== true) {
            fail('google_discovery_scope_forbidden');
          }
        };
        await check();
        const health = await events.health(now(), { includeUnresolved: false, transaction });
        if (health.pending + selected.length > 10000 || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
        if (removedCustomers.length) {
          const [type, id] = saved.scopeKey.split(':');
          await revoke({ models: m, transaction, connectionId: saved.connectionId, scope: { assignmentScope: type,
            clinicId: type === 'clinic' ? Number(id) : null, groupId: type === 'group' ? Number(id) : null },
          clinicIds: saved.clinicIds, actorId, sessionRef, mappings: removed, customerIds: removedCustomers, now: now() });
          await m.ClinicGoogleAdsAccount.update({ isActive: false }, { transaction, logging: false,
            where: { googleConnectionId: saved.connectionId, isActive: true, customerId: { [Op.in]: removedCustomers.flatMap(id => [id, `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`]) } } });
        }
        const results = [];
        for (const { mapping, binding, account, request } of selected) {
          if ([...account.descriptiveName || ''].length > 256) fail('google_ads_mapping_invalid');
          const updates = { clinicaId: request.clinicaId, descriptiveName: account.descriptiveName,
            currencyCode: account.currencyCode, timeZone: account.timeZone, accountStatus: account.accountStatus, isActive: true };
          const [updated] = await m.ClinicGoogleAdsAccount.update(updates, { transaction, logging: false,
            where: { id: binding.mapping_id, googleConnectionId: saved.connectionId,
              broker_read_connection_ref: binding.connection_ref, broker_read_asset_ref: binding.asset_ref } });
          // MySQL may report zero changed rows on an idempotent re-selection.
          // Verify the exact desired row under the same lock before accepting it.
          if (updated !== 1) {
            const unchanged = updated === 0 && await m.ClinicGoogleAdsAccount.findOne({ attributes: ['id'], raw: true,
              transaction, lock: transaction.LOCK.UPDATE, logging: false, where: { id: binding.mapping_id, ...updates,
                googleConnectionId: saved.connectionId, broker_read_connection_ref: binding.connection_ref, broker_read_asset_ref: binding.asset_ref } });
            if (!unchanged) fail('broker_binding_invalid');
          }
          if (binding.state === 'staged') {
            const [activated] = await m.GoogleAdsBrokerBinding.update({ state: 'active' }, { transaction, logging: false,
              where: { customer_id: binding.customer_id, mapping_id: binding.mapping_id, state: 'staged' } });
            if (activated !== 1) fail('broker_binding_invalid');
          }
          const after = { ...mapping, ...updates };
          await events.append(fromMapping({ before: mapping, after, binding, clinicIds: saved.clinicIds,
            actorId, sessionRef, correlationId, now: now() }), { transaction });
          results.push(after);
        }
        await check();
        // Validate the new active ownership under the same SQL locks. Original
        // discovery contexts were checked before mutation and cannot be reused.
        for (const row of results) {
          const context = await broker.prepare(row, { transaction });
          if (!context) fail('broker_binding_invalid'); await broker.assert(row, context, { transaction });
        }
        await check();
        return { success: true, mapped: results.length, accounts: results.map(dto) };
      });
    } catch (error) { fail(SAFE.has(error?.code) ? error.code : 'google_ads_mapping_unavailable'); }
    finally { discovery.releaseSelection(selection); }
  } };
}
const singleton = createGoogleAdsMapping({ models: () => require('../../models') });
const safe = error => SAFE.has(error?.code) ? error.code : 'google_ads_mapping_unavailable';
const status = error => ['google_discovery_session_required'].includes(safe(error)) ? 401
  : ['scope_denied', 'google_discovery_scope_forbidden'].includes(safe(error)) ? 403
    : ['google_ads_mapping_scope_conflict', 'scope_disconnect_shared_asset_conflict', 'broker_binding_invalid', 'asset_revoked'].includes(safe(error)) ? 409
      : ['google_ads_mapping_invalid', 'google_ads_account_not_accessible'].includes(safe(error)) ? 400 : 503;
module.exports = { ...singleton, createGoogleAdsMapping, input, safe, status };
