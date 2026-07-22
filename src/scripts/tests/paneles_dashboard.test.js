'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const db = require('../../../models');
const panelesDashboardService = require('../../services/panelesDashboard.service');
const { __testing } = panelesDashboardService;

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
  const summerRange = __testing.dayRange('2026-07-22', 'Europe/Madrid');
  assert.equal(summerRange.start.toISOString(), '2026-07-21T22:00:00.000Z');
  assert.equal(summerRange.end.toISOString(), '2026-07-22T21:59:59.999Z');

  const dstStartRange = __testing.dayRange('2026-03-29', 'Europe/Madrid');
  assert.equal(dstStartRange.start.toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(dstStartRange.end.toISOString(), '2026-03-29T21:59:59.999Z');
  assert.equal(dstStartRange.end.getTime() - dstStartRange.start.getTime() + 1, 23 * 60 * 60 * 1000);

  const clinicMap = new Map([[
    59,
    {
      id_clinica: 59,
      nombre_clinica: 'Propdental Hospitalet',
      configuracion: { timezone: 'Europe/Madrid' },
    },
  ]]);
  const appointmentMaps = {
    patients: new Map([[2700, { id_paciente: 2700, nombre: 'Dunia', apellidos: 'Irías' }]]),
    doctors: new Map(),
    installations: new Map(),
    treatments: new Map(),
    clinics: clinicMap,
  };
  const mappedAppointment = __testing.mapAppointment({
    id_cita: 2702,
    clinica_id: 59,
    paciente_id: 2700,
    doctor_id: null,
    instalacion_id: null,
    tratamiento_id: null,
    estado: 'recordatorio_confirmado',
    inicio: new Date('2026-07-22T14:15:00.000Z'),
    fin: new Date('2026-07-22T14:30:00.000Z'),
  }, appointmentMaps, new Date('2026-07-22T12:00:00.000Z'));
  assert.equal(mappedAppointment.timeLabel, '16:15');
  assert.equal(mappedAppointment.date, '2026-07-22');
  assert.equal(mappedAppointment.agendaQuery.fecha, '2026-07-22');

  const afterUtcMidnight = __testing.mapAppointment({
    id_cita: 2703,
    clinica_id: 59,
    paciente_id: 2700,
    estado: 'pendiente',
    inicio: new Date('2026-07-22T22:30:00.000Z'),
    fin: new Date('2026-07-22T22:45:00.000Z'),
  }, appointmentMaps, new Date('2026-07-22T12:00:00.000Z'));
  assert.equal(afterUtcMidnight.timeLabel, '00:30');
  assert.equal(afterUtcMidnight.date, '2026-07-23');

  const agencySections = __testing.roleSections('agencia', 'unknown');
  assert.equal(agencySections.ownerLike, false);
  assert.equal(agencySections.operations, false);
  assert.equal(agencySections.shared, true);
  assert.equal(__testing.roleSections('agencia', 'admin_staff').operations, false,
    'an agency cannot inherit clinic operations from a stray subrole label');

  const guardedAgencyDashboard = __testing.applyDashboardAccessGuard({
    todayAppointments: [{ patientName: 'Paciente Secreto', patientAvatar: 'secret-photo.jpg' }],
    inactiveTodayAppointments: [{ patientName: 'Paciente Inactivo' }],
    nextAppointments: [{ patientName: 'Paciente Futuro' }],
    pastAttendancePending: [{ patientName: 'Paciente Pasado' }],
    doctorAppointmentsToday: [{ patientName: 'Paciente Doctor' }],
    pendingPatientConsents: [{ patientName: 'Consentimiento Secreto' }],
    doctorPendingConsents: [{ patientName: 'Consentimiento Doctor' }],
    unansweredReviews: [{ matchedPatientName: 'Paciente Reseña', reviewerAvatar: 'review-photo.jpg' }],
    tasks: { items: [{ label: 'Pacientes sin confirmar' }], total: 1 },
    growthOpportunities: [{ id: 'marketing-safe', campaignId: 123 }],
  }, {
    appointments: false,
    consents: false,
    reviews: false,
    tasks: false,
  });
  assert.deepEqual(guardedAgencyDashboard.todayAppointments, []);
  assert.deepEqual(guardedAgencyDashboard.inactiveTodayAppointments, []);
  assert.deepEqual(guardedAgencyDashboard.nextAppointments, []);
  assert.deepEqual(guardedAgencyDashboard.pastAttendancePending, []);
  assert.deepEqual(guardedAgencyDashboard.doctorAppointmentsToday, []);
  assert.deepEqual(guardedAgencyDashboard.pendingPatientConsents, []);
  assert.deepEqual(guardedAgencyDashboard.doctorPendingConsents, []);
  assert.deepEqual(guardedAgencyDashboard.unansweredReviews, []);
  assert.deepEqual(guardedAgencyDashboard.tasks, { items: [], total: 0 });
  assert.deepEqual(guardedAgencyDashboard.growthOpportunities, [{ id: 'marketing-safe', campaignId: 123 }]);
  assert.doesNotMatch(JSON.stringify(guardedAgencyDashboard), /Paciente Secreto|secret-photo|Consentimiento Secreto|Paciente Reseña/);

  assert.equal(__testing.statusUi('no_asistio').label, 'No asistió');
  assert.equal(
    __testing.isExpectedTodayAppointment({ rawStatus: 'pendiente', attendanceDue: true }),
    false,
    'Open appointments whose end already passed must move out of todayAppointments'
  );
  assert.equal(
    __testing.isExpectedTodayAppointment({ rawStatus: 'pendiente', attendanceDue: false }),
    true,
    'Open appointments that are not due for attendance still count as expected today'
  );
  assert.equal(
    __testing.isExpectedTodayAppointment({ rawStatus: 'completada', attendanceDue: false }),
    false,
    'Closed appointments do not count as expected today for operations'
  );
  assert.equal(
    __testing.isExpectedTodayAppointment({ rawStatus: 'completada', attendanceDue: false }, { includeClosedToday: true }),
    true,
    'Doctor day view keeps closed appointments with their state'
  );
  assert.deepEqual(
    await __testing.loadAppointments({
      clinicIds: [],
      clinicMap: new Map(),
      todayStart: new Date('2026-07-06T00:00:00.000Z'),
      todayEnd: new Date('2026-07-06T23:59:59.999Z'),
      now: new Date('2026-07-06T12:00:00.000Z'),
    }),
    { today: [], inactiveToday: [], pastAttendance: [], next: [] },
    'Empty appointment scope must preserve the full dashboard contract'
  );

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
  assert.equal(Array.isArray(dashboard.unansweredReviews), true);
  assert.equal(dashboard.rolePresentation?.mode, 'clinic_operations');
  assert.equal(typeof dashboard.rolePresentation?.title, 'string');

  const dashboardWithSpoofedRole = await panelesDashboardService.getMainDashboard({
    userId: adminId,
    query: {
      clinica_id: String(clinicId),
      date: '2026-07-06',
      role: 'paciente',
      subrol: 'doctor',
    },
  });

  assert.equal(dashboardWithSpoofedRole.role.code, 'administrador');
  assert.equal(dashboardWithSpoofedRole.sections.showOperations, true);
  assert.notEqual(dashboardWithSpoofedRole.rolePresentation?.mode, 'restricted');

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
    assert.equal(patientDashboard.rolePresentation?.mode, 'restricted');
    assert.deepEqual(patientDashboard.todayAppointments, []);
    assert.deepEqual(patientDashboard.inactiveTodayAppointments, []);
    assert.deepEqual(patientDashboard.unansweredReviews, []);
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
