'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, clone } = require('./fixtures/personal_calendar_undo_ram.cjs');
const { withCalendarMutation } = require('../../services/appointmentCalendarMutation.service');
const undoService = require('../../services/personalCalendarUndo.service');
const undo = (f, token, extra = {}) => undoService.undoAvailability({ db: f.db, actorId: 1, token, now: f.now,
  assertPermissions: async () => true, calendarOptions: f.options(), ...extra });
const createShift = f => withCalendarMutation({ ...f.options(), undoContext: { actorId: 1, now: f.now }, mutate: transaction =>
  f.db.DoctorHorario.create({ doctor_clinica_id: 201, dia_semana: 1, activo: true, hora_inicio: '12:00', hora_fin: '16:00', rrule: null }, { transaction }) });
test('a durable receipt hashes its token, has 20-second TTL and undoes creation without changing appointments', async () => {
  const f = fixture(), before = clone(f.state().DoctorHorario);
  const result = await createShift(f); assert.ok(result.undo?.token); assert.equal(result.undo.token.length, 43);
  const receipt = f.state().PersonalCalendarUndoReceipt[0];
  assert.equal(receipt.token_hash.length, 64); assert.notEqual(receipt.token_hash, result.undo.token);
  assert.equal(new Date(receipt.expires_at) - f.now(), 20000); assert.equal(JSON.stringify(receipt).includes(result.undo.token), false);
  assert.equal(Object.hasOwn(receipt.before_state, 'CitaPaciente'), false); assert.equal(Object.hasOwn(receipt.after_state, 'AppointmentBookingOccupancy'), false);
  assert.equal((await undo(f, result.undo.token)).undone, true);
  assert.deepEqual(f.state().DoctorHorario, before); assert.ok(f.state().PersonalCalendarUndoReceipt[0].consumed_at);
  assert.equal(f.state().PersonalCalendarRevision[0].revision, '2');
  await assert.rejects(undo(f, result.undo.token), { code: 'availability_undo_consumed' });
});
test('expiry, actor mismatch and permission revocation reject undo without a write', async () => {
  for (const kind of ['expired', 'actor', 'permission']) {
    const f = fixture(), result = await createShift(f), before = clone(f.state());
    if (kind === 'expired') f.advance(20000);
    await assert.rejects(undo(f, result.undo.token, kind === 'actor' ? { actorId: 2 }
      : kind === 'permission' ? { assertPermissions: async () => false } : {}),
    { code: kind === 'expired' ? 'availability_undo_expired' : kind === 'actor' ? 'availability_undo_not_found' : 'availability_undo_forbidden' });
    assert.deepEqual(f.state(), before);
  }
});
test('exact post-state CAS rejects external edits and revision CAS rejects ABA after another calendar mutation', async () => {
  for (const aba of [false, true]) {
    const f = fixture(), result = await createShift(f);
    if (aba) {
      await withCalendarMutation({ ...f.options(), mutate: async () => { f.state().DoctorHorario[1].hora_fin = '17:00'; } });
      await withCalendarMutation({ ...f.options(), mutate: async () => { f.state().DoctorHorario[1].hora_fin = '16:00'; } });
    } else f.state().DoctorHorario[1].hora_fin = '17:00';
    const before = clone(f.state()); await assert.rejects(undo(f, result.undo.token), { code: 'availability_undo_conflict' });
    assert.deepEqual(f.state(), before);
  }
});
test('a newly booked ledger or legacy appointment blocks undo of added availability and rolls everything back', async () => {
  for (const ledger of [true, false]) {
    const f = fixture(), result = await createShift(f);
    f.state().CitaPaciente.push({ id_cita: 88, doctor_id: 2, clinica_id: 10, estado: 'confirmada', inicio: '2027-01-04T13:00:00Z', fin: '2027-01-04T14:00:00Z' });
    if (ledger) f.state().AppointmentBookingOccupancy.push({ id: 1, appointment_id: 88, resource_key: 'doctor:2', doctor_id: 2,
      start_at: '2027-01-04T13:00:00Z', end_at: '2027-01-04T14:00:00Z' });
    const before = clone(f.state());
    await assert.rejects(undo(f, result.undo.token), { code: 'booking_calendar_conflict' });
    assert.deepEqual(f.state(), before); assert.equal(f.state().PersonalCalendarUndoReceipt[0].consumed_at, null);
  }
});
test('undo restores deleted pattern IDs and exceptions while leaving an unrelated clinic untouched', async () => {
  const f = fixture();
  f.state().DoctorHorarioExcepcion.push({ id: 900, doctor_horario_id: 100, fecha: '2027-01-11', cancelado: true });
  f.state().DoctorClinica.push({ id: 202, doctor_id: 2, clinica_id: 20, activo: true, recibe_citas: false, agenda_flexible: true });
  f.state().DoctorHorario.push({ id: 101, doctor_clinica_id: 202, dia_semana: 2, activo: true, hora_inicio: '10:00', hora_fin: '11:00', rrule: null });
  const unrelatedLink = clone(f.state().DoctorClinica[1]);
  const old = clone(f.state().DoctorHorario), exceptions = clone(f.state().DoctorHorarioExcepcion);
  const result = await withCalendarMutation({ ...f.options(), undoContext: { actorId: 1, now: f.now },
    mutate: transaction => f.db.DoctorHorario.destroy({ where: { id: 100 }, transaction }) });
  assert.equal(f.state().DoctorHorario.length, 1);
  await undo(f, result.undo.token); assert.deepEqual(f.state().DoctorHorario.sort((a, b) => a.id - b.id), old); assert.deepEqual(f.state().DoctorHorarioExcepcion, exceptions);
  assert.deepEqual(f.state().DoctorClinica[1], unrelatedLink);
});

