'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTreatmentCatalogAccess } = require('../../lib/treatment-catalog-access');
const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');
const Op = { or: Symbol('or'), in: Symbol('in') };
function fixture({ allowed = [72], record = { origen: 'clinica', clinica_id: 72 }, groupClinics = [72, 66] } = {}) {
  const calls = [];
  const db = { Sequelize: { Op }, Tratamiento: { findByPk: async () => record }, Clinica: { findByPk: async () => ({ grupoClinicaId: 4 }), findAll: async () => groupClinics.map(id_clinica => ({ id_clinica })) }, UsuarioClinica: { findAll: async () => [{ id_clinica: 72 }] } };
  const middleware = createTreatmentCatalogAccess({ db, isAdmin: () => false, canAccess: async args => { calls.push(args); return allowed.includes(Number(args.clinicId)); } });
  const run = req => new Promise(resolve => middleware({ userData: { userId: 99 }, query: {}, body: {}, params: {}, method: 'GET', path: '/', ...req }, { status: status => ({ json: result => resolve({ status, result }) }) }, error => resolve(error || null)));
  return { run, calls, middleware };
}
test('catálogo exige usuario y scope clínica válido', async () => {
  assert.equal((await fixture().run({ userData: null })).statusCode, 401);
  assert.equal((await fixture().run({ query: { clinica_id: 999 } })).statusCode, 403);
  assert.equal(await fixture().run({ query: { clinica_id: 72 } }), null);
});
test('grupo no puede introducirse por query de otra clínica', async () => {
  assert.equal((await fixture().run({ query: { clinica_id: 72, grupo_clinica_id: 9 } })).statusCode, 403);
});
test('origen o IDs inválidos no degradan la búsqueda a todo el catálogo', async () => {
  for (const query of [{ clinica_id: 72, origen: 'otro' }, { clinica_id: '72xyz' }, { clinica_id: '0x48' }, { clinica_id: '7.2e1' }, { clinica_id: [72] }, { grupo_clinica_id: '4e1' }, { grupo_clinica_id: 0 }, { origen: ['clinica', 'sistema'] }, { grupo_clinica_id: 4, origen: 'clinica' }]) {
    assert.equal((await fixture().run({ query })).statusCode, 400);
  }
  // A clinic without a group cannot request an empty group scope.
  const db = { Sequelize: { Op }, Clinica: { findByPk: async () => ({ grupoClinicaId: null }) } };
  const middleware = createTreatmentCatalogAccess({ db, canAccess: async () => true, isAdmin: () => false });
  const error = await new Promise(resolve => middleware({ userData: { userId: 99 }, method: 'GET', query: { clinica_id: 72, origen: 'grupo' } }, {}, resolve));
  assert.equal(error.statusCode, 400);
});
test('consumidor global antiguo solo recibe catálogo de sistema', async () => {
  const query = {};
  assert.equal(await fixture().run({ query }), null);
  assert.equal(query.origen, 'sistema');
});
test('modificar grupo requiere autoridad sobre todas sus clínicas', async () => {
  const setup = fixture({ record: { origen: 'grupo', grupo_clinica_id: 4 } });
  assert.equal((await setup.run({ params: { id: 1 }, method: 'PATCH' })).statusCode, 403);
});
test('cambiar clínica de tratamiento comprueba origen y destino', async () => {
  const setup = fixture();
  assert.equal((await setup.run({ params: { id: 1 }, method: 'PATCH', body: { clinica_id: 66 } })).statusCode, 403);
  assert.ok(setup.calls.some(call => call.clinicId === 72 && call.featureKey === 'clinic.settings.edit'));
});
test('personalizar sistema no permite editar globalmente el original', async () => {
  const setup = fixture({ record: { origen: 'sistema' } });
  assert.equal(await setup.run({ params: { id: 1 }, method: 'POST', path: '/1/personalizar', body: { clinica_id: 72 } }), null);
  assert.equal((await setup.run({ params: { id: 1 }, method: 'PATCH' })).statusCode, 403);
});
test('perfiles sólo referencian cabinas/profesionales en su tenant', async () => {
  const treatment = { origen: 'clinica', clinica_id: 72, clinical_config: { catalog_status: 'draft', booking_profile: { phases: [{ installation_ids: [7], professionals: { ids: [12] } }] } } };
  const db = { Sequelize: { Op }, Instalacion: { findAll: async () => [{ id: 7 }] }, DoctorClinica: { findAll: async () => [] } };
  await assert.rejects(validateCatalogResources(treatment, db), { code: 'treatment_professional_scope' });
  db.DoctorClinica.findAll = async () => [{ doctor_id: 12 }];
  await validateCatalogResources(treatment, db);
  await assert.rejects(validateCatalogResources({ ...treatment, origen: 'sistema' }, db));
});
test('perfil operativo requiere despliegue compatible; borrador no activa ni degrada silenciosamente una cita', async () => {
  const profile = { version: 1, phases: [{ key: 'main', duration_minutes: 30, installation_ids: [7], professionals: { mode: 'any', ids: [12], preferred_id: 12 } }] };
  const treatment = { origen: 'clinica', clinica_id: 72, activo: true, clinical_config: { booking_profile: profile } };
  const db = { Sequelize: { Op }, Instalacion: { findAll: async () => [{ id: 7 }] }, DoctorClinica: { findAll: async () => [{ doctor_id: 12 }] } };
  await assert.rejects(validateCatalogResources(treatment, db, { environment: {} }), { code: 'booking_profile_preparation_only', status: 409 });
  await validateCatalogResources({ ...treatment, activo: false, clinical_config: { ...treatment.clinical_config, catalog_status: 'draft' } }, db, { environment: {} });
  await validateCatalogResources({ ...treatment, activo: false, clinical_config: { ...treatment.clinical_config, catalog_status: 'obsolete' } }, db, { environment: {} });
  await validateCatalogResources(treatment, db, { environment: { BOOKING_PROFILES_ENABLED: 'true' } });
  profile.phases[0].professionals.mode = 'all';
  profile.phases[0].professionals.ids = [12, 13];
  await assert.rejects(validateCatalogResources(treatment, db, { environment: { BOOKING_PROFILES_ENABLED: 'true' } }), { code: 'booking_profile_preparation_only' });
  assert.equal(treatment.activo, true);
});
