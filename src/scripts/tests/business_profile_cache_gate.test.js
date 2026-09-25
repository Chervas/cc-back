'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessProfileCache } = require('../../services/businessProfileCache.service');

test('read-only Business Profile sync does not require mutation coordination tables', async () => {
  const location = {
    id: 51,
    location_id: '456',
    clinica_id: 71,
    google_connection_id: 81,
    broker_read_connection_ref: null,
    broker_read_asset_ref: null,
    is_active: true,
  };
  let applied = 0;
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const cache = createBusinessProfileCache({
    enabled: () => false,
    models: {
      sequelize: { transaction: handler => handler(transaction) },
      ClinicBusinessLocation: { findByPk: async id => id === location.id ? location : null },
      BusinessProfileCacheState: new Proxy({}, { get: () => assert.fail('cache table must not be queried') }),
    },
  });

  const ticket = await cache.begin(location, 'reviews');
  assert.equal(ticket.bypass, true);
  const result = await cache.commit(ticket, async current => {
    assert.equal(current, transaction);
    applied += 1;
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(applied, 1);
  await assert.rejects(cache.mutation('gbp:123:456', 'replyUpdate', 1, transaction), {
    code: 'broker_cohort_disabled',
  });
});
