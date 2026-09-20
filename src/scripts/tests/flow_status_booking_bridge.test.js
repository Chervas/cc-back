'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../services/flowEngineV2.service'), 'utf8');
const start = source.indexOf('\nasync function handleChangeStatus(') + 1;
assert(start > 0);
const rest = source.slice(start);
const end = rest.search(/\n(?:async )?function \w+/);
assert(end > 0);
for (const enabled of [true, false]) test(`automation status writer uses canonical booking only with gate ${enabled}`, async () => {
  let mutations = 0, events = 0, writes = 0; const completed = Error('END_TRANSACTION_TEST');
  const appointment = { id_cita: 1, estado: 'pendiente', async update(values) { Object.assign(this, values); writes++; return this; } };
  const tx = { options: { isolationLevel: 'READ COMMITTED' }, LOCK: { UPDATE: 'UPDATE' } };
  const sandbox = { cleanString: value => value || '', resolveRuntimeTargets: () => ({ appointment_id: 1 }), backfillRuntimeTargets: async (_, targets) => targets,
    resolveTemplateValue: value => value, normalizeCitaStatus: value => value, normalizeLeadStatus: value => value,
    normalizeStatusTarget: value => value, toIntOrNull: value => Number(value) || null, PROTECTED_APPOINTMENT_STATUSES: new Set(),
    CitaPaciente: { findByPk: async () => appointment }, recordAppointmentStatusChange: async () => { events++; },
    db: { sequelize: { transaction: async (options, callback) => { assert.equal(options.isolationLevel, 'READ COMMITTED'); await callback(tx); throw completed; } } },
    require: name => name.endsWith('treatmentBookingProfile.service') ? { bookingCapabilities: () => ({ simple: enabled }) }
      : { mutateAppointmentBooking: async options => { mutations++; assert.equal(options.existingAppointmentId, 1); assert.equal(options.stateOnly, true);
        assert.equal(options.transaction, tx); return options.persist({ existing: appointment, transaction: tx }); } },
  };
  vm.createContext(sandbox); vm.runInContext(rest.slice(0, end), sandbox);
  await assert.rejects(sandbox.handleChangeStatus({ config: { new_status: 'completada', target_entity: 'appointment' } }, {}, {}), error => error === completed);
  assert.equal(mutations, enabled ? 1 : 0); assert.equal(writes, 1); assert.equal(events, 1); assert.equal(appointment.estado, 'completada');
});