test('undo restores availability after creation on a new or inactive pivot without rewriting agenda configuration', async () => {
  for (const newLink of [true, false]) {
    const f = fixture(); f.state().DoctorHorario = [];
    if (newLink) f.state().DoctorClinica = [];
    else Object.assign(f.state().DoctorClinica[0], { activo: false, recibe_citas: false, agenda_flexible: true, allow_overlap_confirmation: true, rol_en_clinica: 'staff' });
    const original = clone(f.state().DoctorClinica);
    const result = await withCalendarMutation({ ...f.options(), undoContext: { actorId: 1, now: f.now }, mutate: async transaction => {
      if (newLink) await f.db.DoctorClinica.create({ id: 201, doctor_id: 2, clinica_id: 10, activo: true, recibe_citas: false }, { transaction });
      else await f.db.DoctorClinica.update({ activo: true }, { where: { id: 201 }, transaction });
      return f.db.DoctorHorario.create({ doctor_clinica_id: 201, dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '12:00', rrule: null }, { transaction });
    } });
    const update = f.db.DoctorClinica.update;
    f.db.DoctorClinica.update = async (fields, query) => { assert.deepEqual(Object.keys(fields), ['activo']); return update(fields, query); };
    await undo(f, result.undo.token);
    assert.deepEqual(f.state().DoctorClinica, original); assert.equal(f.state().DoctorHorario.length, 0);
  }
});

test('a later agenda configuration change invalidates the receipt and is never undone', async () => {
  const f = fixture(), result = await createShift(f);
  await withCalendarMutation({ ...f.options(), mutate: transaction => f.db.DoctorClinica.update({ recibe_citas: false, allow_overlap_confirmation: true }, { where: { id: 201 }, transaction }) });
  const before = clone(f.state());
  await assert.rejects(undo(f, result.undo.token), { code: 'availability_undo_conflict' });
  assert.deepEqual(f.state(), before);
});

