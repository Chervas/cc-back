#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const consentimientosService = require('../../services/consentimientos.service');
const consentimientosController = require('../../controllers/consentimientos.controller');
const doctoresRouter = require('../../routes/doctores.routes');
const panelesRouter = require('../../routes/paneles.routes');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.headersSent = true;
      return this;
    },
  };
}

async function invokeMiddleware(middleware, req) {
  const res = responseRecorder();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

async function testDoctorAndPanelScopes() {
  const originals = {
    membershipFindAll: db.UsuarioClinica.findAll,
    membershipFindOne: db.UsuarioClinica.findOne,
    clinicFindAll: db.Clinica.findAll,
    clinicFindByPk: db.Clinica.findByPk,
    overrideFindAll: db.AccessPolicyOverride.findAll,
    doctorClinicFindAll: db.DoctorClinica.findAll,
    doctorClinicFindOne: db.DoctorClinica.findOne,
    installationFindByPk: db.Instalacion.findByPk,
  };

  const membershipFor = (actorId, clinicId) => {
    if (Number(clinicId) !== 66) return null;
    if (Number(actorId) === 9100) return { rol_clinica: 'agencia', subrol_clinica: null };
    if (Number(actorId) === 9200) return { rol_clinica: 'propietario', subrol_clinica: null };
    return null;
  };

  db.UsuarioClinica.findAll = async ({ where }) => {
    const actorId = Number(where.id_usuario);
    const candidates = where.id_clinica?.[db.Sequelize.Op.in] || [66];
    return candidates
      .filter((clinicId) => membershipFor(actorId, clinicId))
      .map((clinicId) => ({ id_clinica: clinicId }));
  };
  db.UsuarioClinica.findOne = async ({ where }) => membershipFor(where.id_usuario, where.id_clinica);
  db.Clinica.findAll = async () => [{ id_clinica: 66 }];
  db.Clinica.findByPk = async (clinicId) => ({ id_clinica: Number(clinicId), grupoClinicaId: 7 });
  db.AccessPolicyOverride.findAll = async () => [];
  db.DoctorClinica.findAll = async () => [{ clinica_id: 66 }];
  db.DoctorClinica.findOne = async ({ where }) => (
    Number(where.doctor_id) === 700 && Number(where.clinica_id) === 66
      ? { id: 88 }
      : null
  );
  db.Instalacion.findByPk = async () => null;

  try {
    let result = await invokeMiddleware(
      doctoresRouter.__agencyAccessContract.scopeDoctorList,
      { userData: { userId: 9100 }, query: { clinica_id: '66' } },
    );
    assert.equal(result.res.statusCode, 403, 'agency must not enumerate the clinic team');
    assert.equal(result.nextCalled, false);

    const ownerRequest = { userData: { userId: 9200 }, query: { clinica_id: '66' } };
    result = await invokeMiddleware(doctoresRouter.__agencyAccessContract.scopeDoctorList, ownerRequest);
    assert.equal(result.nextCalled, true, 'owner may enumerate its scoped team');
    assert.deepEqual(ownerRequest.authorizedDoctorClinicIds, [66]);

    result = await invokeMiddleware(
      doctoresRouter.__agencyAccessContract.scopeAvailability,
      { userData: { userId: 9100 }, query: { doctor_id: '700', clinica_id: '66' } },
    );
    assert.equal(result.res.statusCode, 403, 'agency must not query operational availability');
    assert.equal(result.nextCalled, false);

    result = await invokeMiddleware(
      panelesRouter.__agencyAccessContract.requireOperationalQueryClinic,
      { userData: { userId: 9100 }, query: { idClinica: '66' } },
    );
    assert.equal(result.res.statusCode, 403, 'agency must not access legacy operational panels');

    const marketingRequest = { userData: { userId: 9100 }, query: { idClinica: '66' } };
    result = await invokeMiddleware(
      panelesRouter.__agencyAccessContract.requireMarketingMetricClinic,
      marketingRequest,
    );
    assert.equal(result.nextCalled, true, 'agency may read Marketing metrics in its explicit clinic scope');
    assert.deepEqual(marketingRequest.authorizedPanelClinicIds, [66]);

    result = await invokeMiddleware(
      panelesRouter.__agencyAccessContract.requireMarketingMetricClinic,
      { userData: { userId: 9100 }, query: { idClinica: '67' } },
    );
    assert.equal(result.res.statusCode, 403, 'agency must not read Marketing metrics outside its scope');
  } finally {
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.UsuarioClinica.findOne = originals.membershipFindOne;
    db.Clinica.findAll = originals.clinicFindAll;
    db.Clinica.findByPk = originals.clinicFindByPk;
    db.AccessPolicyOverride.findAll = originals.overrideFindAll;
    db.DoctorClinica.findAll = originals.doctorClinicFindAll;
    db.DoctorClinica.findOne = originals.doctorClinicFindOne;
    db.Instalacion.findByPk = originals.installationFindByPk;
  }
}

async function testGlobalConsentCatalog() {
  const originals = {
    list: consentimientosService.listAdminTemplates,
    create: consentimientosService.createAdminTemplate,
    update: consentimientosService.updateAdminTemplate,
    propagate: consentimientosService.propagateAdminTemplateToClinics,
    requirements: consentimientosService.getTreatmentRequirements,
  };
  const calls = [];
  consentimientosService.listAdminTemplates = async () => { calls.push('list'); return []; };
  consentimientosService.createAdminTemplate = async () => { calls.push('create'); return { id: 1 }; };
  consentimientosService.updateAdminTemplate = async () => { calls.push('update'); return { id: 1 }; };
  consentimientosService.propagateAdminTemplateToClinics = async () => { calls.push('propagate'); return { updated: 1 }; };
  consentimientosService.getTreatmentRequirements = async () => { calls.push('requirements'); return []; };

  const handlers = [
    ['list', consentimientosController.listAdminTemplates, { query: {} }],
    ['create', consentimientosController.createAdminTemplate, { body: {} }],
    ['update', consentimientosController.updateAdminTemplate, { params: { id: '1' }, body: {} }],
    ['propagate', consentimientosController.propagateAdminTemplate, { params: { id: '1' }, body: {} }],
  ];

  try {
    for (const [name, handler, request] of handlers) {
      const res = responseRecorder();
      await handler({ ...request, userData: { userId: 9100 } }, res, () => {});
      assert.equal(res.statusCode, 403, `agency must not call global consent action ${name}`);
      assert.equal(res.body?.message, 'admin_consent_catalog_forbidden');
    }
    assert.deepEqual(calls, [], 'forbidden global consent handlers must not reach the service layer');

    const adminRes = responseRecorder();
    await consentimientosController.listAdminTemplates({ userData: { userId: 1 }, query: {} }, adminRes, () => {});
    assert.equal(adminRes.statusCode, 200);
    assert.deepEqual(calls, ['list'], 'global admin must retain access to the catalog');

    const agencyRequirementsRes = responseRecorder();
    await consentimientosController.getTreatmentRequirements({
      userData: { userId: 9100 },
      params: { id: '5' },
      query: {},
    }, agencyRequirementsRes, () => {});
    assert.equal(agencyRequirementsRes.statusCode, 403,
      'omitting clinic_id must not bypass consent scope on treatment requirements');
    assert.deepEqual(calls, ['list']);
  } finally {
    consentimientosService.listAdminTemplates = originals.list;
    consentimientosService.createAdminTemplate = originals.create;
    consentimientosService.updateAdminTemplate = originals.update;
    consentimientosService.propagateAdminTemplateToClinics = originals.propagate;
    consentimientosService.getTreatmentRequirements = originals.requirements;
  }
}

function testSourceContracts() {
  const doctorRoutes = fs.readFileSync(path.resolve(__dirname, '../../routes/doctores.routes.js'), 'utf8');
  const doctorController = fs.readFileSync(path.resolve(__dirname, '../../controllers/doctores.controller.js'), 'utf8');
  const panelRoutes = fs.readFileSync(path.resolve(__dirname, '../../routes/paneles.routes.js'), 'utf8');

  assert.match(doctorRoutes, /router\.get\('\/', scopeDoctorList, controller\.list\)/);
  assert.match(doctorRoutes, /scopeDoctorClinica\('team\.manage'\)/);
  assert.match(doctorRoutes, /scopeBlockMutation\(\)/);
  assert.match(doctorRoutes, /scopeAvailability, controller\.disponibilidad/);
  assert.match(doctorController, /clinica_id: \{ \[Op\.in\]: authorizedClinicIds \}/,
    'doctor list query must be constrained server-side, not only by frontend filters');
  assert.match(doctorController, /buildSchedule\(doctorId, req\.authorizedDoctorClinicIds\)/,
    'legacy schedules must be projected to authorized clinics');

  assert.match(panelRoutes, /router\.use\(authMiddleware\)/,
    'every legacy panel endpoint must require authentication');
  assert.match(panelRoutes, /clinica_id: \{ \[Op\.in\]: req\.authorizedPanelClinicIds \}/,
    'social series must always query the authorized clinic set');
  assert.match(panelRoutes, /clinicaId: \{ \[Op\.in\]: req\.authorizedPanelClinicIds \}/,
    'asset linkage checks must always query the authorized clinic set');

  const appSource = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
  assert.match(appSource, /app\.use\('\/api\/doctores', doctoresRoutes\)/);
  assert.match(appSource, /app\.use\('\/api\/doctors', doctoresRoutes\)/,
    'English and Spanish aliases must share the same protected router');
}

async function main() {
  testSourceContracts();
  await testDoctorAndPanelScopes();
  await testGlobalConsentCatalog();
  console.log('agency legacy ACL contract: ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
