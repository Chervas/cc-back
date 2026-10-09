'use strict';
// HTTP adapter assertions are separate from the booking command shared by workers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const controller = fs.readFileSync(require.resolve('../../controllers/citas.controller.js'), 'utf8');
test('HTTP reschedule preserves resources absent from the request', () => {
  assert.match(controller, /nextDoctorIdRaw !== undefined \? \{ doctor_id: nextDoctorId \} : \{\}/);
  assert.match(controller, /nextInstalacionIdRaw !== undefined \? \{ instalacion_id: nextInstalacionId \} : \{\}/);
});
test('HTTP strips client booking snapshots even with gates off or historical registration', () => {
  assert.match(controller, /delete baseImportMetadata\.booking/);
  assert.match(controller, /delete baseImportMetadata\.patient_overlap_confirmation/);
});
test('HTTP forwards force only to the authoritative transaction and uses its safe error payload', () => {
  assert.match(controller, /force: parseBool\(force\)/);
  assert.match(controller, /force: wantsForce/);
  assert.match(controller, /json\(bookingErrorPayload\(err\)\)/);
});
test('HTTP has no adapter for operator-only documentary machinery assignment', () => {
  assert.doesNotMatch(controller, /importEquipmentAssignment|importedEquipmentProfile/);
});

test('HTTP only maps patient overlap confirmation in the authenticated reschedule command, not creation or legacy writes', () => {
  const occurrences = controller.match(/reschedulePatientOverlap:/g) || [];
  assert.equal(occurrences.length, 2); // Single and atomically linked rescheduling.
  const reschedule = controller.slice(controller.indexOf('exports.reagendarCita ='), controller.indexOf('exports.resolveImportedTreatment ='));
  assert.match(reschedule, /if \(await denyAppointmentManageAccessIfNeeded\(req, res, cita.clinica_id\)\) return/);
  assert.match(reschedule, /reschedulePatientOverlap: \{ actorId: Number\(req.userData\?\.userId\),\s*acknowledgement: req.body\?\.patient_overlap_acknowledgement \}/);
  assert(reschedule.indexOf('reschedulePatientOverlap:') > reschedule.indexOf('if (bookingEnabled)'));
  assert(reschedule.indexOf('reschedulePatientOverlap:') < reschedule.indexOf('} else {\n        const changes'));
});

test('linked-source state, requested-change and reschedule endpoints fail closed before legacy writes with flags off', async () => {
  const nativeRequire = createRequire(require.resolve('../../controllers/citas.controller.js'));
  const appointment = { id_cita: 5, clinica_id: 72, paciente_id: 3, voucher_id: 8, estado: 'cambio_solicitado',
    source_system: 'cliniccloud', import_metadata: { program_session: { session_id: 15, key: 's1' } } };
  const exports = {}, context = { exports, CITA_ESTADOS_VALIDOS: new Set(['completada']),
    asyncHandler: fn => fn, CitaPaciente: { findByPk: async () => appointment },
    denyAppointmentManageAccessIfNeeded: async () => false,
    canUserAccessFeature: async () => true,
    require: name => name === '../lib/program-booking' ? { programBookingEnabled: () => false } : nativeRequire(name) };
  for (const [start, finish] of [
    ['exports.updateCitaEstado =', 'exports.resolveRequestedAppointmentChange ='],
    ['exports.resolveRequestedAppointmentChange =', 'exports.deleteCita ='],
    ['exports.reagendarCita =', 'exports.resolveImportedTreatment ='],
  ]) vm.runInNewContext(controller.slice(controller.indexOf(start), controller.indexOf(finish)), context);
  for (const endpoint of ['updateCitaEstado', 'resolveRequestedAppointmentChange', 'reagendarCita']) {
    let response, status;
    const res = { status: code => { status = code; return res; }, json: body => { response = body; return res; } };
    const before = JSON.stringify(appointment);
    await exports[endpoint]({ params: { id: '5' }, body: { estado: 'completada', action: 'keep' }, userData: { userId: 9 } }, res);
    assert.equal(status, 409); assert.equal(response.code, 'program_booking_disabled');
    assert.equal(JSON.stringify(appointment), before);
  }
});

test('linked-source historical cancellation cannot be deleted after its unit has another appointment', async () => {
  const exports = {}, nativeRequire = createRequire(require.resolve('../../controllers/citas.controller.js'));
  const appointment = { id_cita: 5, clinica_id: 72, paciente_id: 3, voucher_id: 8, estado: 'cancelada',
    source_system: 'cliniccloud', import_metadata: { program_session: { session_id: 15, key: 's1' } } };
  let relationReads = 0;
  const context = { exports, asyncHandler: fn => fn, CitaPaciente: { findByPk: async () => appointment },
    denyAppointmentManageAccessIfNeeded: async () => false,
    db: { PatientProgramSession: { findOne: async () => { relationReads++; return null; } } }, require: nativeRequire };
  vm.runInNewContext(controller.slice(controller.indexOf('exports.deleteCita ='), controller.indexOf('exports.reagendarCita =')), context);
  let response, status;
  const res = { status: code => { status = code; return res; }, json: body => { response = body; return res; } };
  await exports.deleteCita({ params: { id: '5' } }, res);
  assert.equal(status, 409); assert.equal(response.code, 'program_history_preserved'); assert.equal(relationReads, 0);
});
