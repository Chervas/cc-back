#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const accessPolicy = require('../../lib/access-policy');
const personalController = require('../../controllers/personal.controller');
const intakeController = require('../../controllers/intake.controller');
const pacienteController = require('../../controllers/paciente.controller');
const { queues } = require('../../services/queue.service');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

async function testPersonalSelfPermissions() {
  const {
    canEditBloqueos,
    canEditHorarios,
    canManageOwnScheduleInClinic,
  } = personalController.__personalSecurityContract;

  assert.equal(accessPolicy.defaultForFeature('team.schedule.self.manage', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('team.schedule.self.manage', 'unknown'), false);
  for (const roleCode of ['propietario', 'doctor', 'assistant', 'reception', 'admin_staff']) {
    assert.equal(accessPolicy.defaultForFeature('team.schedule.self.manage', roleCode), true);
  }

  let observedFeature = null;
  assert.equal(await canManageOwnScheduleInClinic(9100, 56, {
    staffPivotCheck: async () => true,
    featureCheck: async ({ featureKey }) => {
      observedFeature = featureKey;
      return false;
    },
  }), false, 'a staff pivot alone must not authorize the agency self exception');
  assert.equal(observedFeature, 'team.schedule.self.manage');

  assert.equal(await canEditHorarios(9100, 9100, 56, {
    globalAdminCheck: () => false,
    selfScheduleCheck: async () => false,
  }), false, 'agency cannot edit its own schedule through /personal/me');
  assert.equal(await canEditHorarios(9200, 9200, 56, {
    globalAdminCheck: () => false,
    selfScheduleCheck: async () => true,
  }), true, 'an explicitly allowed clinician retains self schedule management');

  const selfBlockDependencies = {
    globalAdminCheck: () => false,
    staffPivotCheck: async () => true,
    ownerPivotCheck: async () => false,
    teamManageCheck: async () => false,
    adminClinicIdsLoader: async () => [],
    targetClinicIdsLoader: async () => [56],
  };
  assert.equal(await canEditBloqueos(9100, 9100, 56, {
    ...selfBlockDependencies,
    selfScheduleCheck: async () => false,
  }), false, 'agency cannot edit a clinic-specific self absence');
  assert.equal(await canEditBloqueos(9100, 9100, null, {
    ...selfBlockDependencies,
    selfScheduleCheck: async () => false,
  }), false, 'agency cannot create a global self absence');
  assert.equal(await canEditBloqueos(9200, 9200, 56, {
    ...selfBlockDependencies,
    selfScheduleCheck: async () => true,
  }), true, 'explicitly allowed staff retain clinic-specific self absences');
  assert.equal(await canEditBloqueos(9200, 9200, null, {
    ...selfBlockDependencies,
    selfScheduleCheck: async () => true,
  }), true, 'explicitly allowed staff retain global self absences across their clinics');

  const personalSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/personal.controller.js'),
    'utf8',
  );
  const currentScheduleBlock = personalSource.slice(
    personalSource.indexOf('exports.getScheduleForCurrent'),
    personalSource.indexOf('exports.getScheduleForPersonal'),
  );
  assert.match(currentScheduleBlock, /canAccessTargetPersonal\(actorId, actorId, null\)/,
    'the /personal/me schedule read path must not retain an unconditional self bypass');
  assert.match(
    personalSource,
    /Number\(actorId\) === Number\(targetUserId\)[\s\S]{0,300}featureKey: 'team\.view'/,
    'self reads must consume explicit team.view instead of trusting STAFF_ROLES',
  );
}

