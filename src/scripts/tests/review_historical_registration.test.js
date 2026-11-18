'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registration = require('../../services/reviewRecipientRegistration.service');
function fixture(list) {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'), rollback: async () => calls.push('rollback'),
    query: async (sql, args) => {
      calls.push(sql);
      assert.match(sql, /^SELECT \* FROM MarketingPatientLists WHERE id=\? AND clinica_id=\?$/);
      assert.deepEqual(args, [965,1]);
      return [list ? [list] : []];
    },
  };
  const db = { sequelize: { connectionManager: {
    getConnection: async () => ({ promise: () => connection }),
    releaseConnection: async () => calls.push('release'),
  } } };
  return { db, calls, clinicId: 1, listId: 965, actorId: 1 };
}
const historical = { id:965,clinica_id:1,objective_id:'reactivate_patients',source:'imported_file',status:'draft' };
test('historical review import is checked read-only without invoking the incompatible mass-send registrar', async () => {
  const ctx = fixture(historical);
  const result = await registration.run(ctx);
  assert.equal(result.needsRegistration,false);
  assert.equal(result.source_kind,'historical_patients');
  assert.equal(result.sha256,null);
  assert.equal(result.clinicId,1);
  assert.deepEqual(ctx.calls,['begin','SELECT * FROM MarketingPatientLists WHERE id=? AND clinica_id=?','rollback','release']);
});
test('historical imports cannot enter the registration writer and foreign lists remain unavailable', async () => {
  const ctx = fixture(historical);
  await assert.rejects(registration.run({ ...ctx,apply:true,expectedSha256:'a'.repeat(64),sourceSystem:'unknown' }), e => e.status === 409);
  assert.equal(ctx.calls.some(s => /^(INSERT|UPDATE|DELETE)/.test(s)),false);
  const foreign = fixture(null);
  await assert.rejects(registration.run(foreign), e => e.status === 404);
  assert.equal(foreign.calls.at(-1),'release');
});
