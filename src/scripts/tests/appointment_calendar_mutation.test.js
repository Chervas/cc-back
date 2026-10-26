'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withCalendarMutation, uncoveredPhases, assertDoctorIdentityMutable } = require('../../services/appointmentCalendarMutation.service');
function fixture() {
  let end = '20:00', committed = false, rolledBack = false, calls = [];
  const blocks = [];
  const rows = [{ appointment_id: 1, resource_key: 'doctor:5', doctor_id: 5, installation_id: null,
    start_at: new Date('2026-10-05T10:00:00Z'), end_at: new Date('2026-10-05T10:30:00Z'), appointment: { clinica_id: 72 } }];
  const tx = { options: { isolationLevel: 'READ COMMITTED' }, LOCK: { UPDATE: 'UPDATE' } };
  const db = { Sequelize: { Op: Object.fromEntries(['in', 'gt', 'ne', 'lt', 'or'].map(k => [k, Symbol(k)])) },
    sequelize: { transaction: async (options, callback) => { const before = end; assert.equal(options.isolationLevel, 'READ COMMITTED');
      try { const value = await callback(tx); committed = true; return value; } catch (e) { end = before; rolledBack = true; throw e; } } },
    AppointmentBookingResource: { upsert: async r => calls.push(r.resource_key), findByPk: async () => ({}) },
    AppointmentBookingOccupancy: { findAll: async q => { assert.equal(q.limit, 2001); return rows; } },
    Clinica: { findAll: async () => [{ id_clinica: 72, configuracion: { timezone: 'Europe/Madrid' } }] },
    ClinicaHorario: { findAll: async () => [] },
    DoctorClinica: { findAll: async () => [{ doctor_id: 5, clinica_id: 72, activo: true, recibe_citas: true,
      horarios: [{ dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: end }] }] },
    DoctorBloqueo: { findAll: async () => blocks },
  };
  return { db, rows, blocks, options: { db, doctorId: 5, enabled: true, now: new Date('2026-09-20T12:00:00Z') },
    setEnd: v => { end = v; }, state: () => ({ end, committed, rolledBack, calls }) };
}
test('calendar write locks the same resource and rolls back a newly uncovered reservation', async () => {
  const f = fixture();
  await assert.rejects(withCalendarMutation({ ...f.options, mutate: async tx => { assert.equal(tx.options.isolationLevel, 'READ COMMITTED'); f.setEnd('11:00'); } }), { code: 'booking_calendar_conflict' });
  assert.equal(f.state().rolledBack, true); assert.equal(f.state().end, '20:00'); assert.deepEqual(f.state().calls, ['doctor:5']);
});
test('preserving or extending opening hours commits without blocking an unrelated repair', async () => {
  const f = fixture();
  assert.equal(await withCalendarMutation({ ...f.options, mutate: async () => { f.setEnd('21:00'); return 42; } }), 42);
  assert.equal(f.state().committed, true);
});
test('a recurring block cannot silently hide a phase on a later occurrence', async () => {
  const f = fixture();
  await assert.rejects(withCalendarMutation({ ...f.options, mutate: async () => { f.blocks.push({ doctor_id: 5, recurrente: 'weekly',
    fecha_inicio: new Date('2026-09-28T10:00:00Z'), fecha_fin: new Date('2026-09-28T11:00:00Z'), excepciones: [] }); } }), { code: 'booking_calendar_conflict' });
});
test('closed gate keeps the legacy writer dormant and does not touch the ledger', async () => {
  const db = { sequelize: { transaction: async (options, cb) => cb({ options }) } };
  assert.equal(await withCalendarMutation({ db, doctorId: 5, enabled: false, mutate: async tx => { assert.equal(tx.options.isolationLevel, 'READ COMMITTED'); return 9; } }), 9);
});
test('bounded review rejects excessive reservations before mutation', async () => {
  const f = fixture(); f.db.AppointmentBookingOccupancy.findAll = async () => Array(2001).fill(f.rows[0]);
  await assert.rejects(withCalendarMutation({ ...f.options, mutate: () => { throw Error('must not write'); } }), { code: 'booking_calendar_review_required' });
});
test('pre-existing unavailable reservations do not prevent a change that introduces no new conflict', async () => {
  const f = fixture(); f.setEnd('11:00');
  await withCalendarMutation({ ...f.options, mutate: async () => { f.setEnd('11:30'); } });
  assert.equal(f.state().committed, true);
});
test('clinic opening changes acquire an exclusive clinic lock before the affected resources', async () => {
  const f = fixture(); let hours = [];
  f.db.Clinica.findByPk = async (id, options) => { assert.equal(id, 72); assert.equal(options.lock, 'UPDATE'); f.state().calls.push('clinic:72'); return {}; };
  f.db.ClinicaHorario.findAll = async () => hours;
  await assert.rejects(withCalendarMutation({ ...f.options, doctorId: null, clinicId: 72,
    mutate: async () => { hours = [{ clinica_id: 72, dia_semana: 1, activo: true, hora_inicio: '14:00', hora_fin: '20:00' }]; } }), { code: 'booking_calendar_conflict' });
  assert.deepEqual(f.state().calls, ['clinic:72', 'doctor:5']);
});
test('cabin blocks are checked against reservations using another physical alias', async () => {
  const f = fixture(); let blocks = [];
  const rows = [{ ...f.rows[0], resource_key: 'installation:3', doctor_id: null, installation_id: 8 }];
  f.db.Instalacion = { findAll: async () => [{ id: 8, activo: true, horarios: [{ dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '20:00' }] }] };
  f.db.InstalacionBloqueo = { findAll: async q => { assert.deepEqual(q.where.instalacion_id[f.db.Sequelize.Op.in], [3, 8]); return blocks; } };
  const options = { db: f.db, rows, transaction: {}, installationMapping: { physicalInstallationIds: [3, 8], keys: new Map([[3, 'installation:3'], [8, 'installation:3']]) } };
  assert.equal((await uncoveredPhases(options)).size, 0);
  blocks = [{ instalacion_id: 3, fecha_inicio: rows[0].start_at, fecha_fin: rows[0].end_at }];
  assert.equal((await uncoveredPhases(options)).size, 1);
});
test('a supplied transaction must use the same READ COMMITTED contract', async () => {
  const f = fixture();
  await assert.rejects(withCalendarMutation({ ...f.options, transaction: { options: {} }, mutate: () => {} }), /booking_requires_read_committed/);
});

