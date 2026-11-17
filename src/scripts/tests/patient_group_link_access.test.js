'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const S = require('sequelize');
const file = require.resolve('../../lib/access-policy'), nativeRequire = createRequire(file);

function fixture() {
  let membership = { rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' };
  let director = false, overrides = [];
  const reads = [], optionsSeen = [];
  const models = {
    UsuarioClinica: { findOne: async options => {
      optionsSeen.push(options); const { where } = options;
      reads.push({ kind: 'membership', clinicId: where.id_clinica });
      assert(where[S.Op.or].some(item => item.estado_invitacion === 'aceptada'));
      return Number(where.id_clinica) === 200 ? membership : null;
    } },
    PatientDirectionProfile: { findOne: async options => { optionsSeen.push(options); return director && options.include[0].where.clinic_id === 200 ? { user_id: 9001 } : null; } },
    PatientDirectionSetting: {},
    Clinica: { findByPk: async (id, options) => { optionsSeen.push(options); return { id_clinica: Number(id), grupoClinicaId: 50 }; } },
    AccessPolicyOverride: { findAll: async options => { optionsSeen.push(options); return overrides.filter(row => row.feature_key === options.where.feature_key && row.role_code === options.where.role_code); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: name => name === '../../models' ? models : nativeRequire(name) }, { filename: file });
  return { api: module.exports, reads, optionsSeen, role(value) { membership = value; director = false; },
    asDirector() { membership = null; director = true; }, overrides(value) { overrides = value; } };
}
const roles = [
  ['propietario', { rol_clinica: 'propietario' }, true],
  ['reception', { rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' }, true],
  ['admin_staff', { rol_clinica: 'personaldeclinica', subrol_clinica: 'Administrativos' }, true],
  ['doctor', { rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores' }, false],
  ['assistant', { rol_clinica: 'personaldeclinica', subrol_clinica: 'Auxiliares y enfermeros' }, false],
  ['accountant', { rol_clinica: 'personaldeclinica', subrol_clinica: 'Gestoría' }, false],
  ['agencia', { rol_clinica: 'agencia' }, false],
  ['unknown', { rol_clinica: 'personaldeclinica', subrol_clinica: 'Otro rol' }, false],
];
for (const [role, membership, expected] of roles) test('patients.group.link default for ' + role, async () => {
  const f = fixture(); f.role(membership);
  assert.equal(f.api.defaultForFeature('patients.group.link', role), expected);
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200 }), expected);
  assert(f.reads.every(read => read.clinicId === 200), 'Authorization belongs only to the selected destination clinic');
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 100 }), false,
    'Destination membership does not imply source access');
});
test('patient director does not inherit the owner group-link capability', async () => {
  const f = fixture(); f.asDirector();
  assert.equal(f.api.defaultForFeature('patients.group.link', 'patient_director'), false);
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200 }), false);
  assert.equal(f.api.getAccessPolicyCatalog().defaults['patients.group.link'].patient_director, false);
});
for (const [role, membership] of roles.filter(row => row[2])) test('an explicit group-link DENY revokes ' + role + ' at the destination', async () => {
  const f = fixture(); f.role(membership);
  f.overrides([{ feature_key: 'patients.group.link', role_code: role, scope_type: 'clinic', scope_id: 200, effect: 'deny' }]);
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200 }), false);
});
test('group DENY applies and a different feature override cannot enable group linking', async () => {
  const f = fixture();
  f.overrides([{ feature_key: 'patients.group.link', role_code: 'reception', scope_type: 'group', scope_id: 50, effect: 'deny' }]);
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200 }), false);
  f.role({ rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores' });
  f.overrides([{ feature_key: 'patients.edit', role_code: 'doctor', scope_type: 'clinic', scope_id: 200, effect: 'allow' }]);
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200 }), false);
});
test('group-link feature participates in the shared allowlist, catalog and role-default contract', () => {
  const f = fixture(), catalog = f.api.getAccessPolicyCatalog();
  assert(f.api.ALLOWED_FEATURE_KEYS.has('patients.group.link'));
  assert.equal(catalog.features.filter(feature => feature.key === 'patients.group.link').length, 1);
  assert.deepEqual(Object.keys(catalog.defaults['patients.group.link']).sort(),
    ['propietario', 'agencia', 'doctor', 'assistant', 'reception', 'admin_staff', 'accountant', 'patient_director', 'unknown'].sort());
});
test('optional caller transaction reaches every ACL membership/director/group/override query and does not change legacy no-transaction calls', async () => {
  const f = fixture(), transaction = { owned: 'transaction' };
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200, transaction }), true);
  assert.equal(f.optionsSeen.length, 4); assert(f.optionsSeen.every(options => options.transaction === transaction));
  f.optionsSeen.length = 0;
  await f.api.assertUserCanAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200, transaction });
  assert.equal(f.optionsSeen.length, 4); assert(f.optionsSeen.every(options => options.transaction === transaction));
  f.optionsSeen.length = 0;
  assert.equal(await f.api.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.group.link', clinicId: 200 }), true);
  assert.equal(f.optionsSeen.length, 4); assert(f.optionsSeen.every(options => !Object.hasOwn(options, 'transaction')));
});
