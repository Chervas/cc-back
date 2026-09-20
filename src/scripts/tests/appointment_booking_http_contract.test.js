'use strict';
// HTTP adapter assertions are separate from the booking command shared by workers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const controller = fs.readFileSync(require.resolve('../../controllers/citas.controller.js'), 'utf8');
test('HTTP reschedule preserves resources absent from the request', () => {
  assert.match(controller, /nextDoctorIdRaw !== undefined \? \{ doctor_id: nextDoctorId \} : \{\}/);
  assert.match(controller, /nextInstalacionIdRaw !== undefined \? \{ instalacion_id: nextInstalacionId \} : \{\}/);
});
test('HTTP strips client booking snapshots even with gates off or historical registration', () => {
  assert.match(controller, /delete baseImportMetadata\.booking/);
});
