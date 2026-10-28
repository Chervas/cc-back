'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { professionalTitlePatch } = require('../../lib/professional-title');

function controllerHarness(file) {
  const state = { saves: 0, membershipWrites: 0, credentialGuards: 0, queriedTitle: false };
  const user = { id_usuario: 53, nombre: 'Celia', apellidos: '', tratamiento_profesional: 'Dra.',
    cargo_usuario: 'Medicina estética', email_usuario: 'fictitious@example.invalid', password_usuario: 'FICTITIOUS_NOT_A_CREDENTIAL', isProfesional: true };
  Object.assign(user, { save: async () => { state.saves++; }, setClinicas: async () => { state.membershipWrites++; },
    addClinica: async () => { state.membershipWrites++; } });
  const sql = require('sequelize');
  const db = { Usuario: { findByPk: async () => user }, UsuarioClinica: { findAll: async () => [], upsert: async () => { state.membershipWrites++; } },
    Sequelize: sql, sequelize: { escape: text => JSON.stringify(text) },
    DoctorClinica: { findAll: async options => {
      const included = options.include.find(row => row.as === 'doctor');
      state.queriedTitle = included.attributes.includes('tratamiento_profesional');
      return [{ id: 23, doctor_id: 53, clinica_id: 66, activo: true, recibe_citas: true, rol_en_clinica: 'Doctores', doctor: user,
        horarios: [{ id: 2, activo: true }], clinica: { id_clinica: 66, nombre_clinica: 'Fictitious', horarios: [{ id: 1, activo: true }] } }];
    } } };
  const filename = path.resolve(__dirname, '../../controllers/' + file), module = { exports: {} }, actualRequire = createRequire(filename);
  const credentialGuard = { guardCredentialMutation: async () => { state.credentialGuards++; return false; } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process: { env: {} },
    console: { error() {}, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    require(name) {
      if (name === '../../models') return db;
      if (name === '../services/authCredentialMutationGuard.service') return credentialGuard;
      if (name === 'express-async-handler') return fn => fn;
      if (['sequelize','crypto','bcryptjs','../lib/role-helpers','../lib/professional-title','../lib/flexible-agenda'].includes(name)) return actualRequire(name);
      // Unrelated integrations are inert: tests never bootstrap a provider, worker, DB or auth session.
      return {};
    },
  });
  const request = async (method, body = {}, actorId = 1, mode = 'admin') => {
    const req = { userData: { userId: actorId }, userDirectoryAccess: { mode }, params: { id: '53' },
      body, query: { agenda_context: 'true' }, authorizedDoctorClinicIds: [66] };
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await module.exports[method](req, res);
    return res;
  };
  return { state, user, request };
}

test('professional title patch preserves an omitted field and accepts only canonical titles or null', () => {
  assert.deepEqual(professionalTitlePatch({ nombre: 'Celia' }), {});
  for (const title of ['Dr.','Dra.',null]) assert.deepEqual(professionalTitlePatch({ tratamiento_profesional: title }), { tratamiento_profesional: title });
  for (const title of ['', 'Dr', 'DRA.', 'Dra. ', 'Doctor', 0, false, [], {}, undefined, 'Dra.\n']) {
    assert.throws(() => professionalTitlePatch({ tratamiento_profesional: title }), { code: 'professional_title_invalid', status: 400 });
  }
});

for (const [file, method] of [['user.controller.js','updateUser'], ['personal.controller.js','updatePersonalMember']]) {
  for (const title of ['Dr.','Dra.',null]) test(`${file}: saves canonical ${String(title)} without changing credential, role or memberships`, async () => {
    const h = controllerHarness(file), original = { ...h.user };
    const res = await h.request(method, { nombre: 'Celia sin prefijo', tratamiento_profesional: title });
    assert.equal(res.statusCode, 200); assert.equal(h.state.saves, 1); assert.equal(h.state.membershipWrites, 0);
    assert.equal(h.user.tratamiento_profesional, title); assert.equal(h.user.nombre, 'Celia sin prefijo');
    for (const key of ['id_usuario','apellidos','cargo_usuario','email_usuario','password_usuario','isProfesional']) assert.equal(h.user[key], original[key]);
    assert.equal(h.state.credentialGuards, 1);
  });
  test(`${file}: unrelated profile edit preserves an existing title`, async () => {
    const h = controllerHarness(file), res = await h.request(method, { cargo_usuario: 'Especialidad ficticia' });
    assert.equal(res.statusCode, 200); assert.equal(h.user.tratamiento_profesional, 'Dra.'); assert.equal(h.state.saves, 1);
  });
  test(`${file}: invalid title rejects before any profile or credential mutation`, async () => {
    const h = controllerHarness(file), res = await h.request(method, { nombre: 'Must not save', tratamiento_profesional: '<script>', email_usuario: 'changed@example.invalid', password_usuario: 'NOT_A_PASSWORD' });
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'professional_title_invalid');
    assert.equal(h.state.saves, 0); assert.equal(h.state.membershipWrites, 0); assert.equal(h.state.credentialGuards, 0);
    assert.equal(h.user.nombre, 'Celia'); assert.equal(h.user.tratamiento_profesional, 'Dra.'); assert.equal(h.user.email_usuario, 'fictitious@example.invalid');
  });
  test(`${file}: title cannot bypass the existing authorization boundary`, async () => {
    const h = controllerHarness(file), res = await h.request(method, { tratamiento_profesional: 'Dr.' }, 777, 'agency');
    assert.equal(res.statusCode, 403); assert.equal(h.state.saves, 0); assert.equal(h.user.tratamiento_profesional, 'Dra.');
  });
}

test('doctors list projects the title independently from the existing clinical role and name', async () => {
  const h = controllerHarness('doctores.controller.js'), res = await h.request('list');
  assert.equal(h.state.queriedTitle, true); assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1); assert.equal(res.body[0].tratamiento_profesional, 'Dra.');
  assert.equal(res.body[0].especialidad, 'Doctores'); assert.equal(res.body[0].id, '53'); assert.equal(res.body[0].nombre, 'Celia');
  assert.equal(h.state.saves, 0); assert.equal(h.state.membershipWrites, 0);
});
