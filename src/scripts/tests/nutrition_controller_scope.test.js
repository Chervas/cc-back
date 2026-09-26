'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const [action, service, actorPosition] of [
  ['getPatientNutritionWorkspace', 'getPatientNutritionWorkspace', 1],
  ['createPatientNutritionMeasurement', 'createNutritionMeasurement', 2],
  ['listPatientNutritionMeasurementPhotos', 'listNutritionMeasurementClinicalPhotos', 2],
  ['createPatientNutritionMeasurementPhoto', 'addNutritionMeasurementClinicalPhoto', 3],
  ['getPatientNutritionMeasurementPhoto', 'readNutritionMeasurementClinicalPhoto', 3],
  ['renderPatientNutritionMeasurementReport', 'renderNutritionMeasurementReport', 2],
  ['createPatientNutritionMeasurementReportSnapshot', 'createNutritionMeasurementReportSnapshot', 2],
  ['finalizePatientNutritionMeasurementReport', 'finalizeNutritionMeasurementReportSnapshot', 2],
  ['getPatientNutritionMeasurementReportPdf', 'generateNutritionMeasurementReportPdf', 2],
]) test(`${action} uses only the authenticated actor, including all binary endpoints`, async () => {
  let args;
  const fakeService = { [service]: async (...received) => {
    args = received;
    if (service.includes('readNutrition')) return { asset: { id: 1 }, buffer: Buffer.from('fictitious'), contentType: 'image/png' };
    if (service.includes('Pdf')) return { buffer: Buffer.from('fictitious'), filename: 'fictitious.pdf' };
    return {};
  } };
  const filename = path.resolve(__dirname, '../../controllers/nutritionWorkspace.controller.js');
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { Buffer })(
    name => name === 'express-async-handler' ? fn => fn : fakeService, module, module.exports);
  const req = { userData: { userId: 7 }, params: { id: 'fictitious', measurementId: '1', photoId: '1' },
    query: { clinic_id: '20', actorUserId: '999', readableClinicIds: [30] }, body: { actorUserId: 999, clinic_id: 20 } };
  const res = { status() { return this; }, json() {}, send() {}, setHeader() {} };
  await module.exports[action](req, res);
  assert.equal(typeof args[actorPosition] === 'object' ? args[actorPosition].actorUserId : args[actorPosition], 7);
  if (typeof args[actorPosition] === 'object') assert.equal(args[actorPosition].readableClinicIds, undefined);
  if (action === 'getPatientNutritionWorkspace') assert.equal(args[1].clinicId, '20');
});
