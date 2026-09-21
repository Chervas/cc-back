#!/usr/bin/env node
'use strict';
// Exercise actual service writes and MySQL JSON serialization using only the
// existing isolated, fictitious clinic. Every write is rolled back. No HTTP,
// signature request, payment, PDF, message or clinical appointment is created.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const log = console.log;
  let db, service;
  try {
    console.log = () => {};
    db = require('../../../models');
    service = require('../../services/patientEconomics.service');
  } finally { console.log = log; }
  const nativeTransaction = db.sequelize.transaction.bind(db.sequelize);
  const marker = `qa-gross-${randomUUID()}`;
  const rollback = Error('QA_ALWAYS_ROLL_BACK');
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal((await db.Clinica.findByPk(1))?.nombre_clinica, 'Clinica ficticia DEV');
    assert.equal((await db.Usuario.findByPk(1))?.email_usuario, 'carlos@clinicaclick.com');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    assert(patient);
    const before = await db.EconomicBudget.count({ where: { clinic_id: 1 } });
    await assert.rejects(nativeTransaction(async transaction => {
      // Keep the service's own transactions and rollback semantics as real
      // savepoints under one outer transaction that can never commit.
      db.sequelize.transaction = (options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        return nativeTransaction({ ...options, transaction }, callback);
      };
      const profile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
      const treatment = await db.Tratamiento.create({ nombre: 'Precio final ficticio — rollback', codigo: marker,
        origen: 'clinica', clinica_id: 1, disciplina: 'estetica', activo: true, duracion_min: 30, precio_base: 145,
        clinical_config: { price_profile: profile } }, { transaction });
      const payload = { status: 'draft', source_system: 'qa_rollback', source_reference: marker,
        lines: [{ key: 'gross', treatment_id: treatment.id_tratamiento, name: treatment.nombre, quantity: 2,
          unit_price: 145, discount_percent: 10, price_snapshot: { forged: true }, tax_percent: 0 }],
        global_discount_percent: 10, notes: 'Prueba ficticia transaccional; no facturar ni enviar.' };
      const args = { patientIdentifier: PATIENT_ID, clinicId: 1, actorId: 1, payload };
      const first = await service.createBudget(args);
      assert.equal(first.current.totals.total, 234.9);
      assert.equal(first.current.totals.tax_base, 194.13);
      assert.equal(first.current.totals.taxes, 40.77);
      assert.equal(first.current.totals.tax_breakdown_status, 'complete');
      assert.equal(first.current.lines[0].price_snapshot.profile.tax_percent, 21);
      assert.equal(first.financial_summary.payable, 234.9);
      assert.equal(first.financial_summary.paid, 0);
      const budget = await db.EconomicBudget.findOne({ where: { public_id: first.id }, transaction });
      const persisted = await db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: 1 }, transaction });
      assert.equal(persisted.lines[0].price_snapshot.profile.tax_percent, 21);
      await treatment.update({ clinical_config: { price_profile: { ...profile, tax_percent: 0, exemption_reason: 'Exención sintética para comprobar snapshots; no es una decisión clínica.' } } }, { transaction });
      const edited = await service.updateDraftBudget({ publicId: first.id, actorId: 1,
        payload: { ...payload, expected_version: 1, notes: 'Edición ficticia posterior al cambio del catálogo.' } });
      assert.equal(edited.current_version, 2);
      assert.equal(edited.current.totals.taxes, 40.77);
      assert.equal(edited.current.lines[0].price_snapshot.profile.tax_percent, 21);
      const next = await service.createBudget({ ...args, payload: { ...payload, source_reference: marker + '-new' } });
      assert.equal(next.current.totals.total, 234.9); assert.equal(next.current.totals.taxes, 0);
      assert.equal(next.current.lines[0].price_snapshot.profile.tax_percent, 0);
      const count = await db.EconomicBudget.count({ where: { clinic_id: 1 }, transaction });
      await treatment.update({ clinical_config: { price_profile: profile, fiscal_mapping_pending: true } }, { transaction });
      await assert.rejects(service.createBudget({ ...args, payload: { ...payload, source_reference: marker + '-blocked' } }), { code: 'imported_treatment_fiscal_review_pending' });
      assert.equal(await db.EconomicBudget.count({ where: { clinic_id: 1 }, transaction }), count);
      await treatment.update({ clinical_config: { price_profile: profile }, eliminado_por_clinica: [1] }, { transaction });
      await assert.rejects(service.createBudget({ ...args, payload: { ...payload, source_reference: marker + '-unavailable' } }), { code: 'budget_treatment_unavailable' });
      assert.equal(await db.EconomicBudget.count({ where: { clinic_id: 1 }, transaction }), count);
      assert.equal(await db.EconomicPayment.count({ where: { budget_id: budget.id }, transaction }), 0);
      assert.equal(await db.PatientVoucher.count({ where: { budget_id: budget.id }, transaction }), 0);
      throw rollback;
    }), error => error === rollback);
    db.sequelize.transaction = nativeTransaction;
    assert.equal(await db.EconomicBudget.count({ where: { clinic_id: 1 } }), before);
    assert.equal(await db.Tratamiento.count({ where: { codigo: marker } }), 0);
    log(JSON.stringify({ status: 'passed', database: 'isolated-dev-only', persistedRows: 0,
      checks: ['service-create-gross-budget', 'real-json-roundtrip', 'global-discount-tax-reconciliation',
        'service-edit-preserves-fiscal-snapshot', 'new-budget-sees-explicit-catalog-change',
        'pending-and-unavailable-reject-with-savepoint-rollback', 'no-payments-or-vouchers', 'full-rollback'] }));
  } finally { db.sequelize.transaction = nativeTransaction; await db.sequelize.close(); }
}
main().catch(error => { console.error('ISOLATED_ECONOMIC_PRICES_FAILED', error.code || error.name,
  error.name === 'AssertionError' ? error.message : 'Revisar prueba SQL aislada.'); process.exitCode = 1; });
