'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const inventory = require('../../services/whatsappPermissionInventory.service');

test('permission inventory checks only exact broker-bound assets for the selected clinic', async () => {
  const calls = [];
  const broker = {
    bindingsForClinic(clinicId) {
      assert.equal(clinicId, 56);
      return [{ assetId: 374 }, { assetId: 398 }];
    },
    async permissionStatus(clinicId, assetId) {
      calls.push({ clinicId, assetId });
      return assetId === 398 ? 'disconnected' : 'connected';
    },
  };
  const result = await inventory.read({ clinicId: 56, phones: [{ id: 374 }, { id: 396 }, { id: 398 }], broker });
  assert.deepEqual([...result.entries()].sort((a, b) => a[0] - b[0]), [[374, 'connected'], [398, 'disconnected']]);
  assert.deepEqual(calls.sort((a, b) => a.assetId - b.assetId), [{ clinicId: 56, assetId: 374 }, { clinicId: 56, assetId: 398 }]);
});

test('permission inventory omits unavailable checks without trusting local health metadata', async () => {
  const broker = {
    bindingsForClinic: () => [{ assetId: 374 }, { assetId: 398 }],
    permissionStatus: async (_clinicId, assetId) => {
      if (assetId === 374) throw Object.assign(new Error('private detail'), { code: 'credential_revoked' });
      return 'unexpected';
    },
  };
  const result = await inventory.read({ clinicId: 56, phones: [
    { id: 374, health: { state: 'healthy' } },
    { id: 398, health: { state: 'disconnected' } },
  ], broker });
  assert.deepEqual([...result], []);
  assert.deepEqual([...await inventory.read({ clinicId: null, phones: [{ id: 374 }], broker })], []);
});
