'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assignmentAuthorization, hasClinicDelegation } = require('../../services/metaMarketingInstagramAssignmentAccess');

test('a delegation matches only the exact actor and one individual clinic', () => {
  const grant = '501@clinic:77';
  assert.equal(hasClinicDelegation({ actorId: 501, scopeKey: 'clinic:77' }, grant), true);
  for (const input of [{ actorId: 502, scopeKey: 'clinic:77' }, { actorId: 501, scopeKey: 'clinic:78' },
    { actorId: 501, scopeKey: 'group:77', destinationClinicId: 77 }, { actorId: '501', scopeKey: 'clinic:77' }]) {
    assert.equal(hasClinicDelegation(input, grant), false);
  }
  for (const invalid of ['', '*', '501@clinic:*', '501@clinic:077', '501@clinic:77,502@clinic:77']) {
    assert.equal(hasClinicDelegation({ actorId: 501, scopeKey: 'clinic:77' }, invalid), false);
  }
});

test('delegation needs active ordinary scope access and does not grant a sibling or group; owners keep their own scope', async t => {
  const key = 'META_MARKETING_INSTAGRAM_ASSIGNMENT_DELEGATE';
  const previous = process.env[key];
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  process.env[key] = '501@clinic:77';
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  let allowed = true, owners = [];
  const scope = { async authorize(input, tx) {
    assert.equal(tx, transaction);
    if (!allowed) throw Object.assign(Error('invalid session or membership'), {httpStatus:403});
    return {clinicIds: input.scopeKey === 'group:2' ? [77,78] : [Number(input.scopeKey.slice(7))],
      options: {transaction, raw:true, lock:'UPDATE'}};
  }};
  const run = assignmentAuthorization(scope, {async findAll(query) {
    assert.equal(query.transaction, transaction);
    assert.deepEqual(query.where.rol_clinica, ['propietario']);
    assert.equal(query.where.id_usuario, 501);
    return owners.map(id => ({id_clinica:id}));
  }});
  const check = scopeKey => run({actorId:501,scopeKey},transaction);
  await check('clinic:77');
  await assert.rejects(check('clinic:78'), {httpStatus:403});
  await assert.rejects(check('group:2'), {httpStatus:403});
  allowed = false;
  await assert.rejects(check('clinic:77'), {httpStatus:403});
  allowed = true;
  delete process.env[key];
  await assert.rejects(check('clinic:77'), {httpStatus:403});
  owners = [77];
  await check('clinic:77');
  await assert.rejects(check('group:2'), {httpStatus:403});
  owners = [77,78];
  await check('group:2');
});
