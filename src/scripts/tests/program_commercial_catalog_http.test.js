'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = require.resolve('../../controllers/tratamientos.controller'), localRequire = createRequire(filename);
const original = fs.readFileSync(filename, 'utf8');
const profile = { version: 1, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [3], professionals: { mode: 'any', ids: [7], preferred_id: 7 } }] };
function setup() {
  const rows = [], state = { saves: 0, failResources: false };
  const model = values => ({ ...values, toJSON() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); }, async save() { state.saves++; return this; } });
  const db = { Sequelize: { Op: require('sequelize').Op }, Tratamiento: { create: async values => { const row = model({ id_tratamiento: 42, ...values }); rows.push(row); return row; }, findByPk: async () => rows[0] },
    sequelize: { transaction: async work => { const count = rows.length; try { return await work({}); } catch (error) { rows.splice(count); throw error; } } },
    Instalacion: { findAll: async () => state.failResources ? [] : [{ id: 3 }] }, DoctorClinica: { findAll: async () => [{ doctor_id: 7 }] } };
  const module = { exports: {} };
  const controlledRequire = path => path === '../../models' ? db : path === 'express-async-handler' ? handler => handler
    : path === '../lib/treatment-automation-scope' ? { createTreatmentAutomationScope: () => ({ assertReferenceScope: async () => {} }) }
      : path === '../lib/treatment-catalog-resources' ? { validateCatalogResources: (t, d, options) => localRequire(path).validateCatalogResources(t, d, { ...options, environment: { BOOKING_PROFILES_ENABLED: 'true' } }) }
        : localRequire(path);
  vm.runInNewContext(original, { exports: module.exports, module, require: controlledRequire, process, console });
  const response = { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return body; } };
  const payload = { nombre: 'Synthetic component', disciplina: 'general', origen: 'clinica', clinica_id: 72, precio_base: null,
    clinical_config: { catalog_status: 'active', booking_profile: profile, commercial: { sale_mode: 'program_component_only' } }, confirm_program_component: true };
  const request = body => ({ body, userData: { userId: 7 }, params: { id: 42 } });
  return { handlers: module.exports, rows, state, response, payload, request };
}
test('HTTP creates approved NULL component atomically with authenticated actor and real resource checks', async () => {
  const f = setup(); await f.handlers.createTratamiento(f.request(f.payload), f.response);
  assert.equal(f.response.code, 201); assert.equal(f.rows.length, 1); assert.equal(f.rows[0].precio_base, null);
  assert.equal(f.response.body.component_policy.component_approved, true);
  assert.equal(f.rows[0].clinical_config.commercial.component_review.approved_by, 7);
  assert.equal(f.rows[0].clinical_config.price_profile, undefined); assert.equal(f.rows[0].activo, true);
  const blocked = setup(); blocked.state.failResources = true;
  await assert.rejects(blocked.handlers.createTratamiento(blocked.request(blocked.payload), blocked.response), { code: 'treatment_installation_scope' });
  assert.equal(blocked.rows.length, 0); assert.equal(blocked.state.saves, 0);
});
test('HTTP client review/source, non-NULL amount and string confirmation cannot activate a component', async () => {
  for (const patch of [{ precio_base: 0 }, { precio_base: 90 }, { confirm_program_component: 'true' },
    { clinical_config: { catalog_status: 'active', commercial: { sale_mode: 'program_component_only', component_review: { approved_by: 7 } } }, confirm_program_component: false },
    { clinical_config: { catalog_status: 'active', commercial: { sale_mode: 'program_component_only' }, source_price: { mode: 'included' } } }]) {
    const f = setup(); await assert.rejects(f.handlers.createTratamiento(f.request({ ...f.payload, ...patch }), f.response)); assert.equal(f.rows.length, 0);
  }
});
test('HTTP source change is importer-only even when an actor explicitly approves a component', async () => {
  const f = setup();
  await f.handlers.createTratamiento(f.request({ ...f.payload, activo: false, confirm_program_component: false, clinical_config: { ...f.payload.clinical_config, catalog_status: 'draft' } }), f.response);
  // This synthetic canonical provenance is populated by the isolated importer, not HTTP.
  f.rows[0].clinical_config.source_price = { mode: 'fixed', gross_amount: 90 };
  const saves = f.state.saves;
  await assert.rejects(f.handlers.updateTratamiento(f.request({ precio_base: null, confirm_program_component: true,
    clinical_config: { catalog_status: 'active', source_price: { mode: 'included', gross_amount: null }, commercial: { sale_mode: 'program_component_only' } } }), f.response), { code: 'component_import_source_invalid' });
  assert.equal(f.state.saves, saves); assert.equal(f.rows[0].clinical_config.source_price.mode, 'fixed');
});
test('HTTP included-to-standalone transition requires a new explicit amount and valid fiscal profile', async () => {
  const f = setup(); await f.handlers.createTratamiento(f.request(f.payload), f.response);
  const saves = f.state.saves;
  await assert.rejects(f.handlers.updateTratamiento(f.request({ clinical_config: { commercial: { sale_mode: 'standalone' } } }), f.response), { code: 'component_standalone_review_required' });
  assert.equal(f.state.saves, saves);
  // Reset the unsaved in-memory instance as Sequelize would do on the next fresh request.
  f.rows[0].clinical_config.commercial.sale_mode = 'program_component_only';
  await f.handlers.updateTratamiento(f.request({ precio_base: 0, clinical_config: { commercial: { sale_mode: 'standalone' },
    price_profile: { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 0, exemption_reason: 'Explicit synthetic free/exempt offer' } } }), f.response);
  assert.equal(f.rows[0].precio_base, 0); assert.equal(f.response.body.standalone_sellable, true);
});
test('HTTP personalization cannot turn an included component into an unpriced standalone offer', async () => {
  const priceProfile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
  for (const patch of [
    {},
    { precio_base: null },
    { precio_base: '90' },
    { precio_base: '   ' },
    { precio_base: false },
    { precio_base: Infinity },
    { precio_base: -1 },
    { precio_base: 90, clinical_config: { price_profile: null } },
  ]) {
    const f = setup(); await f.handlers.createTratamiento(f.request(f.payload), f.response);
    const saves = f.state.saves;
    await assert.rejects(f.handlers.personalizarTratamiento(f.request({
      clinica_id: 73, ...patch,
      clinical_config: { price_profile: priceProfile, ...patch.clinical_config, commercial: { sale_mode: 'standalone' } },
    }), f.response), { code: 'component_standalone_review_required' });
    assert.equal(f.rows.length, 1); assert.equal(f.state.saves, saves);
    assert.equal(f.rows[0].precio_base, null);
    assert.equal(f.rows[0].clinical_config.commercial.sale_mode, 'program_component_only');
  }
  const f = setup(); await f.handlers.createTratamiento(f.request(f.payload), f.response);
  await f.handlers.personalizarTratamiento(f.request({ clinica_id: 73, precio_base: 90,
    clinical_config: { commercial: { sale_mode: 'standalone' }, price_profile: priceProfile } }), f.response);
  assert.equal(f.response.code, 201); assert.equal(f.rows.length, 2);
  assert.equal(f.rows[1].precio_base, 90); assert.equal(f.rows[1].clinical_config.price_profile.tax_percent, 21);
  assert.equal(f.rows[0].precio_base, null); assert.equal(f.rows[0].clinical_config.commercial.sale_mode, 'program_component_only');
});
