'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { decorate } = require('../../services/appointmentPatientLinks.service');
const inOperator = Symbol('in');
function fixture() {
  const rows = [
    { id_cita: 1, paciente_id: 77, clinica_id: 72, tratamiento_id: 11, inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:15:00Z' },
    { id_cita: 2, paciente_id: 77, clinica_id: 72, tratamiento_id: 12, inicio: '2030-01-07T10:15:00Z', fin: '2030-01-07T10:30:00Z' },
    { id_cita: 3, paciente_id: 78, clinica_id: 66, tratamiento_id: null, inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:15:00Z' },
    { id_cita: 4, paciente_id: 78, clinica_id: 66, tratamiento_id: 11, inicio: '2030-01-07T10:15:00Z', fin: '2030-01-07T10:30:00Z' },
  ];
  const memberships = rows.map(row => ({ appointment_id: row.id_cita, link_id: row.id_cita < 3 ? 'a' : 'b' }));
  const calls = [];
  const db = {
    Sequelize: { Op: { in: inOperator } },
    AppointmentPatientLinkMember: {
      findAll: async ({ where }) => memberships.filter(member => where.link_id ? member.link_id === where.link_id : where.appointment_id[inOperator].includes(member.appointment_id)),
      findByPk: async id => memberships.find(member => member.appointment_id === id),
    },
    AppointmentPatientLink: { findByPk: async id => ({ id, clinic_id: id === 'a' ? 72 : 66, patient_id: id === 'a' ? 77 : 78,
      owner_appointment_id: id === 'a' ? 1 : 3, revision: 1 }) },
    CitaPaciente: { findByPk: async id => rows.find(row => row.id_cita === id) },
    Tratamiento: { findAll: async options => {
      calls.push(options); return [{ id_tratamiento: 11, nombre: 'Extracción PRP' }, { id_tratamiento: 12, nombre: 'Infiltración PRP' }];
    } },
  };
  return { db, rows, calls };
}
test('one bounded treatment-label read describes every validated linked appointment, including members outside the loaded page', async () => {
  const f = fixture(), before = JSON.stringify(f.rows);
  const loaded = [{ ...f.rows[1] }, { ...f.rows[2] }];
  await decorate(f.db, loaded);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].where.id_tratamiento[inOperator].sort(), [11, 12]);
  assert.deepEqual(f.calls[0].attributes, ['id_tratamiento', 'nombre']);
  assert.deepEqual(loaded[0].appointment_link.members.map(member => member.treatment_name), ['Extracción PRP', 'Infiltración PRP']);
  assert.deepEqual(loaded[1].appointment_link.members.map(member => member.treatment_name), [null, 'Extracción PRP']);
  assert.equal(JSON.stringify(f.rows), before, 'No canonical appointment, assignment or link is changed');
});
test('unlinked and no-treatment groups never query the catalogue or invent a treatment', async () => {
  const f = fixture(); f.rows[3].tratamiento_id = null;
  const noTreatment = [{ ...f.rows[2] }]; await decorate(f.db, noTreatment);
  assert.equal(f.calls.length, 0); assert(noTreatment[0].appointment_link.members.every(member => member.treatment_name === null));
  const unlinked = [{ id_cita: 999 }]; await decorate(f.db, unlinked);
  assert.equal(f.calls.length, 0); assert.equal(unlinked[0].appointment_link, undefined);
});
test('corrupt cross-clinic/patient membership fails before catalogue reads rather than disclosing a linked label', async () => {
  for (const field of ['clinica_id', 'paciente_id']) {
    const f = fixture(); f.rows[0][field] = 999;
    await assert.rejects(decorate(f.db, [{ ...f.rows[1] }]), /patient_link_scope_invalid/);
    assert.equal(f.calls.length, 0);
  }
});
