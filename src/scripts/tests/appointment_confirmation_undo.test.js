'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { createAppointmentConfirmationUndoService, READY, UNDONE, fingerprint } = require('../../services/appointmentConfirmationUndo.service');
const copy = value => JSON.parse(JSON.stringify(value));
const base = (id = 11) => ({ id_cita: id, clinica_id: 72, paciente_id: 7, estado: 'info_enviada',
  inicio: '2026-10-16T14:30:00.000Z', fin: '2026-10-16T15:30:00.000Z', updated_at: '2026-10-16T10:00:00.000Z',
  nota: null, import_metadata: {}, updated_by: 2, es_provisional: false, care_legacy_attendance: false,
  arrived_at: null, arrived_by: null, care_started_at: null, care_started_by: null, care_completed_at: null,
  care_completed_by: null, care_schedule_start: null });
function fixture({ linked = false } = {}) {
  let values = new Map([[11, base()], ...(linked ? [[12, base(12)]] : [])]), events = [], careEvents = [], reports = [];
  let clock = new Date('2026-10-16T10:00:00.000Z'), revision = 1, nextId = 1;
  const wrap = id => values.has(Number(id)) ? Object.assign({}, values.get(Number(id)), {
    toJSON() { return copy(values.get(Number(id))); },
    async update(patch) { Object.assign(values.get(Number(id)), patch); Object.assign(this, patch); return this; },
  }) : null;
  const db = { Sequelize: { Op }, sequelize: { async transaction(options, work) {
    const before = { values: copy([...values]), events: copy(events), careEvents: copy(careEvents), nextId };
    try { return await work({ options, LOCK: { UPDATE: 'UPDATE' } }); }
    catch (error) { values = new Map(before.values); events = before.events; careEvents = before.careEvents; nextId = before.nextId; throw error; }
  } }, CitaPaciente: { rawAttributes: Object.fromEntries(Object.keys(base()).map(key => [key, {}])), findByPk: async id => wrap(id) },
  AppointmentClinicalReport: { findOne: async ({ where }) => reports.find(row => row.appointment_id === where.appointment_id) || null },
  AppointmentCareEvent: { create: async row => { careEvents.push(copy(row)); return row; } },
  PatientOperationalEvent: {
    create: async row => { const saved = { id: nextId++, ...copy(row) }; events.push(saved); return saved; },
    findByPk: async id => events.find(row => row.id === Number(id)) || null,
    findAll: async ({ where }) => events.filter(row => row.clinic_id === where.clinic_id && row.patient_id === where.patient_id
      && row.id > where.id[Op.gt] && where.event_type[Op.in].includes(row.event_type)),
  } };
  let failAudit = false;
  const service = createAppointmentConfirmationUndoService({ db, now: () => clock,
    loadLinkedGroup: async () => linked ? { link: { id: 'linked', revision }, rows: [wrap(11), wrap(12)] } : null,
    recordStatusChange: async args => {
      if (failAudit) throw Error('injected_audit_failure');
      return db.PatientOperationalEvent.create({ clinic_id: args.appointment.clinica_id, patient_id: args.appointment.paciente_id,
        actor_user_id: args.actorUserId, event_type: 'appointment.status_changed', source: 'agenda',
        metadata: { appointment_id: args.appointment.id_cita, previous_status: args.previousStatus, new_status: args.newStatus, ...args.metadata } });
    } });
  const arrive = async () => db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const before = copy(values.get(11));
    Object.assign(values.get(11), { estado: 'ha_acudido', arrived_at: clock.toISOString(), arrived_by: 9,
      care_schedule_start: before.inicio, updated_by: 9 });
    return service.record({ appointment: wrap(11), beforeRows: [before], changedRows: [wrap(11)], actorId: 9, transaction });
  });
  return { db, service, arrive, row: id => values.get(id), events: () => events, careEvents: () => careEvents,
    reports, setClock: value => { clock = new Date(value); }, changeRevision: () => revision++, failAudit: () => { failAudit = true; },
    undo: receipt => service.undo({ appointmentId: 11, changeId: receipt.change_id, clinicId: 72, actorId: 9 }) };
}

test('arrival undo restores the exact prior status and evidence without rewriting the original receipt', async () => {
  const f = fixture(), original = copy(f.row(11)), receipt = await f.arrive(), savedReceipt = copy(f.events().find(row => row.event_type === READY));
  assert.equal(receipt.affected_count, 1); assert.equal(receipt.duration_ms, 20000);
  assert.equal(+new Date(receipt.expires_at) - +new Date('2026-10-16T10:00:00Z'), 30000);
  const result = await f.undo(receipt);
  assert.equal(result.rows.length, 1); assert.equal(result.appointment.estado, 'info_enviada');
  assert.equal(f.row(11).arrived_at, null); assert.equal(f.row(11).arrived_by, null); assert.equal(f.row(11).care_schedule_start, null);
  assert.equal(f.row(11).nota, original.nota); assert.deepEqual(f.row(11).import_metadata, original.import_metadata);
  assert.equal(f.careEvents().length, 1); assert.equal(f.careEvents()[0].action, 'arrival_corrected');
  assert.deepEqual(f.events().find(row => row.event_type === READY), savedReceipt);
  assert.equal(f.events().filter(row => row.event_type === UNDONE).length, 1);
  await assert.rejects(f.undo(receipt), { code: 'appointment_confirmation_undo_used' });
});

