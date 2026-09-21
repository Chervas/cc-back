'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
const handler = source.slice(source.indexOf('exports.resolveImportedTreatment ='), source.indexOf('exports.updateCitaSupport ='));
function fixture({ found = true, managed = true, clinical = true, replayed = false } = {}) {
  const calls = [], exported = {};
  const row = { id_cita: 51, clinica_id: 72, toJSON: () => ({ id_cita: 51 }) };
  const context = { exports: exported, asyncHandler: fn => fn, db: { Usuario: {} }, Paciente: {}, Clinica: {}, Instalacion: {}, Tratamiento: {},
    CitaPaciente: { findByPk: async () => { calls.push('read'); return found ? row : null; } },
    denyAppointmentManageAccessIfNeeded: async (_req, res, id) => { assert.equal(id, 72); calls.push('manage'); if (!managed) res.status(403).json({}); return !managed; },
    canUserAccessFeature: async args => { assert.equal(args.actorId, 7); assert.equal(args.clinicId, 72); assert.equal(args.featureKey, 'patients.sensitive.view'); calls.push('clinical'); return clinical; },
    require: name => { assert.equal(name, '../services/appointmentImportResolution.service'); return {
      resolveImportedTreatment: async args => { calls.push('write'); assert.equal(args.appointmentId, 51);
        assert.equal(args.clinicId, 72); assert.equal(args.actorId, 7); return { replayed }; },
    }; },
    emitAppointmentSocketEvent: name => { assert.equal(name, 'appointment:updated'); calls.push('socket'); },
    protectAppointmentsForRequest: async () => { calls.push('redact'); return { protected: true }; },
  };
  vm.runInNewContext(handler, context);
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { calls, response, run: (id = 51) => exported.resolveImportedTreatment({ params: { id }, body: { clinicId: 999, actorId: 999 }, userData: { userId: 7 } }, response) };
}
test('import-resolution route is authenticated; invalid and missing IDs do not mutate', async () => {
  assert.match(fs.readFileSync(require.resolve('../../routes/citas.routes'), 'utf8'), /router\.patch\('\/:id\/importacion\/tratamiento', authMiddleware, citasController\.resolveImportedTreatment\)/);
  const f = fixture(); await f.run('bad'); assert.equal(f.response.statusCode, 400); assert.deepEqual(f.calls, []);
  const missing = fixture({ found: false }); await missing.run(); assert.equal(missing.response.statusCode, 404);
});
test('both appointment management and clinical access are required in the stored clinic', async () => {
  for (const denied of [{ managed: false }, { clinical: false }]) {
    const f = fixture(denied); await f.run(); assert.equal(f.response.statusCode, 403); assert(!f.calls.includes('write')); assert(!f.calls.includes('socket'));
  }
});
test('normal refresh and private response use canonical paths; retry does not emit twice', async () => {
  const f = fixture(); await f.run(); assert.deepEqual(f.calls, ['read', 'manage', 'clinical', 'write', 'read', 'socket', 'redact']);
  assert.equal(f.response.body.protected, true);
  const retry = fixture({ replayed: true }); await retry.run(); assert(!retry.calls.includes('socket')); assert(retry.calls.includes('redact'));
});
test('import resolution uses a distinct operational activity, not a reschedule or clinical completion', () => {
  const exported = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/appointmentActivity.service'), 'utf8'), {
    module: exported, require: () => ({ PatientOperationalEvent: {} }),
  });
  const value = exported.exports.serializeAppointmentStatusActivity({ id: 2, event_type: 'appointment.import_resolved',
    actor_user_id: 7, metadata: { appointment_id: 51, mode: 'no_treatment', reason: 'Only a review' } }, { patientId: 8 });
  assert.equal(value.tipo, 'appointment_import_resolved'); assert.equal(value.citaId, '51');
  assert.equal(value.detalles.new_status, undefined); assert.match(value.descripcion, /sin tratamiento/);
});