test('a transfer locks both doctors in canonical order and protects the source reservation in the same transaction', async () => {
  const f = fixture();
  f.db.AppointmentBookingOccupancy.findAll = async query => {
    assert.deepEqual(query.where.resource_key[f.db.Sequelize.Op.in], ['doctor:6', 'doctor:5']);
    return f.rows;
  };
  await assert.rejects(withCalendarMutation({ ...f.options, doctorId: null, doctorIds: [6, 5, 6],
    mutate: async tx => { assert.equal(tx.options.isolationLevel, 'READ COMMITTED'); f.setEnd('11:00'); } }), { code: 'booking_calendar_conflict' });
  assert.deepEqual(f.state().calls, ['doctor:5', 'doctor:6']);
  assert.equal(f.state().rolledBack, true); assert.equal(f.state().end, '20:00');
});
test('a clinic-specific absence does not invalidate the same professional in another clinic', async () => {
  const f = fixture();
  await withCalendarMutation({ ...f.options, mutate: async () => f.blocks.push({ doctor_id: 5, clinica_id: 99,
    recurrente: 'none', fecha_inicio: f.rows[0].start_at, fecha_fin: f.rows[0].end_at }) });
  assert.equal(f.state().committed, true);
});
test('a global absence still protects reservations in every clinic', async () => {
  const f = fixture();
  await assert.rejects(withCalendarMutation({ ...f.options, mutate: async () => f.blocks.push({ doctor_id: 5, clinica_id: null,
    recurrente: 'none', fecha_inicio: f.rows[0].start_at, fecha_fin: f.rows[0].end_at }) }), { code: 'booking_calendar_conflict' });
});
test('a multi-doctor mutation invalidates the calendars of both doctors only after commit', async () => {
  const f = fixture(); const hooks = [], notified = [];
  const run = f.db.sequelize.transaction;
  f.db.sequelize.transaction = (options, callback) => run(options, async tx => {
    tx.afterCommit = hook => hooks.push(hook); return callback(tx);
  });
  await withCalendarMutation({ ...f.options, doctorId: null, doctorIds: [6, 5], realtimeEnabled: true,
    notify: async message => notified.push(message.doctorId), mutate: async () => 42 });
  assert.deepEqual(notified, []); assert.equal(hooks.length, 1);
  await hooks[0](); assert.deepEqual(notified, [6, 5]);
});