test('receipt is bound to actor, appointment and clinic', async () => {
  const f = fixture(), receipt = await f.arrive();
  for (const change of [{ actorId: 10 }, { appointmentId: 12 }, { clinicId: 66 }]) {
    await assert.rejects(f.service.undo({ appointmentId: 11, clinicId: 72, actorId: 9, changeId: receipt.change_id, ...change }),
      { code: 'appointment_confirmation_undo_forbidden', statusCode: 403 });
  }
  assert.equal(f.row(11).estado, 'ha_acudido');
});

test('receipt expires at the exact server deadline', async () => {
  const f = fixture(), receipt = await f.arrive(); f.setClock(receipt.expires_at);
  await assert.rejects(f.undo(receipt), { code: 'appointment_confirmation_undo_expired' });
  assert.equal(f.careEvents().length, 0); assert.equal(f.row(11).estado, 'ha_acudido');
});

for (const patch of [{ nota: 'later edit' }, { inicio: '2026-10-16T15:00:00Z' }, { estado: 'recordatorio_confirmado' },
  { care_started_at: '2026-10-16T10:00:01Z' }, { care_completed_at: '2026-10-16T10:00:01Z' }, { import_metadata: { edited: true } }]) {
  test(`later changes refuse the inverse atomically: ${Object.keys(patch).join(',')}`, async () => {
    const f = fixture(), receipt = await f.arrive(); Object.assign(f.row(11), patch);
    await assert.rejects(f.undo(receipt), { code: 'appointment_confirmation_undo_changed' });
    assert.equal(f.events().filter(row => row.event_type === UNDONE).length, 0); assert.equal(f.careEvents().length, 0);
  });
}

test('an unsigned saved clinical report blocks undo without modifying its history', async () => {
  const f = fixture(), receipt = await f.arrive(); f.reports.push({ appointment_id: 11, status: 'draft' });
  await assert.rejects(f.undo(receipt), { code: 'appointment_confirmation_undo_changed' });
  assert.equal(f.row(11).estado, 'ha_acudido'); assert.equal(f.careEvents().length, 0);
});

test('a later audit prevents same-value reconfirm or care replay from being erased', async () => {
  const f = fixture(), receipt = await f.arrive();
  await f.db.PatientOperationalEvent.create({ clinic_id: 72, patient_id: 7, event_type: 'appointment.status_changed', metadata: { appointment_id: 11 } });
  await assert.rejects(f.undo(receipt), { code: 'appointment_confirmation_undo_changed' });
});

test('linked arrival changes only the selected row, with stable JSON key order and unchanged peers guarded', async () => {
  const f = fixture({ linked: true }), peer = copy(f.row(12)), receipt = await f.arrive();
  const ready = f.events().find(row => row.event_type === READY);
  ready.metadata.linked_group = { members: [11, 12], revision: 1, id: 'linked' }; // MySQL binary JSON key ordering.
  await f.undo(receipt); assert.deepEqual(f.row(12), peer); assert.equal(f.careEvents().length, 1);
  for (const change of ['peer', 'membership']) {
    const g = fixture({ linked: true }), next = await g.arrive();
    if (change === 'peer') g.row(12).nota = 'changed peer'; else g.changeRevision();
    await assert.rejects(g.undo(next), { code: 'appointment_confirmation_undo_changed' });
  }
});

test('audit failure rolls back status, care correction and consumption together', async () => {
  const f = fixture(), receipt = await f.arrive(), row = copy(f.row(11)), events = copy(f.events()); f.failAudit();
  await assert.rejects(f.undo(receipt), /injected_audit_failure/);
  assert.deepEqual(f.row(11), row); assert.deepEqual(f.events(), events); assert.equal(f.careEvents().length, 0);
});

test('row fingerprints cover every native field and canonicalize JSON key order', () => {
  const f = fixture(), before = copy(f.row(11)); before.import_metadata = { b: 2, a: 1 };
  const reordered = { ...before, import_metadata: { a: 1, b: 2 } };
  assert.equal(fingerprint(f.db, before), fingerprint(f.db, reordered));
  assert.notEqual(fingerprint(f.db, before), fingerprint(f.db, { ...before, nota: 'changed' }));
});

test('already arrived, clinical and no-op before states do not issue an undo receipt', async () => {
  for (const patch of [{ estado: 'ha_acudido' }, { arrived_at: '2026-10-16T09:59:00Z' }, { care_started_at: '2026-10-16T09:59:00Z' },
    { care_legacy_attendance: true }, { estado: 'cancelada' }, { estado: 'en_atencion' }]) {
    const f = fixture(); Object.assign(f.row(11), patch); assert.equal(await f.arrive(), null);
  }
});
