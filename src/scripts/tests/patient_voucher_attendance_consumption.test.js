#!/usr/bin/env node
'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const crypto = require('crypto');

const db = require('../../../models');
const patientEconomics = require('../../services/patientEconomics.service');

async function run() {
  const token = crypto.randomUUID();
  let clinic = null;
  let patient = null;
  let voucher = null;
  let appointment = null;

  try {
    clinic = await db.Clinica.create({
      nombre_clinica: `QA bono asistencia ${token}`,
      fecha_creacion: new Date(),
      estado_clinica: true,
      configuracion: { qa_marker: token },
    });
    patient = await db.Paciente.create({
      public_id: `qa_voucher_patient_${token}`,
      nombre: 'QA',
      apellidos: 'Bono Asistencia',
      clinica_id: clinic.id_clinica,
      fecha_alta: new Date(),
    });
    voucher = await db.PatientVoucher.create({
      public_id: token,
      clinic_id: clinic.id_clinica,
      patient_id: patient.id_paciente,
      name: 'Bono QA asistencia',
      unit_label: 'sesiones',
      total_units: 2,
      available_units: 2,
      sold_amount: 120,
      activation_rule: 'on_acceptance',
      status: 'active',
      source_system: 'clinicaclick_qa',
      source_reference: token,
      created_by: 1,
    });
    appointment = await db.CitaPaciente.create({
      clinica_id: clinic.id_clinica,
      paciente_id: patient.id_paciente,
      voucher_id: voucher.id,
      titulo: 'Sesión QA bono',
      tipo_cita: 'continuacion',
      estado: 'pendiente',
      inicio: new Date(Date.now() + 86400000),
      fin: new Date(Date.now() + 86400000 + 1800000),
      created_by: 1,
      updated_by: 1,
    });

    const skipped = await patientEconomics.consumeVoucherForCompletedAppointment({
      appointmentId: appointment.id_cita,
      actorId: 1,
    });
    assert.equal(skipped.consumed, false);
    assert.equal(skipped.reason, 'appointment_not_completed');

    await appointment.update({ estado: 'completada' });
    const consumed = await patientEconomics.consumeVoucherForCompletedAppointment({
      appointmentId: appointment.id_cita,
      actorId: 1,
    });
    assert.equal(consumed.consumed, true);
    assert.equal(consumed.available_units, 1);

    await voucher.reload();
    assert.equal(Number(voucher.available_units), 1);
    assert.equal(await db.PatientVoucherMovement.count({
      where: {
        voucher_id: voucher.id,
        movement_type: 'consumption',
        appointment_id: appointment.id_cita,
      },
    }), 1);

    const repeated = await patientEconomics.consumeVoucherForCompletedAppointment({
      appointmentId: appointment.id_cita,
      actorId: 1,
    });
    assert.equal(repeated.consumed, false);
    assert.equal(repeated.already_consumed, true);
    assert.equal(repeated.available_units, 1);

    await voucher.reload();
    assert.equal(Number(voucher.available_units), 1);
    assert.equal(await db.PatientVoucherMovement.count({
      where: {
        voucher_id: voucher.id,
        movement_type: 'consumption',
        appointment_id: appointment.id_cita,
      },
    }), 1);

    process.stdout.write('patient voucher attendance consumption tests passed\n');
  } finally {
    if (appointment) await db.CitaPaciente.destroy({ where: { id_cita: appointment.id_cita } });
    if (voucher) {
      await db.PatientVoucherMovement.destroy({ where: { voucher_id: voucher.id } });
      await db.PatientVoucher.destroy({ where: { id: voucher.id } });
    }
    if (patient) await db.Paciente.destroy({ where: { id_paciente: patient.id_paciente } });
    if (clinic) await db.Clinica.destroy({ where: { id_clinica: clinic.id_clinica } });
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });
