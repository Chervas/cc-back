'use strict';
const { randomUUID } = require('node:crypto');
const { hash } = require('../../services/integrations-broker/src/google-business-profile-write-contract');
const { asset } = require('../../services/integrations-broker/src/google-business-profile-contract');
const fail = code => { throw Object.assign(Error(code), { code }); };
const familyFor = kind => ({ replyUpdate: 'reviews', replyDelete: 'reviews', photo: 'media', hours: 'details' })[kind];
const keyFor = (id, family) => {
  if (!/^[1-9]\d{0,29}$/.test(id) || !['reviews', 'media', 'details'].includes(family)) fail('business_profile_cache_invalid');
  // Global Google location, independent of connection, local alias and runtime
  // namespace. DEV is isolated by its database, staging/gateway share this row.
  return hash(`locations/${id}/cache/${family}`);
};
function identity(location) {
  const id = /^(?:accounts\/[1-9]\d{0,29}\/)?(?:locations\/)?([1-9]\d{0,29})$/.exec(String(location?.location_id))?.[1];
  if (!id || !Number.isSafeInteger(Number(location.id)) || Number(location.id) < 1 || !location.is_active) fail('broker_binding_invalid');
  return { id, mappingId: Number(location.id), clinicId: Number(location.clinica_id),
    connectionId: Number(location.google_connection_id), connectionRef: location.broker_read_connection_ref ?? null,
    assetRef: location.broker_read_asset_ref ?? null };
}
function createBusinessProfileCache({ models }) {
  const db = () => typeof models === 'function' ? models() : models;
  async function locked(key, transaction) {
    if (!transaction) fail('business_profile_cache_invalid');
    // The upsert acquires the same short InnoDB row lock for first and later
    // callers. No network request happens within this transaction.
    await db().sequelize.query(`INSERT INTO BusinessProfileCacheStates
      (resource_key, epoch, observation_ref, pending_count) VALUES (?, ?, NULL, 0)
      ON DUPLICATE KEY UPDATE resource_key=VALUES(resource_key)`,
    { replacements: [key, randomUUID()], transaction, logging: false });
    return db().BusinessProfileCacheState.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
  }
  async function mapping(captured, transaction, validate) {
    const row = await db().ClinicBusinessLocation.findByPk(captured.mappingId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
    if (!row || hash(identity(row)) !== hash(captured)) fail('broker_binding_invalid');
    if (validate) await validate(transaction);
  }
  return {
    async mutation(assetRef, kind, delta, transaction) {
      if (![1, -1].includes(delta)) fail('business_profile_cache_invalid');
      const row = await locked(keyFor(asset(assetRef).locationId, familyFor(kind)), transaction);
      const pending = Number(row.pending_count) + delta;
      if (!Number.isSafeInteger(pending) || pending < 0 || pending > 2147483647) fail('business_profile_cache_invalid');
      await row.update({ epoch: randomUUID(), pending_count: pending }, { transaction });
    },
    async begin(location, family, validate) {
      const captured = identity(location), key = keyFor(captured.id, family);
      return db().sequelize.transaction(async transaction => {
        await mapping(captured, transaction, validate);
        const row = await locked(key, transaction);
        if (row.pending_count) fail('business_profile_sync_mutation_pending');
        const observation = randomUUID();
        await row.update({ observation_ref: observation }, { transaction });
        return Object.freeze({ key, captured, epoch: row.epoch, observation, validate });
      });
    },
    async commit(ticket, apply) {
      return db().sequelize.transaction(async transaction => {
        await mapping(ticket.captured, transaction, ticket.validate);
        const row = await db().BusinessProfileCacheState.findByPk(ticket.key, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (!row || row.pending_count || row.epoch !== ticket.epoch || row.observation_ref !== ticket.observation) fail('business_profile_sync_superseded');
        return apply(transaction);
      });
    },
  };
}
module.exports = { createBusinessProfileCache, ...createBusinessProfileCache({ models: () => require('../../models') }) };