test('Personal protects future legacy appointments with the ledger gate closed', async () => {
  const f = fixture(); let ledgerReads = 0;
  f.db.CitaPaciente = { findAll: async query => {
    assert.equal(query.limit, 2001); assert.equal(query.lock, 'UPDATE');
    assert.deepEqual(query.attributes, ['id_cita', 'doctor_id', 'clinica_id', 'inicio', 'fin']);
    return [{ id_cita: 4, doctor_id: 5, clinica_id: 72, inicio: f.rows[0].start_at, fin: f.rows[0].end_at }];
  } };
  f.db.AppointmentBookingOccupancy.findAll = async () => { ledgerReads++; throw Error('closed gate must not read ledger'); };
  await assert.rejects(withCalendarMutation({ ...f.options, enabled: false, protectLegacyAppointments: true,
    mutate: async () => f.setEnd('11:00') }), { code: 'booking_calendar_conflict' });
  assert.equal(ledgerReads, 0); assert.equal(f.state().rolledBack, true); assert.equal(f.state().end, '20:00');
});
test('Personal protects legacy fallback appointments while the ledger gate is open', async () => {
  const f = fixture(); f.db.AppointmentBookingOccupancy.findAll = async () => [];
  f.db.CitaPaciente = { findAll: async () => [{ id_cita: 4, doctor_id: 5, clinica_id: 72,
    inicio: f.rows[0].start_at, fin: f.rows[0].end_at }] };
  await assert.rejects(withCalendarMutation({ ...f.options, protectLegacyAppointments: true,
    mutate: async () => f.setEnd('11:00') }), { code: 'booking_calendar_conflict' });
});
test('canonical phases suppress an unused legacy primary doctor instead of inventing occupancy', async () => {
  const f = fixture(); f.db.CitaPaciente = { findAll: async () => [{ id_cita: 4, doctor_id: 5, clinica_id: 72,
    inicio: f.rows[0].start_at, fin: f.rows[0].end_at }] };
  f.db.AppointmentBookingOccupancy.findAll = async query => query.group ? [{ appointment_id: 4 }] : [];
  await withCalendarMutation({ ...f.options, protectLegacyAppointments: true, mutate: async () => f.setEnd('11:00') });
  assert.equal(f.state().committed, true);
});
test('legacy review is bounded before mutation, including when the gate is closed', async () => {
  const f = fixture(); f.db.CitaPaciente = { findAll: async query => {
    assert.equal(query.limit, 2001); return Array(2001).fill({ id_cita: 4, doctor_id: 5, clinica_id: 72 });
  } };
  let mutated = false;
  await assert.rejects(withCalendarMutation({ ...f.options, enabled: false, protectLegacyAppointments: true,
    mutate: async () => { mutated = true; } }), { code: 'booking_calendar_review_required' });
  assert.equal(mutated, false);
});

