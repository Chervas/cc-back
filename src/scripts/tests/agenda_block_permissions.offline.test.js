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

test('local team managers can block a proprietor agenda without gaining global or other-clinic authority', async () => {
  assert.equal(await canEdit(142, 201, 72, dependencies), true);
  assert.equal(await canEdit(142, 201, null, dependencies), false);
  assert.equal(await canEdit(142, 201, 73, dependencies), false);
  assert.equal(await canEdit(142, 201, 72, { ...dependencies, teamManageCheck: async () => false }), false);
  assert.equal(await canEdit(142, 201, 72, { ...dependencies, staffPivotCheck: async () => false }), false);
  assert.equal(await canEdit(1, 201, 72, dependencies), true);
});

test('native permission DTO and creation handler allow local owner agenda blocks but keep conflicts and scope denials', async () => {
  const native = {}; let created = [], conflict = null;
  const context = { exports: native, console, DEFAULT_TIMEZONE: 'Europe/Madrid',
    canEditBloqueos: (actor, target, clinic) => canEdit(actor, target, clinic, dependencies),
    canAccessTargetPersonal: async () => true, getAccessibleClinicIdsForUser: async () => [72], isAdmin: () => false,
    parseIntOrNull: value => Number(value) || null, getClinicTimezoneById: async () => 'Europe/Madrid',
    buildPersonalBlockRange: () => ({ start: new Date('2030-01-01T09:00:00Z'), end: new Date('2030-01-01T10:00:00Z') }),
    normalizeBloqueoTipo: () => 'ausencia', normalizePersonalBlockRecurrence: () => ({ recurrente: 'none', recurrente_hasta: null }),
    findPersonalBlockAppointmentConflict: async () => conflict,
    withPersonalAvailabilityMutation: async (_req, _target, work) => work({}),
    DoctorBloqueo: { create: async values => { created.push(values); return { id: 900001, ...values }; } },
    serializeBloqueo: value => value, availabilityResponse: (_req, value) => value,
  };
  for (const name of ['getPersonalBloqueosPermissions', 'createPersonalBloqueo']) {
    const from = source.indexOf('exports.' + name + ' ='), to = source.indexOf('\nexports.', from + 10);
    vm.runInNewContext(source.slice(from, to), context);
  }
  const call = async (handler, req) => { let status = 200, body;
    await handler(req, { status(code) { status = code; return this; }, json(value) { body = value; } });
    return { status, body };
  };
  const req = { userData: { userId: 142 }, params: { id: '201' }, body: { clinica_id: 72, tipo: 'ausencia' } };
  const permissions = await call(native.getPersonalBloqueosPermissions, req);
  assert.equal(permissions.body.can_write_bloqueos, true);
  assert.equal(permissions.body.can_create_global_bloqueo, false);
  assert.deepEqual(Array.from(permissions.body.allowed_clinic_ids_for_bloqueos), [72]);
  assert.equal((await call(native.createPersonalBloqueo, req)).status, 201);
  assert.equal(created.length, 1); assert.equal(created[0].doctor_id, 201); assert.equal(created[0].clinica_id, 72);
  assert.equal(created[0].creado_por, 142); assert.equal(created[0].aplica_a_todas_clinicas, false);
  conflict = { id_cita: 900099 };
  assert.equal((await call(native.createPersonalBloqueo, req)).status, 409);
  assert.equal((await call(native.createPersonalBloqueo, { ...req, body: { clinica_id: 73 } })).status, 403);
  assert.equal((await call(native.createPersonalBloqueo, { ...req, body: {} })).status, 403);
  assert.equal(created.length, 1);
});