test('durable doctor locks exist before mutation and snapshots even with no pivot and the ledger gate closed', async () => {
  for (const protectLegacyAppointments of [true, false]) {
    const f = fixture(); f.state().DoctorClinica = []; f.state().DoctorHorario = [];
    const events = [], findByPk = f.db.PersonalCalendarRevision.findByPk;
    f.db.PersonalCalendarRevision.findByPk = async (id, options) => { assert.equal(options.lock, f.tx.LOCK.UPDATE); events.push(`lock:${id}`); return findByPk(id, options); };
    const findAll = f.db.DoctorClinica.findAll;
    f.db.DoctorClinica.findAll = async query => { if (query.attributes?.includes('recibe_citas')) events.push('snapshot'); return findAll(query); };
    await withCalendarMutation({ ...f.options(), doctorId: null, doctorIds: [3, 2], enabled: false, protectLegacyAppointments,
      undoContext: { actorId: 1, now: f.now }, mutate: async () => { events.push('mutate'); } });
    const boundary = events.indexOf(protectLegacyAppointments ? 'snapshot' : 'mutate');
    assert.deepEqual(events.slice(0, boundary), ['lock:2', 'lock:3']);
    assert.equal(f.state().PersonalCalendarRevision.length, 2);
  }
});

test('legacy mode only emits receipts whose inverse provably keeps or adds availability', async () => {
  const f = fixture();
  const added = await withCalendarMutation({ ...f.options(), enabled: false, undoContext: { actorId: 1, now: f.now },
    mutate: transaction => f.db.DoctorHorario.create({ doctor_clinica_id: 201, dia_semana: 1, activo: true, hora_inicio: '12:00', hora_fin: '16:00', rrule: null }, { transaction }) });
  assert.equal(added.undo, null); assert.equal(f.state().PersonalCalendarUndoReceipt.length, 0);
  const deleted = await withCalendarMutation({ ...f.options(), enabled: false, undoContext: { actorId: 1, now: f.now },
    mutate: transaction => f.db.DoctorHorario.destroy({ where: { id: 100 }, transaction }) });
  assert.ok(deleted.undo?.token);
  await undo(f, deleted.undo.token, { calendarOptions: { ...f.options(), enabled: false } });
  assert.ok(f.state().DoctorHorario.some(row => row.id === 100));
  const block = await withCalendarMutation({ ...f.options(), enabled: false, undoContext: { actorId: 1, now: f.now },
    mutate: transaction => f.db.DoctorBloqueo.create({ id: 50, doctor_id: 2, clinica_id: 10, fecha_inicio: '2027-01-04T09:00:00Z',
      fecha_fin: '2027-01-04T10:00:00Z', recurrente: 'none' }, { transaction }) });
  assert.ok(block.undo?.token);
  await undo(f, block.undo.token, { calendarOptions: { ...f.options(), enabled: false } });
  assert.equal(f.state().DoctorBloqueo.length, 0);
});

test('a change to legacy booking mode rejects unsafe undo before restoration and preserves its receipt', async () => {
  const f = fixture(), result = await createShift(f), before = clone(f.state());
  await assert.rejects(undo(f, result.undo.token, { calendarOptions: { ...f.options(), enabled: false } }), { code: 'availability_undo_legacy_unsafe' });
  assert.deepEqual(f.state(), before); assert.equal(f.state().PersonalCalendarUndoReceipt[0].consumed_at, null);
  await undo(f, result.undo.token); assert.ok(f.state().PersonalCalendarUndoReceipt[0].consumed_at);
});

