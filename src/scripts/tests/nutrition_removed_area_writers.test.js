'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse the isolated models and ACL fixture. Only the PDF renderer is replaced;
// these tests exercise the exported writers/readers without SQL or Chromium.
const fixtureFile = path.join(__dirname, 'nutrition_measurement_context.test.js');
const serviceFile = path.resolve(__dirname, '../../services/nutritionWorkspace.service.js');
const fixtureModule = { exports: {} };
const isolatedFs = {
  ...fs,
  readFileSync(filename, ...args) {
    const contents = fs.readFileSync(filename, ...args);
    return path.resolve(filename) === serviceFile
      ? contents + '\nhtmlToPdfBuffer = async () => Buffer.from("%PDF-TESTONLY");\n'
      : contents;
  },
};
vm.runInNewContext(`(function(require,module,exports,__dirname){${fs.readFileSync(fixtureFile, 'utf8')}\nmodule.exports={fixture};})`,
  { console, Buffer, process })(name => name === 'node:test' ? () => {} : name === 'node:fs' ? isolatedFs : createRequire(fixtureFile)(name),
  fixtureModule, fixtureModule.exports, __dirname);
const fixture = fixtureModule.exports.fixture;
const removed = error => error.status === 403 && error.code === 'nutrition_area_not_configured';
const photo = { data_url: 'data:image/png;base64,VEVTVE9OTFk=', filename: 'TESTONLY.png' };
function trackClinics(f) {
  const read = f.db.Clinica.findByPk;
  f.db.Clinica.findByPk = async (id, options) => {
    f.state.calls.push({ name: 'clinic', id, ...options });
    return read(id, options);
  };
}

test('removing the actual area blocks photos and both snapshot writers without changing stored history', async () => {
  const f = fixture(); const measurement = await f.save({});
  const original = JSON.stringify({ rows: f.state.rows, reports: f.state.reports });
  (await f.db.Clinica.findByPk(10)).configuracion = { disciplinas: ['dental'] };
  f.state.calls.length = 0; trackClinics(f);
  await assert.rejects(f.service.addNutritionMeasurementClinicalPhoto('pac_ficticio', measurement.id, photo, 7), removed);
  await assert.rejects(f.service.createNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7), removed);
  await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7, { compareMeasurementId: null }), removed);
  assert.equal(JSON.stringify({ rows: f.state.rows, reports: f.state.reports }), original);
  assert(!f.state.calls.some(call => call.name === 'storeBinary'));
  const locks = f.state.calls.filter(call => call.name === 'clinic' && call.lock === 'UPDATE');
  assert.equal(locks.length, 3);
  for (const call of locks) {
    assert.equal(call.id, 10); assert.equal(call.transaction, f.tx);
    assert(call.attributes.includes('configuracion'));
  }
});

test('writers use the measurement clinic, not an enabled primary clinic or request options', async () => {
  const f = fixture(); const measurement = await f.save({ clinic_id: 20 });
  (await f.db.Clinica.findByPk(20)).configuracion = { disciplinas: [] };
  trackClinics(f); f.state.calls.length = 0;
  await assert.rejects(f.service.addNutritionMeasurementClinicalPhoto('pac_ficticio', measurement.id, { ...photo, clinic_id: 10 }, 7), removed);
  await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7, { clinicId: 10 }), removed);
  assert(f.state.calls.filter(call => call.name === 'clinic' && call.lock === 'UPDATE').every(call => call.id === 20));
  (await f.db.Clinica.findByPk(20)).configuracion = { disciplinas: ['nutricion'] };
  f.patient.clinica.configuracion = { disciplinas: ['dental'] };
  const result = await f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7);
  assert.equal(result.clinic_id, 20);
});

test('the current area is checked inside the snapshot transaction before any supersede/create', async () => {
  const f = fixture(); const measurement = await f.save({});
  const original = JSON.stringify(f.state.reports);
  const transact = f.db.sequelize.transaction;
  f.db.sequelize.transaction = async callback => {
    (await f.db.Clinica.findByPk(10)).configuracion = { disciplinas: [] };
    return transact(callback);
  };
  await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7), removed);
  assert.equal(JSON.stringify(f.state.reports), original);
});

