'use strict';
const assert = require('node:assert/strict');

const MARKER = 'bs-startup-isolated-20260920';
const PATIENT_ID = 'pac_09202026000000000001';

async function prepare(db) {
  assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
  assert.equal(db.sequelize.config.username, 'cc_dev_api');
  const clinic = await db.Clinica.findByPk(1);
  assert.equal(clinic?.nombre_clinica, 'Clinica ficticia DEV');
  const actor = await db.Usuario.findByPk(1);
  assert.equal(actor?.email_usuario, 'carlos@clinicaclick.com');
  return db.sequelize.transaction(async transaction => {
    const [patient] = await db.Paciente.findOrCreate({ where: { public_id: PATIENT_ID },
      defaults: { nombre: 'Paciente ficticio', apellidos: 'Prueba BS Medical', clinica_id: 1,
        idioma_preferido: 'es', paciente_conocido: true, antecedentes: 'Ficha sintética para comprobar la aplicación. No contiene datos de una persona real.' }, transaction });
    assert.equal(patient.clinica_id, 1);
    await db.PacienteClinica.findOrCreate({ where: { paciente_id: patient.id_paciente, clinica_id: 1 }, defaults: { es_principal: true }, transaction });
    const staff = [];
    for (const name of ['Prioritario', 'Alternativo']) {
      const [user] = await db.Usuario.findOrCreate({ where: { email_usuario: `qa.bs.${name.toLowerCase()}.20260920@example.invalid` },
        defaults: { nombre: `Profesional ficticio ${name}`, apellidos: 'QA', isProfesional: true, notas_usuario: MARKER, password_usuario: null }, transaction });
      assert.equal(user.notas_usuario, MARKER);
      const [link] = await db.DoctorClinica.findOrCreate({ where: { doctor_id: user.id_usuario, clinica_id: 1 },
        defaults: { rol_en_clinica: 'Doctores', recibe_citas: true, activo: true }, transaction });
      await db.UsuarioClinica.findOrCreate({ where: { id_usuario: user.id_usuario, id_clinica: 1 },
        defaults: { rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores', estado_invitacion: 'aceptada' }, transaction });
      for (let day = 1; day <= 5; day++) await db.DoctorHorario.findOrCreate({
        where: { doctor_clinica_id: link.id, dia_semana: day, hora_inicio: '09:00', hora_fin: '20:00' }, defaults: { activo: true }, transaction });
      staff.push(user.id_usuario);
    }
    const rooms = [];
    for (const index of [1, 2]) {
      const [room] = await db.Instalacion.findOrCreate({ where: { clinica_id: 1, nombre: `Cabina ficticia ${index} · QA BS` },
        defaults: { descripcion: MARKER, tipo: 'consulta', capacidad: 1, activo: true, color: index === 1 ? '#4f46e5' : '#0d9488' }, transaction });
      assert.equal(room.descripcion, MARKER);
      for (let day = 1; day <= 5; day++) await db.InstalacionHorario.findOrCreate({
        where: { instalacion_id: room.id, dia_semana: day, hora_inicio: '09:00', hora_fin: '20:00' }, defaults: { activo: true }, transaction });
      rooms.push(room.id);
    }
    return { marker: MARKER, clinicId: 1, actorId: actor.id_usuario, patientId: patient.id_paciente,
      patientPublicId: patient.public_id, doctorIds: staff, installationIds: rooms };
  });
}

async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const db = require('../../../models');
  try { console.log(JSON.stringify(await prepare(db))); } finally { await db.sequelize.close(); }
}
if (require.main === module) main().catch(() => { console.error('ISOLATED_CLINICAL_FIXTURE_FAILED'); process.exitCode = 1; });
module.exports = { prepare, MARKER, PATIENT_ID };