test('legacy safety classification fails closed for removed capacity, block restoration, overrides and changed patterns', () => {
  const classify = (table, before, after, extra = {}) => undoService.undoMayReduceAvailability({
    ...Object.fromEntries(Object.keys(undoService.TABLES).map(name => [name, []])),
    [table]: [{ id: (before || after).id, before, after }], ...extra });
  const shift = { id: 1, doctor_clinica_id: 20, dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '12:00', rrule: null };
  assert.equal(classify('DoctorHorario', null, shift), true);
  assert.equal(classify('DoctorHorario', shift, null), false);
  assert.equal(classify('DoctorHorario', shift, { ...shift, hora_fin: '13:00' }), true);
  assert.equal(classify('DoctorHorario', shift, { ...shift, hora_inicio: '10:00' }), false);
  assert.equal(classify('DoctorHorario', shift, { ...shift, dia_semana: 2 }), true);
  assert.equal(classify('DoctorHorario', shift, { ...shift, rrule: 'FREQ=WEEKLY;COUNT=2' }), true);
  assert.equal(classify('DoctorHorario', shift, { ...shift, hora_inicio: 'invalid' }), true);
  const link = { id: 20, doctor_id: 2, clinica_id: 10, activo: true, recibe_citas: true };
  assert.equal(classify('DoctorClinica', null, link), true);
  assert.equal(classify('DoctorClinica', { ...link, activo: false }, link), true);
  assert.equal(classify('DoctorClinica', link, { ...link, activo: false }), false);
  const exception = { id: 3, doctor_horario_id: 1, fecha: '2027-01-04', cancelado: true };
  assert.equal(classify('DoctorHorarioExcepcion', null, exception), false);
  assert.equal(classify('DoctorHorarioExcepcion', exception, null), true);
  assert.equal(classify('DoctorHorarioExcepcion', exception, null, { DoctorHorario: [{ id: 1, before: shift, after: null }] }), false);
  assert.equal(classify('DoctorHorarioExcepcion', null, { ...exception, cancelado: false, hora_inicio_override: '08:00' }), true);
  const block = { id: 4, doctor_id: 2, fecha_inicio: '2027-01-04T09:00:00Z', fecha_fin: '2027-01-04T10:00:00Z', recurrente: 'weekly', recurrente_hasta: null };
  assert.equal(classify('DoctorBloqueo', null, block), false);
  assert.equal(classify('DoctorBloqueo', block, null), true);
  assert.equal(classify('DoctorBloqueo', block, { ...block, motivo: 'changed note' }), false);
  assert.equal(classify('DoctorBloqueo', block, { ...block, recurrente_hasta: '2027-01-31' }), true);
  const cancelBlock = { id: 5, doctor_bloqueo_id: 4, fecha: '2027-01-04', cancelado: true };
  assert.equal(classify('DoctorBloqueoExcepcion', null, cancelBlock), true);
  assert.equal(classify('DoctorBloqueoExcepcion', cancelBlock, null), false);
  assert.equal(classify('DoctorBloqueoExcepcion', null, cancelBlock, { DoctorBloqueo: [{ id: 4, before: null, after: block }] }), false);
  assert.equal(classify('DoctorBloqueoExcepcion', { ...cancelBlock, cancelado: false }, cancelBlock), true);
  assert.equal(classify('DoctorBloqueoExcepcion', { ...cancelBlock, cancelado: null }, { ...cancelBlock, cancelado: false }), true);
});
test('a failure during restoration or final validation rolls back receipt consumption and all rows', async () => {
  const f = fixture(), result = await createShift(f), before = clone(f.state());
  await assert.rejects(undo(f, result.undo.token, { validateRestored: async () => { throw Error('synthetic restored validation failure'); } }), /synthetic restored/);
  assert.deepEqual(f.state(), before);
  await undo(f, result.undo.token); assert.ok(f.state().PersonalCalendarUndoReceipt[0].consumed_at);
});
test('expiry during final validation rolls back instead of committing after its deadline', async () => {
  const f = fixture(), result = await createShift(f), before = clone(f.state());
  await assert.rejects(undo(f, result.undo.token, { validateRestored: async () => f.advance(20001) }), { code: 'availability_undo_expired' });
  assert.deepEqual(f.state(), before);
});

