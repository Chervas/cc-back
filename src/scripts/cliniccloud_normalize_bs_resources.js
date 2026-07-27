'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../models');

const BATCH_ID = 'cliniccloud_bs_resources_normalize_20260727_v1';
const REPORT_DIR = process.env.CLINICCLOUD_IMPORT_REPORT_DIR || '/home/ubuntu/secure-imports/clinic-real-20260722/review';
const execute = process.argv.includes('--execute');
const writeInsideTransaction = true;

const CLINICS = {
  capilar: 66,
  medical: 72,
};

const BS_MEDICAL_INSTALLATION_MAP = [
  { targetName: 'Box 1', finalName: 'Cabina 1 (Indiba / Facial)', sourceId: 65, tipo: 'box', order: 1 },
  { targetName: 'Box 2', finalName: 'Cabina 2 (Cyclone)', sourceId: 66, tipo: 'box', order: 2 },
  { targetName: 'Box 3', finalName: 'Cabina 3 (Indiba Ona y Carbo)', sourceId: 70, tipo: 'box', order: 3 },
  { targetName: 'Box 4', finalName: 'Cabina 4 (EMMS Y PRESOTERAPIAS)', sourceId: 68, tipo: 'box', order: 4 },
  { targetName: 'Box 5', finalName: 'Cabina 5 (Exion)', sourceId: 69, tipo: 'box', order: 5 },
  { targetName: 'Box 6', finalName: 'Unidad de obesidad', sourceId: 71, tipo: 'consulta', order: 6 },
];

const BS_MEDICAL_INACTIVE_INSTALLATION_NAMES = ['Box 7', 'Box 8', 'Box 9'];
const BS_MEDICAL_PROFESSIONAL_AGENDA_DEFAULT_INSTALLATIONS = new Map([
  ['59086', 'Cabina 1 (Indiba / Facial)'],
  ['59091', 'Unidad de obesidad'],
  ['59095', 'Unidad de obesidad'],
]);

const FULL_DAY_WEEK_SCHEDULE = [1, 2, 3, 4, 5].map((dia_semana) => ({
  dia_semana,
  activo: true,
  hora_inicio: '09:00',
  hora_fin: '20:00',
}));

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function appendMarker(description, message) {
  const current = clean(description);
  const marker = `${BATCH_ID}: ${message}`;
  if (current.includes(BATCH_ID)) return current;
  return [current, marker].filter(Boolean).join('\n');
}

