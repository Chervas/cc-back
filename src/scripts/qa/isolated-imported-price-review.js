#!/usr/bin/env node
'use strict';
// Real controller + SQL; fictitious DEV clinic only. All writes roll back.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MARKER } = require('./prepare-isolated-clinical-fixture');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const log = console.log; let db, controller;
  try { console.log = () => {}; db = require('../../../models'); controller = require('../../controllers/tratamientos.controller'); }
  finally { console.log = log; }
  const marker = `qa-import-review-${randomUUID().slice(0,20)}`, rollback = Error('QA_ALWAYS_ROLL_BACK');
  const find = db.Tratamiento.findByPk;
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal((await db.Clinica.findByPk(1))?.nombre_clinica, 'Clinica ficticia DEV');
    assert.equal((await db.Usuario.findByPk(1))?.email_usuario, 'carlos@clinicaclick.com');
    const count = await db.Tratamiento.count();
    await assert.rejects(db.sequelize.transaction(async transaction => {
      const config = { catalog_status: 'draft', fiscal_mapping_pending: true, source_price: { mode: 'fixed', gross_amount: 145 }, source_catalog: { qa: marker } };
      const treatment = await db.Tratamiento.create({ nombre: 'QA precio importado — rollback', codigo: marker, clinica_id: 1,
        origen: 'clinica', disciplina: 'estetica', activo: false, precio_base: null, clinical_config: config }, { transaction });
      db.Tratamiento.findByPk = async (id, options) => {
        assert.equal(Number(id), treatment.id_tratamiento);
        const row = await find.call(db.Tratamiento, id, { ...options, transaction });
        const save = row.save.bind(row); row.save = options => save({ ...options, transaction }); return row;
      };
      const update = body => new Promise((resolve, reject) => controller.updateTratamiento({ params: { id: treatment.id_tratamiento }, body,
        userData: { userId: 1 } }, { json: resolve, status: () => ({ json: reject }) }, reject));
      let dto = await update({ descripcion: 'Solo completar cabina después', precio_base: null });
      assert.equal(dto.precio_base, null); assert.equal(dto.catalog_price.amount, 145); assert.equal(dto.clinical_config.fiscal_mapping_pending, true);
      const priceProfile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
      dto = await update({ precio_base: 150, clinical_config: { fiscal_mapping_pending: false, source_price: null, imported_price_review: { reviewed_by: 999 }, price_profile: priceProfile } });
      assert.equal(dto.clinical_config.fiscal_mapping_pending, true); assert.equal(dto.clinical_config.imported_price_review, undefined);
      assert.deepEqual(dto.clinical_config.source_price, config.source_price);
      await assert.rejects(update({ precio_base: null, confirm_imported_price: true }), { code: 'imported_price_amount_invalid' });
      dto = await update({ precio_base: 150, confirm_imported_price: true });
      assert.equal(dto.activo, false); assert.equal(dto.clinical_config.catalog_status, 'draft'); assert.equal(dto.catalog_price.amount, 150);
      assert.equal(dto.catalog_price.review_required, false); assert.equal(dto.clinical_config.imported_price_review.reviewed_by, 1);
      assert.equal(dto.clinical_config.imported_price_review.gross_amount, 150);
      await assert.rejects(update({ precio_base: 150, confirm_imported_price: true }), { code: 'imported_price_not_pending' });
      await assert.rejects(update({ clinical_config: { price_profile: null } }), { code: 'imported_price_profile_required' });
      await assert.rejects(update({ precio_base: null }), { code: 'imported_price_amount_invalid' });
      const persisted = await find.call(db.Tratamiento, treatment.id_tratamiento, { transaction });
      assert.deepEqual(persisted.clinical_config.imported_price_review, dto.clinical_config.imported_price_review);
      throw rollback;
    }), error => error === rollback);
    assert.equal(await db.Tratamiento.count(), count);
    assert.equal(await db.Tratamiento.count({ where: { codigo: marker } }), 0);
    log(JSON.stringify({ status: 'passed', database: 'isolated-dev-only', persistedRows: 0,
      checks: ['controller-save-incomplete-draft', 'hold-and-source-forgery-protected', 'explicit-review-real-sql', 'server-actor', 'no-activation', 'duplicate-confirmation-rejected', 'full-rollback'] }));
  } finally { db.Tratamiento.findByPk = find; await db.sequelize.close(); }
}
main().catch(error => { console.error('ISOLATED_IMPORTED_PRICE_REVIEW_FAILED', error.code || error.name,
  error.name === 'AssertionError' ? error.message : 'Revisar prueba SQL aislada.'); process.exitCode = 1; });
