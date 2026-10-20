'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs'), vm = require('node:vm');
const D = require('sequelize');
const membership = { rol_clinica: 'personaldeclinica', subrol_clinica: 'Administrativos' };
const moduleStub = { exports: {} };
const models = {
  UsuarioClinica: { findOne: async ({ where }) => where.id_clinica === 72 ? membership : null },
  PatientDirectionProfile: { findOne: async () => null },
  Clinica: { findByPk: async () => ({ grupoClinicaId: 29 }) },
  AccessPolicyOverride: { findAll: async () => [] },
};
vm.runInNewContext(fs.readFileSync(require.resolve('../../lib/access-policy'), 'utf8'), {
  module: moduleStub, exports: moduleStub.exports,
  require: name => name === '../../models' ? models : name === 'sequelize' ? D
    : name === './role-helpers' ? { isGlobalAdmin: id => id === 1 }
      : require('../../../services/platform-audit/src/access-policy-contract'),
});
const policy = moduleStub.exports;
const source = fs.readFileSync(require.resolve('../../controllers/personal.controller'), 'utf8');
const start = source.indexOf('async function canEditBloqueos('), end = source.indexOf('\n\nfunction ', start);
const canEdit = vm.runInNewContext('(' + source.slice(start, end).trim() + ')');
const dependencies = {
  globalAdminCheck: id => id === 1,
  staffPivotCheck: async (id, cid) => [200, 201].includes(id) && cid === 72,
  ownerPivotCheck: async id => id === 201,
  teamManageCheck: (id, cid) => policy.canUserAccessFeature({ actorId: id, featureKey: 'team.manage', clinicId: cid }),
  selfScheduleCheck: (id, cid) => policy.canUserAccessFeature({ actorId: id, featureKey: 'team.schedule.self.manage', clinicId: cid }),
  adminClinicIdsLoader: async () => [], targetClinicIdsLoader: async () => [72],
};

test('administrative staff retains local appointment/team/room-block permissions without overrides', async () => {
  assert.equal(policy.roleCodeFromMembership(membership), 'admin_staff');
  for (const featureKey of ['team.view', 'team.manage', 'team.schedule.self.manage', 'appointments.manage', 'clinic.settings.edit']) {
    assert.equal(await policy.canUserAccessFeature({ actorId: 142, featureKey, clinicId: 72 }), true, featureKey);
    assert.equal(await policy.canUserAccessFeature({ actorId: 142, featureKey, clinicId: 73 }), false, featureKey);
  }
  assert.equal(await canEdit(142, 200, 72, dependencies), true);
  assert.equal(await canEdit(142, 200, null, dependencies), false);
  assert.equal(await canEdit(142, 200, 73, dependencies), false);
});

test('owner absences remain protected; ordinary reception permissions are not promoted to owner', async () => {
  assert.equal(await canEdit(142, 201, 72, dependencies), false);
  assert.equal(await canEdit(1, 201, 72, dependencies), true);
});