function uniqueScheduleRows(rows) {
  const seen = new Set();
  return (rows || [])
    .filter((row) => row && row.activo !== false && row.hora_inicio && row.hora_fin && row.hora_inicio < row.hora_fin)
    .map((row) => ({
      dia_semana: Number(row.dia_semana),
      activo: true,
      hora_inicio: String(row.hora_inicio).slice(0, 5),
      hora_fin: String(row.hora_fin).slice(0, 5),
    }))
    .filter((row) => {
      if (!Number.isInteger(row.dia_semana) || row.dia_semana < 0 || row.dia_semana > 6) return false;
      const key = `${row.dia_semana}:${row.hora_inicio}:${row.hora_fin}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.dia_semana - b.dia_semana || a.hora_inicio.localeCompare(b.hora_inicio));
}

async function countAppointments(where, transaction) {
  const row = await db.CitaPaciente.findOne({
    where,
    attributes: [[db.Sequelize.fn('COUNT', db.Sequelize.col('id_cita')), 'count']],
    raw: true,
    transaction,
  });
  return Number(row?.count || 0);
}

async function findInstallationByName(clinicId, name, transaction) {
  const rows = await db.Instalacion.findAll({
    where: { clinica_id: clinicId },
    transaction,
  });
  const target = normalize(name);
  return rows.find((row) => normalize(row.nombre) === target) || null;
}

async function cloneInstallationSchedule(sourceId, targetId, transaction, report) {
  const sourceRows = sourceId
    ? await db.InstalacionHorario.findAll({ where: { instalacion_id: sourceId }, raw: true, transaction })
    : [];
  const scheduleRows = uniqueScheduleRows(sourceRows).length ? uniqueScheduleRows(sourceRows) : FULL_DAY_WEEK_SCHEDULE;

  if (writeInsideTransaction) {
    await db.InstalacionHorario.destroy({ where: { instalacion_id: targetId }, transaction });
    await db.InstalacionHorario.bulkCreate(
      scheduleRows.map((row) => ({ ...row, instalacion_id: targetId })),
      { transaction },
    );
  }
  report.installation_schedules_replaced.push({
    target_id: targetId,
    source_id: sourceId || null,
    rows: scheduleRows.length,
  });
}

async function updateInstallation(installation, patch, transaction, report) {
  report.installations_updated.push({
    id: installation.id,
    before: {
      clinica_id: installation.clinica_id,
      nombre: installation.nombre,
      tipo: installation.tipo,
      activo: !!installation.activo,
      orden_visualizacion: installation.orden_visualizacion,
    },
    after: patch,
  });
  if (writeInsideTransaction) {
    await installation.update(patch, { transaction });
  }
}

async function remapInstallationAppointments(sourceId, targetId, transaction, report) {
  if (!sourceId) return;
  const total = await countAppointments({ instalacion_id: sourceId }, transaction);
  const future = await countAppointments({
    instalacion_id: sourceId,
    inicio: { [db.Sequelize.Op.gte]: new Date() },
  }, transaction);

  if (writeInsideTransaction) {
    await db.CitaPaciente.update(
      { instalacion_id: targetId || null },
      { where: { instalacion_id: sourceId }, transaction },
    );
  }

  report.installation_appointment_remaps.push({
    source_id: sourceId,
    target_id: targetId || null,
    total,
    future,
  });
}

async function assignFutureNullInstallations(clinicId, sourceAgendaId, targetInstallation, transaction, report) {
  if (!targetInstallation) {
    report.errors.push(`No se encontro instalacion destino para citas futuras sin instalacion, clinica ${clinicId}, agenda ${sourceAgendaId || '*'}`);
    return;
  }

  const replacements = {
    clinicId,
    sourceAgendaId: sourceAgendaId ? String(sourceAgendaId) : null,
    targetInstallationId: targetInstallation.id,
    batchId: BATCH_ID,
  };
  const sourceFilter = sourceAgendaId
    ? "AND JSON_UNQUOTE(JSON_EXTRACT(import_metadata, '$.source_agenda_id')) = :sourceAgendaId"
    : '';

  const [rows] = await db.sequelize.query(`
    SELECT COUNT(*) AS total, MIN(inicio) AS primera, MAX(inicio) AS ultima
    FROM CitasPacientes
    WHERE source_system = 'cliniccloud'
      AND clinica_id = :clinicId
      AND estado <> 'cancelada'
      AND inicio >= UTC_TIMESTAMP()
      AND instalacion_id IS NULL
      ${sourceFilter}
  `, { replacements, transaction });
  const total = Number(rows?.[0]?.total || 0);

  if (writeInsideTransaction && total > 0) {
    await db.sequelize.query(`
      UPDATE CitasPacientes
      SET
        instalacion_id = :targetInstallationId,
        import_metadata = JSON_SET(
          COALESCE(import_metadata, JSON_OBJECT()),
          '$.clinicaclick_resource_normalize_v1',
          JSON_OBJECT(
            'batch_id', :batchId,
            'assigned_default_installation_id', :targetInstallationId,
            'source_agenda_id', ${sourceAgendaId ? ':sourceAgendaId' : 'NULL'},
            'reason', 'future imported appointment without physical installation',
            'updated_at', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')
          )
        )
      WHERE source_system = 'cliniccloud'
        AND clinica_id = :clinicId
        AND estado <> 'cancelada'
        AND inicio >= UTC_TIMESTAMP()
        AND instalacion_id IS NULL
        ${sourceFilter}
    `, { replacements, transaction });
  }

  report.future_null_installation_assignments.push({
    clinic_id: clinicId,
    source_agenda_id: sourceAgendaId || null,
    target_id: targetInstallation.id,
    target_name: targetInstallation.nombre,
    total,
    first: rows?.[0]?.primera || null,
    last: rows?.[0]?.ultima || null,
  });
}

async function ensureStaff({
  clinicId,
  name,
  sourceUserId,
  email,
  subrol,
  roleLabel,
  receivesAppointments = true,
  invitationState,
}, transaction, report) {
  let user = sourceUserId
    ? await db.Usuario.findByPk(sourceUserId, { transaction })
    : null;

  if (!user && email) {
    user = await db.Usuario.findOne({ where: { email_usuario: email }, transaction });
  }

  if (!user) {
    user = await db.Usuario.create({
      nombre: name,
      apellidos: '',
      email_usuario: email || null,
      email_notificacion: null,
      password_usuario: null,
      cargo_usuario: roleLabel || 'Personal de clínica',
      notas_usuario: `${BATCH_ID}: personal provisional para agenda real importada`,
      isProfesional: true,
      estado_cuenta: 'activo',
      es_provisional: true,
    }, { transaction });
    report.staff_created.push({ id: user.id_usuario, clinic_id: clinicId, name, email, subrol });
  }

  const [pivot, pivotCreated] = await db.UsuarioClinica.findOrCreate({
    where: { id_usuario: user.id_usuario, id_clinica: clinicId },
    defaults: {
      rol_clinica: 'personaldeclinica',
      subrol_clinica: subrol,
      estado_invitacion: user.es_provisional ? 'pendiente' : 'aceptada',
      fecha_invitacion: user.es_provisional ? new Date() : null,
      invited_at: user.es_provisional ? new Date() : null,
    },
    transaction,
  });

  if (writeInsideTransaction) {
    await user.update({
      nombre: name,
      apellidos: '',
      isProfesional: true,
      estado_cuenta: 'activo',
      es_provisional: user.es_provisional || !user.password_usuario,
      cargo_usuario: roleLabel || user.cargo_usuario || 'Personal de clínica',
    }, { transaction });

    const fallbackInvitationState = user.es_provisional ? 'pendiente' : 'aceptada';
    const nextInvitationState = invitationState
      || pivot.estado_invitacion
      || fallbackInvitationState;
    await pivot.update({
      rol_clinica: 'personaldeclinica',
      subrol_clinica: subrol,
      estado_invitacion: nextInvitationState,
    }, { transaction });
  }

  let doctorClinica = await db.DoctorClinica.findOne({ where: { doctor_id: user.id_usuario, clinica_id: clinicId }, transaction });
  if (!doctorClinica) {
    doctorClinica = await db.DoctorClinica.create({
      doctor_id: user.id_usuario,
      clinica_id: clinicId,
      rol_en_clinica: roleLabel || subrol,
      activo: true,
      recibe_citas: receivesAppointments,
    }, { transaction });
  } else if (writeInsideTransaction) {
    await doctorClinica.update({
      rol_en_clinica: roleLabel || doctorClinica.rol_en_clinica || subrol,
      activo: true,
      recibe_citas: receivesAppointments,
    }, { transaction });
  }

  if (doctorClinica) {
    await ensureDoctorSchedule(doctorClinica.id, transaction, report);
  }

  report.staff_ensured.push({
    id: user.id_usuario,
    clinic_id: clinicId,
    name,
    email: user.email_usuario || email || null,
    subrol,
    pivot_created: pivotCreated,
    receives_appointments: receivesAppointments,
  });

  return user;
}

async function ensureDoctorSchedule(doctorClinicaId, transaction, report) {
  const existing = await db.DoctorHorario.findAll({ where: { doctor_clinica_id: doctorClinicaId }, raw: true, transaction });
  const rows = uniqueScheduleRows(existing).length ? uniqueScheduleRows(existing) : FULL_DAY_WEEK_SCHEDULE;
  if (writeInsideTransaction) {
    await db.DoctorHorario.destroy({ where: { doctor_clinica_id: doctorClinicaId }, transaction });
    await db.DoctorHorario.bulkCreate(
      rows.map((row) => ({ ...row, doctor_clinica_id: doctorClinicaId })),
      { transaction },
    );
  }
  report.doctor_schedules_normalized.push({ doctor_clinica_id: doctorClinicaId, rows: rows.length });
}

async function remapDoctorAppointments(clinicId, sourceUserId, targetUserId, transaction, report) {
  if (!sourceUserId || !targetUserId || String(sourceUserId) === String(targetUserId)) return;
  const total = await countAppointments({ clinica_id: clinicId, doctor_id: sourceUserId }, transaction);
  const future = await countAppointments({
    clinica_id: clinicId,
    doctor_id: sourceUserId,
    inicio: { [db.Sequelize.Op.gte]: new Date() },
  }, transaction);
  if (writeInsideTransaction) {
    await db.CitaPaciente.update(
      { doctor_id: targetUserId },
      { where: { clinica_id: clinicId, doctor_id: sourceUserId }, transaction },
    );
  }
  report.doctor_appointment_remaps.push({
    clinic_id: clinicId,
    source_user_id: sourceUserId,
    target_user_id: targetUserId,
    total,
    future,
  });
}

async function disableDoctorResources(clinicId, keepUserIds, transaction, report, options = {}) {
  const rows = await db.DoctorClinica.findAll({
    where: { clinica_id: clinicId, activo: true },
    include: [{ model: db.Usuario, as: 'doctor' }],
    transaction,
  });
  const keep = new Set(keepUserIds.map((id) => Number(id)));
  for (const row of rows) {
    const userId = Number(row.doctor_id);
    if (keep.has(userId)) continue;
    const user = row.doctor;
    const isImportResource = !!user?.es_provisional
      && (
        String(user.email_usuario || '').includes('@imports.clinicaclick.local')
        || String(user.notas_usuario || '').includes('cliniccloud-agenda:')
      );
    if (!isImportResource && !options.strict) continue;

    report.doctor_resources_disabled.push({
      clinic_id: clinicId,
      user_id: userId,
      name: clean(`${user?.nombre || ''} ${user?.apellidos || ''}`),
      was_receiving: !!row.recibe_citas,
      strict: !!options.strict,
    });
    if (writeInsideTransaction) {
      await row.update({ activo: false, recibe_citas: false }, { transaction });
      if (options.cancelUnexpectedProvisionalPivots && user?.es_provisional) {
        await db.UsuarioClinica.update(
          { estado_invitacion: 'cancelada' },
          { where: { id_usuario: userId, id_clinica: clinicId }, transaction },
        );
      }
    }
  }
}

async function deactivateInstallation(id, transaction, report, reason = 'desactivada tras normalizacion') {
  if (!id) return;
  const installation = await db.Instalacion.findByPk(id, { transaction });
  if (!installation || !installation.activo) return;
  await updateInstallation(installation, {
    activo: false,
    orden_visualizacion: 9900 + Number(id),
    descripcion: appendMarker(installation.descripcion, reason),
  }, transaction, report);
}

async function normalizeBsMedical(transaction, report) {
  const clinicId = CLINICS.medical;

  for (const item of BS_MEDICAL_INSTALLATION_MAP) {
    const target = await findInstallationByName(clinicId, item.targetName, transaction)
      || await db.Instalacion.findOne({ where: { clinica_id: clinicId, nombre: item.finalName }, transaction });
    if (!target) {
      report.errors.push(`No se encontro instalacion objetivo ${item.targetName} en BS Medical`);
      continue;
    }

    await remapInstallationAppointments(item.sourceId, target.id, transaction, report);
    await cloneInstallationSchedule(item.sourceId, target.id, transaction, report);
    await updateInstallation(target, {
      nombre: item.finalName,
      tipo: item.tipo,
      activo: true,
      capacidad: 1,
      orden_visualizacion: item.order,
      descripcion: appendMarker(target.descripcion, `normalizada desde ClinicCloud source installation ${item.sourceId}`),
    }, transaction, report);
    await deactivateInstallation(item.sourceId, transaction, report, `fusionada en ${item.finalName}`);
  }

  const cabina1 = await db.Instalacion.findOne({ where: { clinica_id: clinicId, nombre: 'Cabina 1 (Indiba / Facial)' }, transaction });
  await remapInstallationAppointments(64, cabina1?.id || null, transaction, report);
  await deactivateInstallation(64, transaction, report, 'agenda CAPILARES de BS Medical fusionada en Cabina 1');
  await remapInstallationAppointments(67, null, transaction, report);
  await deactivateInstallation(67, transaction, report, 'agenda LOZA no es instalacion fisica de BS Medical');

  for (const name of BS_MEDICAL_INACTIVE_INSTALLATION_NAMES) {
    const row = await findInstallationByName(clinicId, name, transaction);
    if (row) await deactivateInstallation(row.id, transaction, report, 'box manual no usado tras normalizacion');
  }

  for (const [sourceAgendaId, installationName] of BS_MEDICAL_PROFESSIONAL_AGENDA_DEFAULT_INSTALLATIONS.entries()) {
    const target = await findInstallationByName(clinicId, installationName, transaction);
    await assignFutureNullInstallations(clinicId, sourceAgendaId, target, transaction, report);
  }
}

async function normalizeBsCapilar(transaction, report) {
  const clinicId = CLINICS.capilar;
  const target = await db.Instalacion.findByPk(56, { transaction })
    || await findInstallationByName(clinicId, 'CAPILARES', transaction)
    || await findInstallationByName(clinicId, 'Consulta 1', transaction);
  if (!target) {
    report.errors.push('No se encontro instalacion objetivo para BS Capilar');
    return;
  }

  const all = await db.Instalacion.findAll({ where: { clinica_id: clinicId }, transaction });
  for (const row of all) {
    if (Number(row.id) === Number(target.id)) continue;
    await remapInstallationAppointments(row.id, target.id, transaction, report);
    await deactivateInstallation(row.id, transaction, report, 'fusionada en Unidad capilar');
  }

  await updateInstallation(target, {
    nombre: 'Unidad capilar',
    tipo: 'consulta',
    activo: true,
    capacidad: 1,
    orden_visualizacion: 1,
    descripcion: appendMarker(target.descripcion, 'instalacion unica para BS Capilar'),
  }, transaction, report);

  await assignFutureNullInstallations(clinicId, null, target, transaction, report);
}

async function normalizeStaff(transaction, report) {
  const ainhoa = await ensureStaff({
    clinicId: CLINICS.capilar,
    name: 'Ainhoa',
    sourceUserId: 50,
    subrol: 'Auxiliares y enfermeros',
    roleLabel: 'Capilar',
    invitationState: 'aceptada',
  }, transaction, report);
  const loza = await ensureStaff({
    clinicId: CLINICS.capilar,
    name: 'Dr Loza',
    sourceUserId: 120,
    subrol: 'Doctores',
    roleLabel: 'Capilar',
  }, transaction, report);
  const draCelia = await ensureStaff({
    clinicId: CLINICS.medical,
    name: 'Dra Celia',
    sourceUserId: 53,
    subrol: 'Doctores',
    roleLabel: 'Medicina estetica',
  }, transaction, report);
  const mar = await ensureStaff({
    clinicId: CLINICS.medical,
    name: 'Mar',
    email: 'cliniccloud.staff.72.mar@imports.clinicaclick.local',
    subrol: 'Recepción / Comercial ventas',
    roleLabel: 'Recepcion',
  }, transaction, report);
  const lidia = await ensureStaff({
    clinicId: CLINICS.medical,
    name: 'Lidia',
    email: 'cliniccloud.staff.72.lidia@imports.clinicaclick.local',
    subrol: 'Auxiliares y enfermeros',
    roleLabel: 'Medicina estetica',
  }, transaction, report);

  const ainhoaId = Number(ainhoa.id_usuario);
  const lozaId = Number(loza.id_usuario);
  const draCeliaId = Number(draCelia.id_usuario);
  const marId = Number(mar.id_usuario);
  const lidiaId = Number(lidia.id_usuario);

  const capilarMap = new Map([
    [114, ainhoaId],
    [115, ainhoaId],
    [116, lozaId],
    [117, ainhoaId],
    [118, ainhoaId],
    [119, ainhoaId],
    [120, lozaId],
    [121, ainhoaId],
    [122, ainhoaId],
    [123, ainhoaId],
    [124, ainhoaId],
  ]);
  const medicalMap = new Map([
    [125, marId],
    [126, draCeliaId],
    [127, draCeliaId],
    [128, lidiaId],
    [129, lidiaId],
    [130, lidiaId],
    [131, draCeliaId],
    [132, lidiaId],
    [133, lidiaId],
    [134, lidiaId],
    [135, lidiaId],
    [136, lidiaId],
  ]);

  for (const [source, target] of capilarMap.entries()) {
    await remapDoctorAppointments(CLINICS.capilar, source, target, transaction, report);
  }
  for (const [source, target] of medicalMap.entries()) {
    await remapDoctorAppointments(CLINICS.medical, source, target, transaction, report);
  }

  await disableDoctorResources(
    CLINICS.capilar,
    [ainhoaId, lozaId],
    transaction,
    report,
    { strict: true, cancelUnexpectedProvisionalPivots: true },
  );
  await disableDoctorResources(
    CLINICS.medical,
    [draCeliaId, marId, lidiaId],
    transaction,
    report,
    { strict: true, cancelUnexpectedProvisionalPivots: true },
  );
}

async function summarizeAfter(transaction) {
  const [installations] = await db.sequelize.query(`
    SELECT clinica_id, id, nombre, tipo, activo, orden_visualizacion
    FROM Instalaciones
    WHERE clinica_id IN (:clinicIds)
    ORDER BY clinica_id, activo DESC, orden_visualizacion, id
  `, {
    replacements: { clinicIds: Object.values(CLINICS) },
    transaction,
  });

  const [doctors] = await db.sequelize.query(`
    SELECT dc.clinica_id, u.id_usuario, CONCAT_WS(' ', u.nombre, u.apellidos) AS nombre,
           dc.activo, dc.recibe_citas,
           COUNT(c.id_cita) AS citas_futuras
    FROM DoctorClinicas dc
    JOIN Usuarios u ON u.id_usuario = dc.doctor_id
    LEFT JOIN CitasPacientes c
      ON c.clinica_id = dc.clinica_id
     AND c.doctor_id = dc.doctor_id
     AND c.inicio >= UTC_TIMESTAMP()
     AND c.estado <> 'cancelada'
    WHERE dc.clinica_id IN (:clinicIds)
      AND dc.activo = 1
    GROUP BY dc.clinica_id, u.id_usuario, u.nombre, u.apellidos, dc.activo, dc.recibe_citas
    ORDER BY dc.clinica_id, dc.recibe_citas DESC, nombre
  `, {
    replacements: { clinicIds: Object.values(CLINICS) },
    transaction,
  });

  return { installations, doctors };
}

async function main() {
  const report = {
    batch_id: BATCH_ID,
    mode: execute ? 'execute' : 'dry-run',
    generated_at: nowIso(),
    errors: [],
    staff_created: [],
    staff_ensured: [],
    doctor_schedules_normalized: [],
    doctor_appointment_remaps: [],
    doctor_resources_disabled: [],
    installations_updated: [],
    installation_schedules_replaced: [],
    installation_appointment_remaps: [],
    future_null_installation_assignments: [],
    after: null,
  };

  const work = async (transaction) => {
    await normalizeBsMedical(transaction, report);
    await normalizeBsCapilar(transaction, report);
    await normalizeStaff(transaction, report);
    report.after = await summarizeAfter(transaction);
  };

  if (execute) {
    await db.sequelize.transaction(work);
  } else {
    await db.sequelize.transaction(async (transaction) => {
      await work(transaction);
      throw new Error('__DRY_RUN_ROLLBACK__');
    }).catch((error) => {
      if (error.message !== '__DRY_RUN_ROLLBACK__') throw error;
    });
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${BATCH_ID}-${execute ? 'execute' : 'dry-run'}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    report_path: reportPath,
    mode: report.mode,
    errors: report.errors,
    staff_created: report.staff_created.length,
    staff_ensured: report.staff_ensured.length,
    doctor_remaps: report.doctor_appointment_remaps.length,
    installation_remaps: report.installation_appointment_remaps.length,
    installations_updated: report.installations_updated.length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
