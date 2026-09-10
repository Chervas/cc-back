'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkspaceGroupAccountScope } = require('../../lib/campaignWorkspaceAccountScope');
const body = { workspace_group_id: 5, group_id: '5', assignment_scope: 'group' };
const resolve = overrides => resolveWorkspaceGroupAccountScope({ body, clinicIds: [1], userId: 7,
  findGroupClinics: async () => [1, 2], hasAccess: async () => true, ...overrides });

test('existing mapping calls keep their clinic assignment contract', async () => {
  let queried = false;
  assert.equal(await resolve({ body: { group_id: 5 }, findGroupClinics: async () => { queried = true; } }), null);
  assert.equal(queried, false);
});
test('new group assignment requires an explicit consistent whole-group scope', async () => {
  for (const invalid of [{ ...body, workspace_group_id: '5' }, { ...body, group_id: '6' }, { ...body, assignment_scope: 'clinic' }, { ...body, workspace_group_id: null }]) {
    await assert.rejects(resolve({ body: invalid }), error => error.httpStatus === 400);
  }
});
test('the anchor clinic must belong to the requested group', async () => {
  await assert.rejects(resolve({ clinicIds: [3] }), error => error.code === 'workspace_group_clinic_mismatch');
});
test('partial group permissions cannot promote a clinic account to the group', async () => {
  let checked;
  await assert.rejects(resolve({ hasAccess: async scope => { checked = scope; return false; } }), error => error.httpStatus === 403);
  assert.deepEqual(checked, { userId: 7, clinicIds: [1, 2], access: 'write' });
});
test('authorized group assignment includes all members for synchronization', async () => {
  assert.deepEqual(await resolve(), { assignmentScope: 'group', grupoClinicaId: 5, clinicIds: [1, 2] });
});
test('unknown groups fail without provider or account mutations', async () => {
  let authorized = false;
  await assert.rejects(resolve({ findGroupClinics: async () => [], hasAccess: async () => { authorized = true; } }), error => error.httpStatus === 404);
  assert.equal(authorized, false);
});
