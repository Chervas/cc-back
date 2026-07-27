'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../models');

const BATCH_ID = 'cliniccloud_bsmedical_real_20260726_agenda_resources_v1';
const DEFAULT_AGENDA_CSV = '/home/ubuntu/secure-imports/clinic-real-20260722/review/backup_data/agenda_1.csv';
const DEFAULT_REPORT_DIR = '/home/ubuntu/secure-imports/clinic-real-20260722/review';
const TARGET_CLINIC_IDS = [66, 72];

const execute = process.argv.includes('--execute');
const agendaCsvPath = process.env.CLINICCLOUD_AGENDA_CSV || DEFAULT_AGENDA_CSV;
const reportDir = process.env.CLINICCLOUD_IMPORT_REPORT_DIR || DEFAULT_REPORT_DIR;

const DAY_FIELDS = [
  { dia_semana: 1, slots: [['lhi1', 'lhf1'], ['lhi2', 'lhf2']] },
  { dia_semana: 2, slots: [['mhi1', 'mhf1'], ['mhi2', 'mhf2']] },
  { dia_semana: 3, slots: [['xhi1', 'xhf1'], ['xhi2', 'xhf2']] },
  { dia_semana: 4, slots: [['jhi1', 'jhf1'], ['jhi2', 'jhf2']] },
  { dia_semana: 5, slots: [['vhi1', 'vhf1'], ['vhi2', 'vhf2']] },
  { dia_semana: 6, slots: [['shi1', 'shf1'], ['shi2', 'shf2']] },
  { dia_semana: 0, slots: [['dhi1', 'dhf1'], ['dhi2', 'dhf2']] },
];

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ';' && !quoted) {
      out.push(value);
      value = '';
      continue;
    }
    value += char;
  }
  out.push(value);
  return out;
}

function loadAgendaRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift() || '');
  const rows = new Map();

  lines.forEach((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    if (row.idAgenda) {
      rows.set(String(row.idAgenda), row);
    }
  });
  return rows;
}

function cleanName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return cleanName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function sourceNameForDisplay(row, sourceAgendaId) {
  const name = cleanName(row?.nombre);
  return name || `Agenda ClinicCloud ${sourceAgendaId}`;
}

function isInstallationLike(row) {
  const name = normalizeName(row?.nombre);
  return /\b(cabina|box|sala|consulta|indiba|presoterapia|presoterapias|exion|unidad obesidad|capilares|loza)\b/.test(name);
}

function installationTypeFor(row) {
  const name = normalizeName(row?.nombre);
  if (name.includes('unidad obesidad') || name.includes('consulta')) return 'consulta';
  if (name.includes('sala')) return 'sala';
  return 'box';
}

