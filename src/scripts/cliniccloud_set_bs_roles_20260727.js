'use strict';

const db = require('../../models');

const CLINICS = [66, 72];
const OWNER_USERS = [
  { id: 53, name: 'Dra Celia' },
  { id: 141, name: 'Mar' },
];
const ADMIN_RECEIVING_USERS = [
  { id: 50, clinicId: 66, name: 'Ainhoa' },
  { id: 142, clinicId: 72, name: 'Lidia' },
];

async function upsertMembership(transaction, userId, clinicId, patch) {
  const [row, created] = await db.UsuarioClinica.findOrCreate({
    where: { id_usuario: userId, id_clinica: clinicId },
    defaults: {
      id_usuario: userId,
      id_clinica: clinicId,
      rol_clinica: patch.rol_clinica,
      subrol_clinica: patch.subrol_clinica ?? null,
      estado_invitacion: 'aceptada',
      fecha_invitacion: null,
      invited_at: null,
      responded_at: new Date(),
    },
    transaction,
  });

  await row.update({
    rol_clinica: patch.rol_clinica,
    subrol_clinica: patch.subrol_clinica ?? null,
    estado_invitacion: 'aceptada',
    responded_at: row.responded_at || new Date(),
  }, { transaction });

  return { created };
}

async function ensureDoctorClinica(transaction, userId, clinicId, receivesAppointments, roleLabel) {
  const [row] = await db.DoctorClinica.findOrCreate({
    where: { doctor_id: userId, clinica_id: clinicId },
    defaults: {
      doctor_id: userId,
      clinica_id: clinicId,
      rol_en_clinica: roleLabel,
      activo: true,
      recibe_citas: receivesAppointments,
    },
    transaction,
  });

  await row.update({
    rol_en_clinica: roleLabel,
    activo: true,
    recibe_citas: receivesAppointments,
  }, { transaction });
}

async function main() {
  const report = {
    owners: [],
    administrative_receiving: [],
  };

  await db.sequelize.transaction(async (transaction) => {
    for (const user of OWNER_USERS) {
      const dbUser = await db.Usuario.findByPk(user.id, { transaction });
      if (!dbUser) throw new Error(`Usuario no encontrado: ${user.name} (${user.id})`);

      await dbUser.update({
        nombre: user.name,
        apellidos: '',
        estado_cuenta: 'activo',
      }, { transaction });

      for (const clinicId of CLINICS) {
        const result = await upsertMembership(transaction, user.id, clinicId, {
          rol_clinica: 'propietario',
          subrol_clinica: null,
        });
        report.owners.push({ user_id: user.id, name: user.name, clinic_id: clinicId, membership_created: result.created });
      }
    }

    for (const user of ADMIN_RECEIVING_USERS) {
      const dbUser = await db.Usuario.findByPk(user.id, { transaction });
      if (!dbUser) throw new Error(`Usuario no encontrado: ${user.name} (${user.id})`);

      await dbUser.update({
        nombre: user.name,
        apellidos: '',
        isProfesional: true,
        estado_cuenta: 'activo',
      }, { transaction });

      const result = await upsertMembership(transaction, user.id, user.clinicId, {
        rol_clinica: 'personaldeclinica',
        subrol_clinica: 'Administrativos',
      });
      await ensureDoctorClinica(transaction, user.id, user.clinicId, true, 'Administrativos');
      report.administrative_receiving.push({
        user_id: user.id,
        name: user.name,
        clinic_id: user.clinicId,
        membership_created: result.created,
        recibe_citas: true,
      });
    }
  });

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
