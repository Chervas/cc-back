'use strict';
const legacy = require('./googleLegacyCredentials.service');
const brokerService = require('./googleAdsBroker.service');
const contexts = new WeakMap();
const fail = code => { throw Object.assign(Error(code), { code }); };
const scopes = value => String(value || '').split(/[\s,]+/).filter(Boolean).sort();
const marked = row => row.broker_read_connection_ref != null || row.broker_read_asset_ref != null;
const query = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), raw: true, logging: false });

// Caller retains its own workspace/reception ACL and mapping selection. This
// boundary selects transport without treating absence of a local token as a grant.
async function resolveGoogleAdsGrantTransport({ models, accounts, requiredScopes, transaction = null }) {
  if (!Array.isArray(accounts) || !accounts.length || !Array.isArray(requiredScopes)) fail('broker_binding_invalid');
  const ids = [...new Set(accounts.map(row => Number(row.googleConnectionId)))];
  if (ids.length !== 1 || !Number.isSafeInteger(ids[0]) || ids[0] < 1) fail('broker_binding_invalid');
  const metadata = await models.GoogleConnection.findByPk(ids[0], { ...query(transaction), attributes: ['id', 'googleUserId'] });
  if (!metadata || Number(metadata.id) !== ids[0] || !metadata.googleUserId) fail('google_connection_missing');
  const credentials = legacy.forModels(models);
  let managed = accounts.some(marked);
  if (!managed) {
    try { await credentials.assert(metadata); }
    catch (error) {
      if (error.code !== 'google_oauth_legacy_closed') throw error;
      managed = true; // Includes independent markers even if mapping refs were removed.
    }
  }
  if (!managed) {
    const connection = await credentials.load(ids[0], { includeScopes: true, expectedSubject: metadata.googleUserId });
    if (!connection?.accessToken || requiredScopes.some(scope => !scopes(connection.scopes).includes(scope))) fail('workspace_google_permissions_required');
    return { connection, brokerGrant: null };
  }
  const broker = brokerService.forModels(models), entries = [];
  for (const account of accounts) {
    const context = await broker.prepare(account, { transaction });
    if (!context) fail('broker_binding_invalid');
    const captured = await broker.assert(account, context, { transaction });
    if (captured.googleSubject !== metadata.googleUserId || captured.googleConnectionId !== ids[0]) fail('broker_binding_invalid');
    entries.push({ account, context });
  }
  const connection = await models.GoogleConnection.findByPk(ids[0], { ...query(transaction), attributes: ['id', 'googleUserId', 'scopes'] });
  if (!connection || connection.googleUserId !== metadata.googleUserId
    || requiredScopes.some(scope => !scopes(connection.scopes).includes(scope))) fail('workspace_google_permissions_required');
  const snapshot = Object.freeze({ id: Number(connection.id), googleUserId: connection.googleUserId, scopes: connection.scopes });
  const brokerGrant = Object.freeze({}); contexts.set(brokerGrant, { models, broker, entries, connection: snapshot, requiredScopes: [...requiredScopes] });
  await assertGoogleAdsGrantTransport(brokerGrant, { transaction });
  return { connection: snapshot, brokerGrant };
}

async function assertGoogleAdsGrantTransport(brokerGrant, { clinicId = null, transaction = null } = {}) {
  const saved = brokerGrant && typeof brokerGrant === 'object' && contexts.get(brokerGrant);
  if (!saved) fail('broker_binding_invalid');
  if (clinicId !== null && (!Number.isSafeInteger(clinicId) || clinicId < 1)) fail('scope_denied');
  const { broker, entries, models, connection } = saved; let selected;
  for (const entry of entries) {
    const current = await broker.assert(entry.account, entry.context, { transaction });
    if (current.googleSubject !== connection.googleUserId || current.googleConnectionId !== connection.id) fail('broker_binding_invalid');
    if (!selected && (clinicId === null || current.clinicIds.includes(clinicId))) selected = { ...entry, current };
  }
  if (!selected) fail('scope_denied');
  const fresh = await models.GoogleConnection.findByPk(connection.id, { ...query(transaction), attributes: ['id', 'googleUserId', 'scopes'] });
  if (!fresh || fresh.googleUserId !== connection.googleUserId || JSON.stringify(scopes(fresh.scopes)) !== JSON.stringify(scopes(connection.scopes))
    || saved.requiredScopes.some(scope => !scopes(fresh.scopes).includes(scope))) fail('broker_binding_invalid');
  return { deliveryMode: 'broker', account: selected.account, brokerContext: selected.context, broker,
    connection, assignment: null, customerId: selected.current.customerId, loginCustomerId: selected.current.loginCustomerId };
}
module.exports = { resolveGoogleAdsGrantTransport, assertGoogleAdsGrantTransport };
