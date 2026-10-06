'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { projectPersonalBlocks, loadAgendaPersonalBlocks } = require('../../lib/agenda-personal-blocks');
const block = (id, extra = {}) => ({ id, doctor_id: 50, clinica_id: 66, motivo: 'Vacaciones', tipo: 'vacaciones',
  fecha_inicio: new Date('2026-10-26T08:30:00Z'), fecha_fin: new Date('2026-10-26T12:40:00Z'), recurrente: 'none', ...extra });
test('actual local occurrence and identity survive DST and identical reasons', () => {
  const rows = projectPersonalBlocks([block(1), block(2)], ['2026-10-26'], 'Europe/Madrid');
  assert.deepEqual(rows.map(row => row.id), [1, 2]);
  assert.equal(rows[0].start_local.slice(11, 16), '09:30'); assert.equal(rows[0].end_local.slice(11, 16), '13:40');
});
test('recurrence respects exceptions and returns definition id, not an invented occurrence id', () => {
  const rows = projectPersonalBlocks([block(7, { recurrente: 'daily', excepciones: [{ fecha: '2026-10-27', cancelado: true }] })],
    ['2026-10-26', '2026-10-27', '2026-10-28'], 'Europe/Madrid');
  assert.deepEqual(rows.map(row => [row.day_id, row.id, row.recurrente]), [['2026-10-26', 7, 'daily'], ['2026-10-28', 7, 'daily']]);
});
test('bounded reader includes only active clinic members and relevant/global blocks', async () => {
  const calls = []; const Op = Object.fromEntries(['in', 'or', 'lt', 'gt', 'ne', 'lte'].map(key => [key, Symbol(key)]));
  const db = { Sequelize: { Op }, DoctorClinica: { findAll: async query => { calls.push(query); return [{ doctor_id: 50 }]; } },
    DoctorBloqueoExcepcion: {}, DoctorBloqueo: { findAll: async query => { calls.push(query); return [block(1),
      block(2, { doctor_id: 99 }), block(3, { clinica_id: 72 }), block(4, { clinica_id: null }),
      block(5, { clinica_id: 72, aplica_a_todas_clinicas: true })]; } } };
  const rows = await loadAgendaPersonalBlocks({ db, clinic: 66, doctorIds: [50, 99], dates: ['2026-10-26'], timezone: 'Europe/Madrid' });
  assert.deepEqual(rows.map(row => row.id), [1, 4, 5]); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].where.doctor_id[Op.in], [50]);
});