function timePart(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh === 0 && mm === 0) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${match[1]}:${match[2]}`;
}

function scheduleRowsFromAgenda(row) {
  const rows = [];
  DAY_FIELDS.forEach((day) => {
    day.slots.forEach(([startKey, endKey]) => {
      const start = timePart(row?.[startKey]);
      const end = timePart(row?.[endKey]);
      if (!start || !end || start >= end) return;
      rows.push({
        dia_semana: day.dia_semana,
        activo: true,
        hora_inicio: start,
        hora_fin: end,
      });
    });
  });
  return rows;
}

function importedUserEmail(clinicId, sourceAgendaId) {
  return `cliniccloud.agenda.${clinicId}.${sourceAgendaId}@imports.clinicaclick.local`;
}

function importedMarker(clinicId, sourceAgendaId) {
  return `cliniccloud-agenda:${clinicId}:${sourceAgendaId}:${BATCH_ID}`;
}

async function findExistingClinicUserByName(clinicId, displayName, transaction) {
  const normalized = normalizeName(displayName);
  if (!normalized) return null;
  const pivots = await db.UsuarioClinica.findAll({
    where: {
      id_clinica: clinicId,
      rol_clinica: 'personaldeclinica',
    },
    include: [{ model: db.Usuario, as: 'Usuario' }],
    transaction,
  });

  return pivots
    .map((pivot) => pivot.Usuario)
    .filter(Boolean)
    .find((user) => normalizeName(`${user.nombre || ''} ${user.apellidos || ''}`) === normalized
      || normalizeName(user.nombre || '') === normalized) || null;
}

async function ensureDoctorResource({ clinicId, sourceAgendaId, agendaRow, transaction, created, reused }) {
  const displayName = sourceNameForDisplay(agendaRow, sourceAgendaId);
  let user = await findExistingClinicUserByName(clinicId, displayName, transaction);

  if (user) {
    reused.users += 1;
  } else {
    const email = importedUserEmail(clinicId, sourceAgendaId);
    user = await db.Usuario.findOne({ where: { email_usuario: email }, transaction });
    if (!user) {
      user = await db.Usuario.create({
        nombre: displayName,
        apellidos: '',
        email_usuario: email,
        email_notificacion: null,
        password_usuario: null,
        notas_usuario: importedMarker(clinicId, sourceAgendaId),
        cargo_usuario: isInstallationLike(agendaRow) ? 'Recurso importado ClinicCloud' : 'Profesional importado ClinicCloud',
        isProfesional: true,
        estado_cuenta: 'activo',
        es_provisional: true,
      }, { transaction });
      created.users += 1;
    } else {
      reused.users += 1;
    }
  }

  const [pivot, pivotCreated] = await db.UsuarioClinica.findOrCreate({
    where: { id_usuario: user.id_usuario, id_clinica: clinicId },
    defaults: {
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Doctores',
      estado_invitacion: user.es_provisional ? 'pendiente' : 'aceptada',
      fecha_invitacion: user.es_provisional ? new Date() : null,
      invited_at: user.es_provisional ? new Date() : null,
    },
    transaction,
  });
  if (pivotCreated) {
    created.userClinics += 1;
  } else if (user.es_provisional && pivot.estado_invitacion !== 'pendiente') {
    await pivot.update({
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Doctores',
      estado_invitacion: 'pendiente',
    }, { transaction });
  }

  let doctorClinica = await db.DoctorClinica.findOne({
    where: { doctor_id: user.id_usuario, clinica_id: clinicId },
    transaction,
  });
  if (!doctorClinica) {
    doctorClinica = await db.DoctorClinica.create({
      doctor_id: user.id_usuario,
      clinica_id: clinicId,
      rol_en_clinica: 'Importado ClinicCloud',
      activo: true,
      recibe_citas: true,
    }, { transaction });
    created.doctorClinics += 1;
  } else if (!doctorClinica.activo || !doctorClinica.recibe_citas) {
    await doctorClinica.update({
      activo: true,
      recibe_citas: true,
    }, { transaction });
  }

  if (user.es_provisional) {
    const horarios = scheduleRowsFromAgenda(agendaRow)
      .map((row) => ({ ...row, doctor_clinica_id: doctorClinica.id }));
    await db.DoctorHorario.destroy({ where: { doctor_clinica_id: doctorClinica.id }, transaction });
    if (horarios.length) {
      await db.DoctorHorario.bulkCreate(horarios, { transaction });
      created.doctorSchedules += horarios.length;
    }
  }

  return user;
}

async function ensureInstallationResource({ clinicId, sourceAgendaId, agendaRow, transaction, created, reused }) {
  if (!isInstallationLike(agendaRow)) return null;

  const marker = importedMarker(clinicId, sourceAgendaId);
  const displayName = sourceNameForDisplay(agendaRow, sourceAgendaId);
  let installation = await db.Instalacion.findOne({
    where: {
      clinica_id: clinicId,
      descripcion: { [db.Sequelize.Op.like]: `%${marker}%` },
    },
    transaction,
  });

  if (!installation) {
    installation = await db.Instalacion.create({
      clinica_id: clinicId,
      nombre: displayName,
      tipo: installationTypeFor(agendaRow),
      descripcion: `Importado de ClinicCloud. ${marker}`,
      color: '#64748B',
      capacidad: 1,
      activo: true,
      default_duracion_minutos: Number(agendaRow?.intervalo) || 30,
      especialidades_permitidas: [],
      tratamientos_exclusivos: [],
      equipamiento: ['cliniccloud-import'],
      orden_visualizacion: 900 + (Number(sourceAgendaId) % 100),
    }, { transaction });
    created.installations += 1;

    const horarios = scheduleRowsFromAgenda(agendaRow)
      .map((row) => ({ ...row, instalacion_id: installation.id }));
    if (horarios.length) {
      await db.InstalacionHorario.bulkCreate(horarios, { transaction });
      created.installationSchedules += horarios.length;
    }
  } else {
    reused.installations += 1;
  }

  return installation;
}

async function loadAgendaUsage() {
  const [rows] = await db.sequelize.query(`
    SELECT
      clinica_id,
      JSON_UNQUOTE(JSON_EXTRACT(import_metadata, '$.source_agenda_id')) AS source_agenda_id,
      COUNT(*) AS appointment_count
    FROM CitasPacientes
    WHERE source_system = 'cliniccloud'
      AND clinica_id IN (:clinicIds)
      AND JSON_EXTRACT(import_metadata, '$.source_agenda_id') IS NOT NULL
    GROUP BY clinica_id, source_agenda_id
    ORDER BY clinica_id, CAST(source_agenda_id AS UNSIGNED)
  `, {
    replacements: { clinicIds: TARGET_CLINIC_IDS },
  });
  return rows;
}

async function updateAppointments({ clinicId, sourceAgendaId, doctorId, installationId, transaction }) {
  const replacements = {
    clinicId,
    sourceAgendaId: String(sourceAgendaId),
    doctorId,
    installationId,
    batchId: BATCH_ID,
  };
  const setInstallation = installationId
    ? ', instalacion_id = COALESCE(instalacion_id, :installationId)'
    : '';
  const [result] = await db.sequelize.query(`
    UPDATE CitasPacientes
    SET
      doctor_id = COALESCE(doctor_id, :doctorId)
      ${setInstallation},
      import_metadata = JSON_SET(
        COALESCE(import_metadata, JSON_OBJECT()),
        '$.clinicaclick_agenda_backfill_v1',
        JSON_OBJECT(
          'batch_id', :batchId,
          'doctor_id', :doctorId,
          'instalacion_id', ${installationId ? ':installationId' : 'NULL'},
          'updated_at', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')
        )
      )
    WHERE source_system = 'cliniccloud'
      AND clinica_id = :clinicId
      AND JSON_UNQUOTE(JSON_EXTRACT(import_metadata, '$.source_agenda_id')) = :sourceAgendaId
      AND (
        doctor_id IS NULL
        ${installationId ? 'OR instalacion_id IS NULL' : ''}
        OR JSON_CONTAINS_PATH(COALESCE(import_metadata, JSON_OBJECT()), 'one', '$.clinicaclick_agenda_backfill_v1') = 0
      )
  `, { replacements, transaction });
  return Number(result?.affectedRows || result || 0);
}

async function main() {
  const agendaRows = loadAgendaRows(agendaCsvPath);
  const usage = await loadAgendaUsage();
  const report = {
    batch_id: BATCH_ID,
    mode: execute ? 'execute' : 'dry-run',
    agenda_csv: agendaCsvPath,
    generated_at: new Date().toISOString(),
    usage_count: usage.length,
    mappings: [],
    created: {
      users: 0,
      userClinics: 0,
      doctorClinics: 0,
      doctorSchedules: 0,
      installations: 0,
      installationSchedules: 0,
    },
    reused: {
      users: 0,
      installations: 0,
    },
    appointments_updated: 0,
  };

  const work = async (transaction) => {
    for (const row of usage) {
      const clinicId = Number(row.clinica_id);
      const sourceAgendaId = String(row.source_agenda_id);
      const agendaRow = agendaRows.get(sourceAgendaId) || { idAgenda: sourceAgendaId, nombre: `Agenda ClinicCloud ${sourceAgendaId}` };
      const doctor = await ensureDoctorResource({
        clinicId,
        sourceAgendaId,
        agendaRow,
        transaction,
        created: report.created,
        reused: report.reused,
      });
      const installation = await ensureInstallationResource({
        clinicId,
        sourceAgendaId,
        agendaRow,
        transaction,
        created: report.created,
        reused: report.reused,
      });
      const appointmentsUpdated = await updateAppointments({
        clinicId,
        sourceAgendaId,
        doctorId: doctor.id_usuario,
        installationId: installation?.id || null,
        transaction,
      });
      report.appointments_updated += appointmentsUpdated;
      report.mappings.push({
        clinic_id: clinicId,
        source_agenda_id: sourceAgendaId,
        source_name: sourceNameForDisplay(agendaRow, sourceAgendaId),
        appointment_count: Number(row.appointment_count || 0),
        doctor_id: doctor.id_usuario,
        doctor_name: `${doctor.nombre || ''} ${doctor.apellidos || ''}`.trim(),
        provisional_user: !!doctor.es_provisional,
        installation_id: installation?.id || null,
        installation_name: installation?.nombre || null,
        appointments_updated: appointmentsUpdated,
      });
    }
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

  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${BATCH_ID}-${execute ? 'execute' : 'dry-run'}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    report_path: reportPath,
    mode: report.mode,
    mappings: report.mappings.length,
    created: report.created,
    reused: report.reused,
    appointments_updated: report.appointments_updated,
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
