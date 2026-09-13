'use strict';
const { Op } = require('sequelize');
const { createHash } = require('node:crypto');
const scope = require('./googleAdsBrokerScope.service');
const reader = require('./googleAdsBroker.service');
const discovery = require('./googlePropertyDiscovery.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
const bounded = rows => { if (!Array.isArray(rows) || rows.length > 1000) fail('broker_discovery_limit'); return rows; };
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createGoogleAdsDiscovery({ hasManaged, snapshot, broker, enabled = () => process.env.GOOGLE_ADS_BROKER_ENABLED === 'true', now = Date.now }) {
  let active = 0;
  const selections = new WeakMap();
  const registry = async fn => { try { return await fn(); } catch (error) {
    fail(['broker_binding_invalid', 'broker_discovery_limit', 'google_discovery_scope_forbidden'].includes(error?.code) ? error.code : 'broker_registry_unavailable');
  } };
  const managed = () => registry(hasManaged);
  const assertLegacyAllowed = async () => { if (await managed()) fail('google_oauth_legacy_closed'); };
  async function inventory({ clinicIds, connectionId, scopeKey, revalidate }, capture = false) {
    if (!Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 1000 || clinicIds.some(id => !scope.positive(id))
      || new Set(clinicIds).size !== clinicIds.length || !scope.positive(connectionId)
      || !/^(clinic|group):[1-9]\d{0,9}$/.test(scopeKey || '') || !scope.positive(scopeKey.split(':')[1])
      || scopeKey.startsWith('clinic:') && (clinicIds.length !== 1 || String(clinicIds[0]) !== scopeKey.split(':')[1])
      || typeof revalidate !== 'function') fail('broker_binding_invalid');
    clinicIds = clinicIds.slice();
    if (active >= 4) fail('broker_discovery_busy'); active++;
    try {
      if (!await managed()) return null;
      const deadline = now() + 60000;
      const check = async (options = {}) => {
        await revalidate(true, options);
        if (!enabled()) fail('broker_cohort_disabled');
        if (now() >= deadline) fail('broker_discovery_timeout');
      };
      const load = (transaction) => registry(() => snapshot({ clinicIds, connectionId, scopeKey, transaction }));
      await check(); const initial = await load(); await check();
      if (!initial || !Array.isArray(initial.bindings) || !Array.isArray(initial.mappings)) fail('broker_binding_invalid');
      const records = bounded(initial.bindings).map(scope.binding); const mappings = bounded(initial.mappings);
      if (!records.length) fail('broker_discovery_scope_unconfigured');
      if (new Set(records.map(r => r.mapping_id)).size !== records.length) fail('broker_binding_invalid');
      const choices = new Map();
      for (const row of records) {
        if (row.google_connection_id !== connectionId) fail('broker_binding_invalid');
        const mapping = mappings.find(r => Number(r.id) === row.mapping_id);
        // Keep tombstones in the captured snapshot but omit retired accounts
        // from the picker. Any surviving active alias still fails scope.prepare.
        if (row.state === 'blocked') {
          if (mapping && [true, 1].includes(mapping.isActive)) fail('broker_binding_invalid');
          continue;
        }
        if (!mapping || ![true, false, 0, 1].includes(mapping.isActive) || [true, 1].includes(mapping.isActive) !== (row.state === 'active')
          || mapping.broker_read_connection_ref !== row.connection_ref
          || mapping.broker_read_asset_ref !== row.asset_ref) fail('broker_binding_invalid');
        const owner = scope.identity(mapping);
        if (owner.googleConnectionId !== connectionId || owner.customerId !== row.customer_id || owner.scopeKey !== row.scope_key
          || owner.loginCustomerId !== row.login_customer_id) fail('broker_binding_invalid');
        // A group registry is the read authority for its clinic aliases. The
        // scope reader still checks every alias, shared use, grant and tombstone.
        const previous = choices.get(row.customer_id);
        if (!previous || row.scope_key.startsWith('group:')) choices.set(row.customer_id, { row, mapping });
      }
      if (!choices.size) fail('broker_discovery_scope_unconfigured');
      if (choices.size > 20) fail('broker_discovery_limit');
      const fingerprint = signature(initial); const captured = []; const accounts = []; let unavailableAccountCount = 0;
      for (const { mapping, row } of choices.values()) {
        await check(); const context = await broker.prepareDiscovery(mapping); if (!context) fail('broker_binding_invalid');
        const rows = await broker.readDiscovery(mapping, context, { timeoutMs: Math.max(1, Math.min(60000, deadline - now())), beforeExecute: check });
        await check();
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.customer?.id !== row.customer_id) fail('broker_response_invalid');
        const customer = rows[0].customer;
        if (['CANCELED', 'CLOSED'].includes(customer.status)) unavailableAccountCount++;
        else accounts.push({ customerId: customer.id, formattedCustomerId: `${customer.id.slice(0, 3)}-${customer.id.slice(3, 6)}-${customer.id.slice(6)}`,
          descriptiveName: customer.descriptiveName || null, currencyCode: customer.currencyCode, timeZone: customer.timeZone,
          accountStatus: customer.status, isManager: customer.manager, loginCustomerId: row.login_customer_id });
        captured.push({ mapping, context });
      }
      if (signature(await load()) !== fingerprint) fail('broker_binding_invalid');
      for (const { mapping, context } of captured) { await check(); await broker.assertDiscovery(mapping, context); }
      // Capture changes made during the last context check as well.
      if (signature(await load()) !== fingerprint) fail('broker_binding_invalid'); await check();
      accounts.sort((a, b) => a.customerId.localeCompare(b.customerId));
      const output = { accounts, unavailableAccountCount };
      if (Buffer.byteLength(JSON.stringify(output)) > 1048576) fail('broker_discovery_limit');
      if (!capture) return output;
      const selection = Object.freeze({});
      selections.set(selection, { check, load, fingerprint, captured,
        value: structuredClone({ clinicIds, connectionId, scopeKey, ...initial, ...output }) });
      return { selection, inventory: output };
    } finally { active--; }
  }
  return { assertLegacyAllowed, list: request => inventory(request), capture: request => inventory(request, true),
    async assertSelection(selection, { transaction } = {}) {
      const saved = selection && typeof selection === 'object' && selections.get(selection);
      if (!saved || !transaction?.LOCK?.UPDATE) fail('broker_binding_invalid');
      await saved.check({ transaction });
      if (signature(await saved.load(transaction)) !== saved.fingerprint) fail('broker_binding_invalid');
      for (const { mapping, context } of saved.captured) await broker.assertDiscovery(mapping, context, { transaction });
      if (signature(await saved.load(transaction)) !== saved.fingerprint) fail('broker_binding_invalid');
      await saved.check({ transaction });
      return structuredClone(saved.value);
    },
    releaseSelection(selection) { if (selection && typeof selection === 'object') selections.delete(selection); },
  };
}
function createGoogleAdsDiscoveryRepository(getModels) {
  return { async snapshot({ clinicIds, connectionId, scopeKey, transaction, metadata = false }) {
    const options = { raw: true, logging: false, limit: 1001, ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) };
    const m = getModels(); const group = scopeKey.startsWith('group:'); const ownerId = Number(scopeKey.split(':')[1]);
    const clinics = bounded(await m.Clinica.findAll({ ...options, attributes: ['id_clinica', 'grupoClinicaId', ...(metadata ? ['nombre_clinica', 'url_avatar'] : [])], order: [['id_clinica', 'ASC']],
      where: group ? { grupoClinicaId: ownerId } : { id_clinica: ownerId } }));
    if (clinics.length !== clinicIds.length || clinics.some(row => !clinicIds.includes(Number(row.id_clinica)))) fail('broker_binding_invalid');
    const groupId = group ? ownerId : clinics[0]?.grupoClinicaId;
    if (groupId != null && !scope.positive(groupId)) fail('broker_binding_invalid');
    const shared = bounded(await m.GroupAssetClinicAssignment.findAll({ ...options, attributes: ['id', 'grupoClinicaId', 'assetId', 'clinicaId'],
      order: [['id', 'ASC']], where: { assetType: 'google.ads_account', clinicaId: { [Op.in]: clinicIds } } }));
    if (shared.some(row => !scope.positive(row.assetId) || !scope.positive(row.clinicaId) || !clinicIds.includes(Number(row.clinicaId))
      || Number(row.grupoClinicaId) !== Number(groupId))) fail('google_discovery_scope_forbidden');
    const keys = [...clinicIds.map(id => 'clinic:' + id), ...(groupId != null ? ['group:' + Number(groupId)] : [])];
    const bindings = bounded(await m.GoogleAdsBrokerBinding.findAll({ ...options, attributes: scope.BINDING_FIELDS, order: [['customer_id', 'ASC'], ['mapping_id', 'ASC']],
      where: { google_connection_id: connectionId, [Op.or]: [{ scope_key: { [Op.in]: keys } },
        ...(shared.length ? [{ mapping_id: { [Op.in]: shared.map(row => row.assetId) } }] : [])] } }));
    const mappings = bindings.length ? bounded(await m.ClinicGoogleAdsAccount.findAll({ ...options, attributes: [...scope.MAPPING_FIELDS,
      ...(metadata ? ['descriptiveName', 'currencyCode', 'timeZone', 'accountStatus'] : [])], order: [['id', 'ASC']],
      where: { id: { [Op.in]: bindings.map(row => row.mapping_id) } } })) : [];
    return { clinics, shared, bindings, mappings };
  } };
}
const service = createGoogleAdsDiscovery({ broker: reader, ...createGoogleAdsDiscoveryRepository(() => require('../../models')),
  hasManaged: async () => { try { await discovery.assertLegacyAllowed(); return false; }
    catch (error) { if (error?.code === 'google_oauth_legacy_closed') return true; throw error; } } });
module.exports = { ...service, createGoogleAdsDiscovery, createGoogleAdsDiscoveryRepository, safe: discovery.safe, status: discovery.status };
