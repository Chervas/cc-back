'use strict';
// Owned mysqld + Unix socket only. Exercises the real Sequelize voucher model
// and production read helper; never reads or writes a runtime database.
const assert = require('node:assert/strict'), { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { attachAppointmentVoucherIdentities } = require('../../services/appointmentVoucherRead.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.PatientVoucher = require('../../../models/patientvoucher')(sql, DataTypes);
  await sql.sync();
  const create = (id, patient, clinic, publicId) => db.PatientVoucher.create({ id, public_id: publicId, clinic_id: clinic,
    patient_id: patient, name: 'Bono ficticio', unit_label: 'sesiones', total_units: 4, available_units: 3,
    sold_amount: 100, activation_rule: 'on_first_payment', status: 'active', source_system: 'clinicaclick' });
  await create(42, 11, 72, 'owned-voucher'); await create(43, 12, 72, 'other-patient-voucher');
  await create(44, 11, 73, 'other-clinic-voucher');
  const before = JSON.stringify(await db.PatientVoucher.findAll({ order: [['id', 'ASC']], raw: true }));
  const rows = Array.from({ length: 401 }, (_, index) => ({ id_cita: index + 1, voucher_id: 42, paciente_id: 11, clinica_id: 72,
    estado: 'pendiente', voucher_public_id: 'stale' }));
  rows.push({ id_cita: 501, voucher_id: 43, paciente_id: 11, clinica_id: 72, voucher_public_id: 'stale' },
    { id_cita: 502, voucher_id: 44, paciente_id: 11, clinica_id: 72, voucher_public_id: 'stale' });
  const queries = [], originalLogging = sql.options.logging; sql.options.logging = query => queries.push(query);
  try { await attachAppointmentVoucherIdentities(db, rows); } finally { sql.options.logging = originalLogging; }
  assert(rows.slice(0, 401).every(row => row.voucher_public_id === 'owned-voucher'));
  assert.equal(rows[401].voucher_public_id, null); assert.equal(rows[402].voucher_public_id, null);
  assert.equal(queries.length, 3); assert(queries.every(query => /SELECT/.test(query) && !/sold_amount|total_units|available_units|UPDATE|INSERT|DELETE/.test(query)));
  assert.equal(JSON.stringify(await db.PatientVoucher.findAll({ order: [['id', 'ASC']], raw: true })), before);
  report.checks.push('Real PatientVoucher model SQL selects only scoped purchase identities in 200-row batches; cross-patient and cross-clinic FKs fail closed; all purchase balances/statuses remain byte-equivalent.');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
