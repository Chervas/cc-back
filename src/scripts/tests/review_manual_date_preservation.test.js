'use strict';

require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const dates = require('../../lib/marketing-template-variables');
const scope = { scope: 'clinic', clinicIds: [56] };

function fixture({ fields = [], appointments = [] } = {}) {
  const f = { customReads: 0, appointmentReads: 0 };
  const db = {
    Sequelize: sequelize,
    sequelize: { query: async (sql, options) => {
      assert.deepEqual(Array.from(options.replacements.clinicIds), [56], 'every source query stays inside the selected clinic');
      if (sql.includes('FROM Pacientes p')) return [{ id_paciente: 41, clinica_id: 56, review_clinica_id: 56,
        nombre: 'Persona ficticia', apellidos: 'Prueba', telefono_movil: '900000000', review_clinica_nombre: 'Clínica ficticia' }];
      assert.match(sql, /FROM CitasPacientes c/);
      assert.match(sql, /c\.clinica_id IN \(:clinicIds\)/);
      assert.match(sql, /c\.estado IN \('ha_acudido', 'en_atencion', 'completada'\)/);
      f.appointmentReads++;
      return appointments.filter(row => row.clinica_id === 56 && row.paciente_id === 41
        && ['ha_acudido', 'en_atencion', 'completada'].includes(row.estado));
    } },
    PatientCustomField: { findAll: async ({ where, attributes }) => {
      f.customReads++;
      assert.deepEqual(Array.from(where.clinica_id[sequelize.Op.in]), [56]);
      assert.deepEqual(Array.from(where.paciente_id[sequelize.Op.in]), [41]);
      assert.ok(attributes.includes('field_key') && attributes.includes('value'));
      return fields.filter(row => row.clinica_id === 56 && row.paciente_id === 41);
    } },
    CitaPaciente: { findAll: async ({ where }) => {
      assert.deepEqual(Array.from(where.clinica_id[sequelize.Op.in]), [56]);
      assert.deepEqual(Array.from(where.paciente_id[sequelize.Op.in]), [41]);
      assert.deepEqual(Array.from(where.estado[sequelize.Op.in]), ['ha_acudido', 'en_atencion', 'completada']);
      return appointments.filter(row => row.clinica_id === 56 && row.paciente_id === 41
        && ['ha_acudido', 'en_atencion', 'completada'].includes(row.estado))
        .map(row => ({ paciente_id: row.paciente_id, ultima_cita_asistida: row.inicio }));
    } },
  };
  const service = loadDiscoverySource('services/marketingBulkSends.service.js', {
    crypto: require('node:crypto'), sequelize, '../../models': db,
    '../lib/phone': { normalizePhoneDigits: value => String(value || '').replace(/\D/g, '') },
    '../lib/review-request-history': { readReviewRequestHistory: async () => ({ patientIds: new Set(), phoneKeys: new Set() }),
      hasPriorReviewRequest: () => false },
    '../lib/marketing-template-variables': dates,
    '../lib/status-catalog': require('../../lib/status-catalog'),
  });
  f.build = () => service.__testing.buildItemsForReviewRequest(scope, {
    review_source: 'manual_selection', review_exclusion_rules: { no_visit_date: true },
  });
  return f;
}

test('manual selection preserves a valid patient custom date when no attended appointment generated a date', async () => {
  const f = fixture({ fields: [{ paciente_id: 41, clinica_id: 56,
    field_key: 'fecha_ultima_cita_asistida', value: '5 de septiembre de 2026' }] });
  const [item] = await f.build();
  assert.equal(item.status, 'ready'); assert.equal(item.selected, true);
  assert.equal(dates.resolveLastAttendedAppointmentDate(item), '05/09/2026');
  assert.equal(f.customReads, 1); assert.equal(f.appointmentReads, 1);
});

test('the valid attended appointment date keeps priority over an older custom date', async () => {
  for (const estado of ['ha_acudido', 'en_atencion', 'completada']) {
    const f = fixture({ fields: [{ paciente_id: 41, clinica_id: 56,
      field_key: 'fecha_ultima_cita_asistida', value: '05/09/2026' }],
    appointments: [{ paciente_id: 41, clinica_id: 56, estado, inicio: '2026-10-09T09:00:00Z' }] });
    const [item] = await f.build();
    assert.equal(item.status, 'ready'); assert.equal(dates.resolveLastAttendedAppointmentDate(item), '09/10/2026');
  }
});

test('a pending appointment alone is not evidence of attended care and cannot supply the template date', async () => {
  const [item] = await fixture({ appointments: [{ paciente_id: 41, clinica_id: 56,
    estado: 'pendiente', inicio: '2026-10-09T09:00:00Z' }] }).build();
  assert.equal(dates.resolveLastAttendedAppointmentDate(item), '');
  assert.equal(item.status, 'excluded_manual'); assert.equal(item.reason, 'Sin fecha de atención');
});

test('no date or an invalid custom date remains unavailable instead of inventing a date', async () => {
  for (const fields of [[], [{ paciente_id: 41, clinica_id: 56,
    field_key: 'fecha_ultima_cita_asistida', value: '2026-02-30' }]]) {
    const [item] = await fixture({ fields }).build();
    assert.equal(dates.resolveLastAttendedAppointmentDate(item), '');
    assert.equal(item.status, 'excluded_manual'); assert.equal(item.selected, false);
  }
});

test('another clinic or another patient cannot supply a custom or attended date to this scope', async () => {
  const [item] = await fixture({ fields: [
    { paciente_id: 41, clinica_id: 57, field_key: 'fecha_ultima_cita_asistida', value: '05/09/2026' },
    { paciente_id: 42, clinica_id: 56, field_key: 'fecha_ultima_cita_asistida', value: '05/09/2026' },
  ], appointments: [
    { paciente_id: 41, clinica_id: 57, estado: 'completada', inicio: '2026-10-09T09:00:00Z' },
    { paciente_id: 42, clinica_id: 56, estado: 'completada', inicio: '2026-10-09T09:00:00Z' },
  ] }).build();
  assert.equal(dates.resolveLastAttendedAppointmentDate(item), '');
  assert.equal(item.status, 'excluded_manual'); assert.equal(item.selected, false);
});