function identityFixture() {
  const events = [], holders = new Map(), revisions = new Map(); let shared = false, nextTransaction = 0;
  const lock = async (key, transaction) => {
    while (holders.has(key) && holders.get(key).transaction !== transaction) {
      events.push(`wait:${transaction.id}:${key}`); await holders.get(key).released;
    }
    if (holders.has(key)) return;
    let release; const released = new Promise(resolve => { release = resolve; });
    holders.set(key, { transaction, released }); events.push(`lock:${transaction.id}:${key}`);
    transaction.releases.push(() => { holders.delete(key); release(); });
  };
  const emptyEvidence = table => ({ findOne: async () => { events.push(`evidence:${table}`); return null; } });
  const db = {
    Sequelize: { Op: Object.fromEntries(['in', 'ne', 'or', 'gt'].map(key => [key, Symbol(key)])),
      fn: (...args) => args, col: value => value, where: (...args) => args, literal: value => value },
    sequelize: { escape: value => JSON.stringify(value), transaction: async (options, callback) => {
      const transaction = { id: ++nextTransaction, options, LOCK: { UPDATE: 'UPDATE' }, releases: [] };
      try { return await callback(transaction); }
      finally { for (const release of transaction.releases.reverse()) release(); }
    } },
    AppointmentBookingResource: {
      upsert: async (row, options) => lock(`resource:${row.resource_key}`, options.transaction),
      findByPk: async (key, options) => { await lock(`resource:${key}`, options.transaction); return {}; },
    },
    PersonalCalendarRevision: {
      findOrCreate: async ({ where, transaction }) => {
        await lock(`revision:${where.doctor_id}`, transaction);
        if (!revisions.has(where.doctor_id)) revisions.set(where.doctor_id, { revision: '0', update: async function(values) { Object.assign(this, values); } });
      },
      findByPk: async (id, options) => { if (options.lock) await lock(`revision:${id}`, options.transaction); return revisions.get(id); },
    },
    DoctorClinica: { findOne: async () => { events.push('shared:read'); return shared ? { id: 101 } : null; }, findAll: async () => [] },
    AppointmentBookingOccupancy: { ...emptyEvidence('occupancy'), findAll: async () => [] },
    Tratamiento: emptyEvidence('treatment'), PatientProgramSession: emptyEvidence('program'), EconomicBudgetVersion: emptyEvidence('budget'),
  };
  return { db, events, setShared: () => { shared = true; } };
}

test('identity checks lock both doctors before reading shared calendars or protected evidence', async () => {
  for (const enabled of [true, false]) {
    const f = identityFixture();
    await f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction =>
      assertDoctorIdentityMutable({ db: f.db, doctorIds: [12, 5, 12], transaction, enabled }));
    assert.deepEqual(f.events, [
      ...(enabled ? ['lock:1:resource:doctor:12', 'lock:1:resource:doctor:5'] : []),
      'lock:1:revision:5', 'lock:1:revision:12', 'shared:read',
      ...(enabled ? ['evidence:occupancy', 'evidence:treatment', 'evidence:program', 'evidence:budget'] : []),
    ]);
  }
});

test('identity merge waiting behind a calendar link observes the committed group and rejects in both ledger modes', async () => {
  for (const enabled of [true, false]) {
    const f = identityFixture(); let releaseLink, signalLinkEntered;
    const linkEntered = new Promise(resolve => { signalLinkEntered = resolve; });
    const linkCanCommit = new Promise(resolve => { releaseLink = resolve; });
    const linking = withCalendarMutation({ db: f.db, doctorId: 5, enabled, realtimeEnabled: false,
      mutate: async () => { f.setShared(); signalLinkEntered(); await linkCanCommit; } });
    await linkEntered;
    const merging = f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction =>
      assertDoctorIdentityMutable({ db: f.db, doctorIds: [5, 12], transaction, enabled }));
    // Let the merge reach its blocked mutex while the link still owns it.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.events.includes('shared:read'), false, 'the identity guard must not read before obtaining the mutex');
    assert.ok(f.events.some(event => event.startsWith('wait:2:')));
    releaseLink(); await linking;
    await assert.rejects(merging, { code: 'personal_schedule_sharing_unlink_required' });
    assert.equal(f.events.filter(event => event === 'shared:read').length, 1);
    assert.equal(f.events.some(event => event.startsWith('evidence:')), false);
  }
});

test('identity guard rejects an unsupported isolation level before reading or locking', async () => {
  const f = identityFixture();
  await assert.rejects(assertDoctorIdentityMutable({ db: f.db, doctorIds: [5, 12], transaction: { options: {} }, enabled: true }),
    /booking_requires_read_committed/);
  assert.deepEqual(f.events, []);
});
