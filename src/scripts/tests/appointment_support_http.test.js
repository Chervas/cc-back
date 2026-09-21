'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
const handlerSource = source.slice(source.indexOf('exports.updateCitaSupport ='), source.indexOf('exports.__testing ='));

function fixture({ found = true, denied = false } = {}) {
  const calls = [], exported = {};
  const row = { id_cita: 50, clinica_id: 8, toJSON: () => ({ id_cita: 50 }) };
  const context = { exports: exported, asyncHandler: fn => fn, db: { Usuario: {} },
    Paciente: {}, Clinica: {}, Instalacion: {}, Tratamiento: {},
    CitaPaciente: { findByPk: async id => { calls.push(['read', id]); return found ? row : null; } },
    denyAppointmentManageAccessIfNeeded: async (_req, res, clinic) => {
      calls.push(['authorize', clinic]); if (denied) res.status(403).json({ message: 'No autorizado' }); return denied;
    },
    require: path => { assert.equal(path, '../services/appointmentSupport.service');
      return { changeAppointmentSupport: async args => { calls.push(['write', args]); } }; },
    emitAppointmentSocketEvent: (event, payload) => calls.push(['socket', event, payload]),
    protectAppointmentsForRequest: async (_req, row) => { calls.push(['redact']); return { id_cita: row.id_cita, protected: true }; },
  };
  vm.runInNewContext(handlerSource, context);
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  return { calls, response, run: (id = '50', body = {}) => exported.updateCitaSupport({ params: { id }, body, userData: { userId: 7 } }, response) };
}

test('support route requires authentication and rejects invalid/missing appointments without mutation', async () => {
  const routes = fs.readFileSync(require.resolve('../../routes/citas.routes'), 'utf8');
  assert.match(routes, /router\.patch\('\/:id\/personal-apoyo', authMiddleware, citasController\.updateCitaSupport\)/);
  const invalid = fixture(); await invalid.run('abc');
  assert.equal(invalid.response.statusCode, 400); assert.equal(invalid.calls.length, 0);
  const missing = fixture({ found: false }); await missing.run();
  assert.equal(missing.response.statusCode, 404); assert.equal(missing.calls.length, 1);
});

test('appointment manager scope is checked before support mutation or socket notification', async () => {
  const f = fixture({ denied: true }); await f.run('50', { additional_staff_ids: [12] });
  assert.equal(f.response.statusCode, 403);
  assert.deepEqual(f.calls.map(call => call[0]), ['read', 'authorize']);
  assert.equal(f.calls[1][1], 8);
});

test('support-only HTTP delegates only allowed fields and preserves response privacy', async () => {
  const f = fixture(); await f.run('50', { additional_staff_ids: [12], expected_start: '2026-11-16T10:00Z',
    expected_end: '2026-11-16T10:30Z', estado: 'completada', clinica_id: 99, inicio: '2027-01-01', force: true });
  assert.deepEqual(f.calls.map(call => call[0]), ['read', 'authorize', 'write', 'read', 'socket', 'redact']);
  const args = f.calls[2][1];
  assert.equal(args.actorId, 7); assert.equal(args.appointmentId, 50);
  assert.deepEqual(args.ids, [12]); assert.equal(args.expectedRange.start, '2026-11-16T10:00Z');
  for (const prohibited of ['estado', 'clinica_id', 'inicio', 'force']) assert.equal(args[prohibited], undefined);
  assert.equal(f.calls[4][1], 'appointment:updated'); assert.equal(f.response.body.protected, true);
});

test('canonical support activity is not a rescheduling or status transition', () => {
  const exported = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/appointmentActivity.service'), 'utf8'), {
    module: exported, require: path => { assert.equal(path, '../../models'); return { PatientOperationalEvent: {} }; },
  });
  const activity = exported.exports.serializeAppointmentStatusActivity({ id: 1, event_type: 'appointment.staff_changed',
    actor_user_id: 7, source: 'agenda', occurred_at: '2026-09-21T08:00:00Z',
    metadata: { appointment_id: 50, additional_staff: [{ id: 12, name: 'Profesional ficticio' }], preserves_status_and_schedule: true },
  }, { patientId: 99, actorName: 'QA' });
  assert.equal(activity.tipo, 'appointment_staff_changed'); assert.equal(activity.citaId, '50');
  assert.equal(activity.pacienteId, '99'); assert.equal(activity.usuarioNombre, 'QA');
  assert.match(activity.descripcion, /Profesional ficticio/); assert.match(activity.descripcion, /Se conservan el horario y el estado/);
  assert.equal(activity.detalles.new_status, undefined);
});
