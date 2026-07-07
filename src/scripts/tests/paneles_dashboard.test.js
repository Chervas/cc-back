'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const db = require('../../../models');
const panelesDashboardService = require('../../services/panelesDashboard.service');

function firstGlobalAdminId() {
  const raw = process.env.ADMIN_USER_IDS || '1,44';
  return raw
    .split(',')
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .find((value) => Number.isInteger(value) && value > 0) || 1;
}

async function pickClinicForGlobalAdmin(adminId) {
  const clinics = await db.Clinica.findAll({
    attributes: ['id_clinica'],
    order: [['id_clinica', 'ASC']],
    raw: true,
  });
  assert.ok(clinics.length > 0, 'Expected at least one clinic in dev database');

  const memberships = await db.UsuarioClinica.findAll({
    where: { id_usuario: adminId },
    attributes: ['id_clinica'],
    raw: true,
  });
  const assignedIds = new Set(memberships.map((row) => Number(row.id_clinica)));
  const unassigned = clinics.find((row) => !assignedIds.has(Number(row.id_clinica)));

  return Number((unassigned || clinics[0]).id_clinica);
}

async function pickPatientMembership() {
  return db.UsuarioClinica.findOne({
    where: { rol_clinica: 'paciente' },
    attributes: ['id_usuario', 'id_clinica'],
    raw: true,
  });
}

async function run() {
  const adminId = firstGlobalAdminId();
  const clinicId = await pickClinicForGlobalAdmin(adminId);

  const dashboard = await panelesDashboardService.getMainDashboard({
    userId: adminId,
    query: {
      clinica_id: String(clinicId),
      date: '2026-07-06',
    },
  });

  assert.equal(dashboard?.meta?.source, 'backend');
  assert.deepEqual(dashboard.scope.clinicIds, [clinicId]);
  assert.equal(dashboard.sections.showShared, true);
  assert.equal(Array.isArray(dashboard.inactiveTodayAppointments), true);

  const patientMembership = await pickPatientMembership();
  if (patientMembership) {
    const patientDashboard = await panelesDashboardService.getMainDashboard({
      userId: Number(patientMembership.id_usuario),
      query: {
        clinica_id: String(patientMembership.id_clinica),
        date: '2026-07-06',
      },
    });

    assert.equal(patientDashboard.sections.showShared, false);
    assert.equal(patientDashboard.sections.showOperations, false);
    assert.equal(patientDashboard.sections.showDoctor, false);
    assert.deepEqual(patientDashboard.todayAppointments, []);
    assert.deepEqual(patientDashboard.inactiveTodayAppointments, []);
    assert.deepEqual(patientDashboard.growthOpportunities, []);
    assert.deepEqual(patientDashboard.criticalAlerts, []);
    assert.deepEqual(patientDashboard.errors, []);
  }

  console.log('paneles_dashboard.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
