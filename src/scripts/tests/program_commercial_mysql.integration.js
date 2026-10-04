'use strict';
// Explicit opt-in: synthetic MySQL Unix socket only; fixture denies app DB,
// queues, providers, TCP and all unowned sockets.
// CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/program_commercial_mysql.integration.js
const assert = require('node:assert/strict'), Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const D = Sequelize.DataTypes; db.Sequelize = Sequelize;
  Object.assign(process.env, { TREATMENT_PROGRAM_ECONOMICS_ENABLED: 'true', TREATMENT_PROGRAM_BOOKING_ENABLED: 'true', BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true' });
  const define = (name, fields) => db[name] = sql.define(name, fields, { timestamps: false });
  define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER, nombre_clinica: D.STRING, configuracion: D.JSON });
  define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, nombre: D.STRING, apellidos: D.STRING });
  define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, grupo_clinica_id: D.INTEGER,
    origen: D.STRING, nombre: D.STRING, codigo: D.STRING, disciplina: D.STRING, especialidad: D.STRING, categoria: D.STRING,
    descripcion: D.STRING, activo: D.BOOLEAN, precio_base: D.DECIMAL(12, 2), duracion_min: D.INTEGER, sesiones_defecto: D.INTEGER,
    eliminado_por_clinica: D.JSON, clinical_config: D.JSON });
  define('Instalacion', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, activo: D.BOOLEAN });
  define('DoctorClinica', { doctor_id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, activo: D.BOOLEAN, recibe_citas: D.BOOLEAN });
  for (const file of ['treatmentprogram', 'treatmentprogramrevision', 'economicbudget', 'economicbudgetversion', 'economicbudgetevent',
    'economicbudgetsignaturerequest', 'economicpayment', 'patientvoucher', 'patientvouchermovement', 'patientwalletentry', 'cliniceconomictemplate']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  await sql.sync();
  await db.Clinica.create({ id_clinica: 72, grupoClinicaId: 9, nombre_clinica: 'Synthetic clinic', configuracion: {} });
  await db.Paciente.create({ id_paciente: 8, clinica_id: 72, nombre: 'Synthetic patient' });
  await db.Instalacion.create({ id: 3, clinica_id: 72, activo: true });
  await db.DoctorClinica.create({ doctor_id: 7, clinica_id: 72, activo: true, recibe_citas: true });
  const profile = { version: 1, phases: [{ key: 'care', label: 'Synthetic', duration_minutes: 30, installation_ids: [3], professionals: { mode: 'any', ids: [7], preferred_id: 7 } }] };
  const included = { id_tratamiento: 42, clinica_id: 72, origen: 'clinica', nombre: 'Included synthetic', disciplina: 'general', activo: true, precio_base: null,
    sesiones_defecto: 1, duracion_min: 30, clinical_config: { catalog_status: 'active', fiscal_mapping_pending: true, source_price: { mode: 'included', gross_amount: null }, booking_profile: profile, commercial: { sale_mode: 'program_component_only' } } };
  included.clinical_config = require('../../lib/treatment-commercial-policy').approveComponent(included, { confirm: true, actorId: 7 });
  await db.Tratamiento.create(included);
  const whatsappFile = require.resolve('../../services/whatsapp.service');
  require.cache[whatsappFile] = { id: whatsappFile, filename: whatsappFile, loaded: true, exports: { sendMessage: () => { throw Error('NO_PROVIDER_CALL_ALLOWED'); } } };
  const service = require('../../services/patientEconomics.service');
  const options = { patientIdentifier: 8, clinicId: 72, actorId: 7 };
  const counts = async () => Object.fromEntries(await Promise.all(['EconomicBudget', 'EconomicBudgetVersion', 'EconomicBudgetEvent', 'EconomicBudgetSignatureRequest', 'PatientVoucher', 'PatientVoucherMovement', 'EconomicPayment'].map(async name => [name, await db[name].count()])));
  const before = await counts();
  for (const key of ['treatment_id', 'catalogoId']) for (const product_type of ['treatment', 'voucher', 'pack']) await assert.rejects(service.createBudget({ ...options, payload: { lines: [{ key: 'individual', [key]: 42, name: 'Forged standalone', product_type, quantity: 1, unit_price: 99 }] } }), { code: 'treatment_program_component_only' });
  await assert.rejects(service.createVoucher({ ...options, payload: { treatment_id: 42, name: 'Forged', total_units: 1, sold_amount: 99 } }), { code: 'treatment_program_component_only' });
  await assert.rejects(service.sellVoucher({ ...options, payload: { treatment_id: 42, sold_amount: 99, sale_reference: 'blocked' } }), { code: 'treatment_program_component_only' });
  assert.deepEqual(await counts(), before);
  assert.equal((await db.Tratamiento.findByPk(42)).precio_base, null);
  report.checks.push('real SQL rejects aliases/positive overrides and both voucher writers without persisted financial changes; component remains NULL');

  const legacy = await db.EconomicBudget.create({ public_id: 'legacy-pending', clinic_id: 72, patient_id: 8, number: 'LEGACY', status: 'presented' });
  const legacyVersion = await db.EconomicBudgetVersion.create({ budget_id: legacy.id, version_number: 1,
    lines: [{ key: 'legacy', treatment_id: 42, product_type: 'voucher', name: 'Legacy', quantity: 1, unit_price: 99, total: 99 }], totals: { total: 99 }, payment_proposal: {}, design_config: {}, clinic_snapshot: {}, patient_snapshot: {} });
  const legacyBefore = await counts();
  for (const action of ['present_again', 'accept', 'accept_partial']) await assert.rejects(service.transitionBudget({ publicId: legacy.public_id, actorId: 7, action, payload: { expected_version: 1, accepted_line_keys: ['legacy'] } }), { code: 'treatment_program_component_only' });
  // Acceptance preview belongs to the API entrypoint, not this gateway.
  if (typeof service.previewBudgetAcceptance === 'function') await assert.rejects(service.previewBudgetAcceptance({ publicId: legacy.public_id, payload: { expected_version: 1, action: 'accept' } }), { code: 'treatment_program_component_only' });
  await assert.rejects(service.createBudgetSignatureRequest({ publicId: legacy.public_id, actorId: 7, payload: { target: 'tablet' } }), { code: 'treatment_program_component_only' });
  await assert.rejects(service.reviseBudget({ publicId: legacy.public_id, actorId: 7 }), { code: 'treatment_program_component_only' });
  assert.deepEqual(await counts(), legacyBefore); assert.equal((await legacy.reload()).status, 'presented');
  assert.deepEqual((await legacyVersion.reload()).lines, legacyVersion.lines);
  report.checks.push('real pending-budget presentation/acceptance/preview/revision/signature guards fail before financial or provider writes');

  const programmes = require('../../services/treatmentPrograms.service');
  const definition = await programmes.create({ clinicId: 72, actorId: 7, payload: { name: 'Synthetic programme', kind: 'program', status: 'active', total_price: 690,
    appointments: [{ key: 'first', treatment_ids: [42], offset_days: 0 }, { key: 'second', treatment_ids: [42], offset_days: null }] } });
  assert.equal(definition.item.commercial_ready, false); assert.equal(definition.item.status, 'active');
  const draft = await service.createBudget({ ...options, payload: { source_reference: 'program-draft', lines: [{ key: 'p', program_id: definition.item.id, program_version: 1, name: 'ignored', quantity: 1, unit_price: 690 }] } });
  await assert.rejects(service.transitionBudget({ publicId: draft.id, actorId: 7, action: 'present' }), { code: 'program_price_profile_required' });
  assert.equal((await db.EconomicBudget.findOne({ where: { public_id: draft.id } })).status, 'draft');
  report.checks.push('clinical-active included programme without own tax profile stays preparation-only; new presentation is blocked');
  const ownProfile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
  const configured = await programmes.update({ id: definition.item.id, clinicId: 72, actorId: 7, payload: { expected_version: 1, price_profile: ownProfile } });
  assert.equal(configured.item.version, 2); assert(configured.item.commercial_ready);
  const budget = await service.createBudget({ ...options, payload: { source_reference: 'program-owned-tax', status: 'presented', lines: [{ key: 'p', program_id: definition.item.id, program_version: 2, quantity: 1, unit_price: 690 }] } });
  assert.equal(budget.current.lines.length, 1); assert.equal(budget.current.totals.total, 690);
  assert.equal(budget.current.totals.taxes, 119.75); assert.equal(budget.current.lines[0].program_snapshot.price_profile_source, 'program');
  const accepted = await service.transitionBudget({ publicId: budget.id, actorId: 7, action: 'accept', payload: { expected_version: 1 } });
  assert.equal(accepted.accepted_amount, 690);
  const purchased = await db.EconomicBudget.findOne({ where: { public_id: budget.id } });
  const frozen = await db.EconomicBudgetVersion.findOne({ where: { budget_id: purchased.id } });
  const frozenBefore = JSON.stringify(frozen.lines);
  await db.Tratamiento.update({ activo: false }, { where: { id_tratamiento: 42 } });
  await programmes.update({ id: definition.item.id, clinicId: 72, actorId: 7, payload: { expected_version: 2, status: 'draft', price_profile: { ...ownProfile, tax_percent: 0, exemption_reason: 'Synthetic reason' } } });
  const payment = await service.createPayment({ publicId: budget.id, actorId: 7, payload: { amount: 100, method: 'cash', reference: 'old-debt', allocations: [{ target_type: 'budget', amount: 100 }] } });
  assert.equal(payment.amount, 100); assert.equal(JSON.stringify((await frozen.reload()).lines), frozenBefore);
  assert.equal((await purchased.reload()).accepted_amount, '690.00');
  report.checks.push('own programme profile is one gross concept, revisioned and frozen; later component/profile changes do not block debt collection or reprice purchase');
}).catch(error => { console.error(error); process.exitCode = 1; });
