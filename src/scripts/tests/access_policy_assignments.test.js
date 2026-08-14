#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const db = require('../../../models');
const controller = require('../../controllers/accessPolicy.controller');

const originals = {
  clinicFindAll: db.Clinica.findAll,
  clinicFindByPk: db.Clinica.findByPk,
  membershipFindAll: db.UsuarioClinica.findAll,
  userFindAll: db.Usuario.findAll,
  directorProfileFindAll: db.PatientDirectionProfile.findAll,
  directorSettingFindAll: db.PatientDirectionSetting.findAll,
};

async function run() {
  let responseBody = null;
  let responseStatus = 200;

  db.Clinica.findAll = async () => [{ id_clinica: 82, grupoClinicaId: 4 }];
  db.Clinica.findByPk = async () => ({
    id_clinica: 82,
    nombre_clinica: 'BS Medical',
    grupoClinicaId: 4,
  });
  db.UsuarioClinica.findAll = async () => [{
    id_usuario: 8,
    id_clinica: 82,
    rol_clinica: 'propietario',
    subrol_clinica: null,
    estado_invitacion: 'aceptada',
  }];
  db.PatientDirectionSetting.findAll = async () => [{
    clinic_id: 82,
    director_user_id: 4,
    is_enabled: false,
  }];
  db.PatientDirectionProfile.findAll = async () => [{ user_id: 4 }];
  db.Usuario.findAll = async () => [
    {
      id_usuario: 8,
      nombre: 'Mar',
      apellidos: 'Propietaria',
      email_usuario: 'owner@example.test',
      estado_cuenta: 'activo',
    },
    {
      id_usuario: 4,
      nombre: 'Ana',
      apellidos: 'Directora',
      email_usuario: 'director@example.test',
      estado_cuenta: 'activo',
    },
  ];

  const response = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  };

  try {
    await controller.getAssignments({
      userData: { userId: 1 },
      query: { scope_type: 'clinic', scope_id: '82' },
    }, response);

    assert.equal(responseStatus, 200);
    assert.equal(responseBody.total, 2);
    const directorRole = responseBody.roles.find((role) => role.role_code === 'patient_director');
    assert.ok(directorRole, 'patient director must be represented in scoped assignments');
    assert.equal(directorRole.count, 1);
    assert.equal(directorRole.users[0].name, 'Ana Directora');
    assert.equal(directorRole.users[0].clinic_id, 82);
    assert.equal(directorRole.users[0].assignment_source, 'patient_direction');
    assert.equal(directorRole.users[0].service_enabled, false);
  } finally {
    db.Clinica.findAll = originals.clinicFindAll;
    db.Clinica.findByPk = originals.clinicFindByPk;
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.Usuario.findAll = originals.userFindAll;
    db.PatientDirectionProfile.findAll = originals.directorProfileFindAll;
    db.PatientDirectionSetting.findAll = originals.directorSettingFindAll;
  }

  console.log('access policy assignments: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