test('a failure after receipt consumption rolls back consumption, restored rows and the revision together', async () => {
  const f = fixture(), result = await createShift(f), before = clone(f.state());
  const findByPk = f.db.PersonalCalendarRevision.findByPk;
  let observedConsumed = false;
  f.db.PersonalCalendarRevision.findByPk = async (...args) => {
    const row = await findByPk(...args);
    row.update = async () => { observedConsumed = Boolean(f.state().PersonalCalendarUndoReceipt[0].consumed_at); throw Error('synthetic revision write failure'); };
    return row;
  };
  await assert.rejects(undo(f, result.undo.token), /synthetic revision write failure/);
  assert.equal(observedConsumed, true); assert.deepEqual(f.state(), before);
});

test('undo of cross-doctor movement restores the same ID before removing its created destination link', async () => {
  const f = fixture(); const original = clone(f.state().DoctorHorario);
  const result = await withCalendarMutation({ ...f.options(), doctorId: null, doctorIds: [2, 3], undoContext: { actorId: 1, now: f.now },
    mutate: async transaction => {
      await f.db.DoctorClinica.create({ id: 302, doctor_id: 3, clinica_id: 20, activo: true, recibe_citas: true }, { transaction });
      await f.db.DoctorHorario.update({ doctor_clinica_id: 302 }, { where: { id: 100 }, transaction });
    } });
  const destroy = f.db.DoctorClinica.destroy;
  f.db.DoctorClinica.destroy = async query => {
    const ids = query.where.id[f.db.Sequelize.Op.in];
    assert.equal(f.state().DoctorHorario.some(row => ids.includes(row.doctor_clinica_id)), false, 'foreign key still referenced');
    return destroy(query);
  };
  const scopes = [];
  await undo(f, result.undo.token, { assertPermissions: async values => { scopes.push(...values); return true; } });
  assert.deepEqual(f.state().DoctorHorario, original); assert.equal(f.state().DoctorClinica.length, 1);
  assert.deepEqual([...new Set(scopes.map(scope => scope.doctorId))].sort(), [2, 3]);
});
test('undo restores deleted blocks and their exceptions but a new booking can forbid the restoration', async () => {
  for (const newBooking of [false, true]) {
    const f = fixture(); f.state().DoctorBloqueo.push({ id: 50, doctor_id: 2, clinica_id: 10,
      fecha_inicio: new Date('2027-01-04T09:00:00Z'), fecha_fin: new Date('2027-01-04T10:00:00Z'), recurrente: 'none', motivo: 'Ficticio' });
    f.state().DoctorBloqueoExcepcion.push({ id: 51, doctor_bloqueo_id: 50, fecha: '2027-01-11', cancelado: true });
    const beforeBlocks = clone(f.state().DoctorBloqueo), beforeExceptions = clone(f.state().DoctorBloqueoExcepcion);
    const result = await withCalendarMutation({ ...f.options(), undoContext: { actorId: 1, now: f.now },
      mutate: transaction => f.db.DoctorBloqueo.destroy({ where: { id: 50 }, transaction }) });
    if (newBooking) {
      f.state().CitaPaciente.push({ id_cita: 77, doctor_id: 2, clinica_id: 10, estado: 'confirmada', inicio: '2027-01-04T09:00:00Z', fin: '2027-01-04T09:30:00Z' });
      const before = clone(f.state()); await assert.rejects(undo(f, result.undo.token), { code: 'booking_calendar_conflict' });
      assert.deepEqual(f.state(), before);
    } else {
      await undo(f, result.undo.token);
      // SQL JSON stores timestamps as ISO strings; preserve their exact instants.
      assert.deepEqual(JSON.parse(JSON.stringify(f.state().DoctorBloqueo)), JSON.parse(JSON.stringify(beforeBlocks)));
      assert.deepEqual(f.state().DoctorBloqueoExcepcion, beforeExceptions);
    }
  }
});