test('access denial happens before the writer area lock or private storage', async () => {
  const f = fixture(); const measurement = await f.save({});
  trackClinics(f); f.state.calls.length = 0; f.state.deniedFeatures = ['nutrition.measurements.create', 'nutrition.reports.finalize'];
  await assert.rejects(f.service.addNutritionMeasurementClinicalPhoto('pac_ficticio', measurement.id, photo, 7), error => error.status === 403);
  await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7), error => error.status === 403);
  assert(!f.state.calls.some(call => call.name === 'clinic' && call.lock || call.name === 'storeBinary'));
});

test('enabled photos and final PDF caching preserve the transaction and exact private owner', async () => {
  const f = fixture(); const measurement = await f.save({ clinic_id: 20 });
  trackClinics(f); f.state.calls.length = 0;
  await f.service.addNutritionMeasurementClinicalPhoto('pac_ficticio', measurement.id, photo, 7);
  const upload = f.state.calls.find(call => call.name === 'storeBinary');
  assert.equal(upload.values.clinicId, 20); assert.equal(upload.values.ownerId, measurement.id);
  assert.equal(upload.values.transaction, f.tx);
  const final = await f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7);
  const snapshot = f.state.reports.find(row => row.id === final.id);
  let saved;
  snapshot.save = async options => { saved = options; };
  const result = await f.service.generateNutritionMeasurementReportPdf('pac_ficticio', measurement.id, 7);
  assert.equal(result.buffer.toString(), '%PDF-TESTONLY'); assert.equal(result.pdf_asset_id, 100);
  const cache = f.state.calls.find(call => call.name === 'storeBinary' && call.values.purpose === 'nutrition_report_pdf');
  assert.equal(cache.values.clinicId, 20); assert.equal(cache.values.ownerId, snapshot.id);
  assert.equal(cache.values.transaction, f.tx); assert.equal(saved.transaction, f.tx);
});

test('removed-area report reads and PDF generation remain available without writing a new cache', async () => {
  const f = fixture(); const measurement = await f.save({});
  const final = await f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', measurement.id, 7);
  const snapshot = f.state.reports.find(row => row.id === final.id);
  (await f.db.Clinica.findByPk(10)).configuracion = { disciplinas: [] };
  const original = JSON.stringify(f.state.reports); f.state.calls.length = 0;
  assert.equal((await f.service.getPatientNutritionWorkspace('pac_ficticio', { actorUserId: 7, clinicId: 10 })).measurements.length, 1);
  assert.equal((await f.service.getNutritionMeasurementReport('pac_ficticio', measurement.id, { actorUserId: 7 })).measurement.id, measurement.id);
  assert.equal(await f.service.renderNutritionMeasurementReport('pac_ficticio', measurement.id, { actorUserId: 7 }), snapshot.snapshot_html);
  const result = await f.service.generateNutritionMeasurementReportPdf('pac_ficticio', measurement.id, 7);
  assert.equal(result.buffer.toString(), '%PDF-TESTONLY'); assert.equal(result.cached, false); assert.equal(result.pdf_asset_id, null);
  assert(!f.state.calls.some(call => call.name === 'storeBinary'));
  assert.equal(JSON.stringify(f.state.reports), original);
  snapshot.pdf_asset_id = 99;
  f.state.assets.push({ id: 99, patient_id: 1, clinic_id: 10, owner_type: 'patient_nutrition_report', owner_id: String(snapshot.id), purpose: 'nutrition_report_pdf', status: 'active' });
  const cached = await f.service.generateNutritionMeasurementReportPdf('pac_ficticio', measurement.id, 7);
  assert.equal(cached.cached, true); assert.equal(cached.buffer.toString(), 'private fictitious binary');
});