async function testLeadAndPatientScopes() {
  const originals = {
    clinicFindAll: db.Clinica.findAll,
    clinicFindByPk: db.Clinica.findByPk,
    membershipFindAll: db.UsuarioClinica.findAll,
    membershipFindOne: db.UsuarioClinica.findOne,
    overrideFindAll: db.AccessPolicyOverride.findAll,
    patientFindOne: db.Paciente.findOne,
    appointmentFindOne: db.CitaPaciente.findOne,
  };

  const membershipFor = (actorId, clinicId) => {
    const id = Number(actorId);
    const cid = Number(clinicId);
    if (id === 9100 && cid === 56) return { rol_clinica: 'agencia', subrol_clinica: null };
    if (id === 9101 && [56, 57].includes(cid)) return { rol_clinica: 'agencia', subrol_clinica: null };
    if (id === 9200 && cid === 56) return { rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores' };
    return null;
  };

  db.Clinica.findAll = async ({ where } = {}) => {
    if (Number(where?.grupoClinicaId) === 5) return [{ id_clinica: 56 }, { id_clinica: 57 }];
    if (where?.id_clinica) return [{ grupoClinicaId: 5 }];
    return [{ id_clinica: 56 }, { id_clinica: 57 }];
  };
  db.Clinica.findByPk = async (clinicId) => ({ id_clinica: Number(clinicId), grupoClinicaId: 5 });
  db.UsuarioClinica.findAll = async ({ where }) => {
    const actorId = Number(where.id_usuario);
    const requested = where.id_clinica?.[db.Sequelize.Op.in] || [56, 57];
    return requested
      .filter((clinicId) => membershipFor(actorId, clinicId))
      .map((clinicId) => ({
        id_clinica: clinicId,
        ...membershipFor(actorId, clinicId),
      }));
  };
  db.UsuarioClinica.findOne = async ({ where }) => membershipFor(where.id_usuario, where.id_clinica);
  db.AccessPolicyOverride.findAll = async () => [];
  db.Paciente.findOne = async () => ({
    id_paciente: 42,
    public_id: 'pat_acl_contract',
    clinica_id: 56,
    nombre: 'Nombre real',
    apellidos: 'Apellidos reales',
    email: 'patient@example.com',
    clinica: { id_clinica: 56, nombre_clinica: 'Clínica 56' },
    clinicasVinculadas: [],
    relaciones: [],
    tutorDe: [],
  });
  let appointmentReads = 0;
  db.CitaPaciente.findOne = async () => {
    appointmentReads += 1;
    return null;
  };

  try {
    const { canAccessTargetPersonal } = personalController.__personalSecurityContract;
    assert.equal(await canAccessTargetPersonal(9100, 9100, null), false,
      'a marketing-only agency cannot read its own /personal/me schedule');
    assert.equal(await canAccessTargetPersonal(9200, 9200, null), true,
      'clinical staff retain their own /personal/me schedule read');

    const {
      ensureLeadScopeAccess,
      resolveLeadScopeFilter,
    } = intakeController.__leadPrivacyContract;

    const partialScope = await resolveLeadScopeFilter({ groupId: 5 }, 9100);
    assert.deepEqual(partialScope, { clinicIds: [56], groupIds: [] },
      'partial agency coverage must not include unassigned group-only leads');
    const fullScope = await resolveLeadScopeFilter({ groupId: 5 }, 9101);
    assert.deepEqual(fullScope, { clinicIds: [56, 57], groupIds: [5] },
      'full explicit coverage may include group-only leads');

    let res = responseRecorder();
    assert.equal(await ensureLeadScopeAccess(
      { userData: { userId: 9100 } },
      res,
      { clinica_id: null, grupo_clinica_id: 5 },
    ), false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'lead_scope_forbidden');

    res = responseRecorder();
    assert.equal(await ensureLeadScopeAccess(
      { userData: { userId: 9101 } },
      res,
      { clinica_id: null, grupo_clinica_id: 5 },
    ), true);

    res = responseRecorder();
    await pacienteController.getPacienteById({
      userData: { userId: 9100 },
      params: { id: '42' },
    }, res);
    assert.equal(res.statusCode, 403, 'agency must not open a patient detail');
    assert.equal(res.body.error, 'patient_detail_forbidden');
    assert.equal(appointmentReads, 0, 'forbidden detail must stop before appointment enrichment');

    res = responseRecorder();
    await pacienteController.getPacienteById({
      userData: { userId: 9200 },
      params: { id: '42' },
    }, res);
    assert.equal(res.statusCode, 200, 'clinical staff with sensitive access retain patient detail');
    assert.equal(res.body.nombre, 'Nombre real');
    assert.equal(appointmentReads, 2);
  } finally {
    db.Clinica.findAll = originals.clinicFindAll;
    db.Clinica.findByPk = originals.clinicFindByPk;
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.UsuarioClinica.findOne = originals.membershipFindOne;
    db.AccessPolicyOverride.findAll = originals.overrideFindAll;
    db.Paciente.findOne = originals.patientFindOne;
    db.CitaPaciente.findOne = originals.appointmentFindOne;
  }
}

async function main() {
  await testPersonalSelfPermissions();
  await testLeadAndPatientScopes();
  console.log('agency operational scope boundaries: ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([
      db.sequelize.close(),
      ...Object.values(queues).map((queue) => queue.close()),
    ]);
  });
