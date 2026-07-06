'use strict';

const db = require('../../models');
const { Op } = db.Sequelize;
const {
  addDays,
  buildHorarioExceptionMap,
  eachDateInclusive,
  expandHorariosForRange,
  normalizeDateOnly,
} = require('../lib/personal-schedule-recurring');

const {
  CitaPaciente,
  Clinica,
  ClinicMetaAsset,
  DoctorClinica,
  DoctorHorario,
  DoctorHorarioExcepcion,
  Instalacion,
  LeadIntake,
  PatientConsentDocument,
  Paciente,
  Tratamiento,
  Usuario,
  UsuarioClinica,
  BusinessProfileReview,
  Campaign,
  ClinicBusinessLocation,
  AutomationFlow,
} = db;

const ATTENDANCE_OPEN_STATUSES = new Set([
  'pendiente',
  'info_enviada',
  'info_confirmada',
  'recordatorio_enviado',
  'recordatorio_confirmado',
]);
const CANCELLED_STATUSES = new Set(['cancelada', 'reprogramada']);
const UNCONFIRMED_TODAY_STATUSES = ['pendiente', 'info_enviada', 'recordatorio_enviado'];
const PENDING_CONSENT_STATUSES = ['pending', 'sent', 'viewed'];

function toInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueInts(values) {
  return [...new Set((values || []).map(toInt).filter(Boolean))];
}

function scopedWhere(field, ids) {
  const cleanIds = uniqueInts(ids);
  if (!cleanIds.length) return {};
  return { [field]: cleanIds.length === 1 ? cleanIds[0] : { [Op.in]: cleanIds } };
}

function parseCsvIds(raw) {
  if (raw == null) return [];
  return uniqueInts(String(raw).split(',').map((part) => part.trim()));
}

function dateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dayRange(dateValue) {
  const normalized = normalizeDateOnly(dateValue) || dateOnly(new Date());
  const base = normalized ? new Date(`${normalized}T00:00:00`) : new Date();
  base.setHours(0, 0, 0, 0);
  const end = new Date(base);
  end.setHours(23, 59, 59, 999);
  return { start: base, end, date: dateOnly(base) };
}

function startOfWeek(dateIso) {
  const base = normalizeDateOnly(dateIso) ? new Date(`${dateIso}T00:00:00`) : new Date();
  const day = base.getDay() || 7;
  base.setDate(base.getDate() - day + 1);
  base.setHours(0, 0, 0, 0);
  return dateOnly(base);
}

function fullName(row, fallback = '') {
  const name = [row?.nombre, row?.apellidos].filter(Boolean).join(' ').trim();
  return name || fallback;
}

function doctorShort(row) {
  const name = String(row?.nombre || '').trim();
  const surname = String(row?.apellidos || '').trim();
  if (!name && !surname) return '';
  return [name, surname ? `${surname[0]}.` : ''].filter(Boolean).join(' ');
}

function timeLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin hora';
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(dateIso) {
  const date = normalizeDateOnly(dateIso) ? new Date(`${dateIso}T12:00:00Z`) : null;
  if (!date) return dateIso || '';
  return date.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function statusUi(rawStatus) {
  switch (String(rawStatus || '').toLowerCase()) {
    case 'info_enviada':
      return { status: 'sent', label: 'Info enviada' };
    case 'info_confirmada':
      return { status: 'confirmed', label: 'Confirmada' };
    case 'recordatorio_enviado':
      return { status: 'reminder-sent', label: 'Recordatorio' };
    case 'recordatorio_confirmado':
      return { status: 'reminder-confirmed', label: 'Confirmada' };
    case 'completada':
      return { status: 'attended', label: 'Acudió' };
    case 'no_asistio':
      return { status: 'no-show', label: 'No asistio' };
    case 'cancelada':
      return { status: 'cancelled', label: 'Cancelada' };
    case 'reprogramada':
      return { status: 'reschedule', label: 'Reprogramada' };
    case 'pendiente':
    default:
      return { status: 'created', label: 'Pendiente' };
  }
}

function normalizeSubrolCode(label) {
  const value = String(label || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value.includes('doctor')) return 'doctor';
  if (value.includes('auxiliar') || value.includes('enfermer')) return 'assistant';
  if (value.includes('recep') || value.includes('comercial')) return 'reception';
  if (value.includes('admin')) return 'admin_staff';
  return 'unknown';
}

async function loadUserContext({ userId, requestedClinicIds, requestedRole, requestedSubrol }) {
  const [user, memberships] = await Promise.all([
    userId && Usuario
      ? Usuario.findByPk(userId, {
          attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar', 'cargo_usuario'],
          raw: true,
        })
      : null,
    userId && UsuarioClinica
      ? UsuarioClinica.findAll({
          where: { id_usuario: userId },
          attributes: ['id_usuario', 'id_clinica', 'rol_clinica', 'subrol_clinica'],
          raw: true,
        })
      : [],
  ]);

  const selectedMembership =
    memberships.find((row) => requestedClinicIds.includes(Number(row.id_clinica))) ||
    memberships[0] ||
    null;

  const role = String(requestedRole || selectedMembership?.rol_clinica || '').trim().toLowerCase();
  const subrolLabel = String(requestedSubrol || selectedMembership?.subrol_clinica || '').trim();
  const subrolCode = normalizeSubrolCode(subrolLabel);

  return {
    user: user
      ? {
          id: user.id_usuario,
          name: fullName(user, user.email_usuario || 'Usuario'),
          firstName: String(user.nombre || '').trim() || 'Usuario',
          email: user.email_usuario || null,
          avatar: user.avatar || null,
          title: user.cargo_usuario || null,
        }
      : {
          id: userId || null,
          name: 'Usuario',
          firstName: 'Usuario',
          email: null,
          avatar: null,
          title: null,
        },
    role,
    subrolLabel,
    subrolCode,
    memberships,
  };
}

async function resolveClinicScope(rawScope, memberships) {
  const raw = String(rawScope || '').trim();
  let clinicIds = [];

  if (raw && raw !== 'all') {
    if (raw.startsWith('group:') && Clinica) {
      const groupId = toInt(raw.slice(6));
      if (groupId) {
        const rows = await Clinica.findAll({
          where: { grupoClinicaId: groupId },
          attributes: ['id_clinica'],
          raw: true,
        });
        clinicIds = rows.map((row) => row.id_clinica);
      }
    } else {
      clinicIds = parseCsvIds(raw);
    }
  }

  if (!clinicIds.length) {
    clinicIds = uniqueInts((memberships || []).map((row) => row.id_clinica));
  }

  const clinics = clinicIds.length && Clinica
    ? await Clinica.findAll({
        where: scopedWhere('id_clinica', clinicIds),
        attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'url_ficha_local', 'grupoClinicaId'],
        raw: true,
      })
    : [];

  const resolvedIds = uniqueInts(clinics.map((row) => row.id_clinica));
  return {
    clinicIds: resolvedIds,
    clinics,
    clinicMap: new Map(clinics.map((row) => [Number(row.id_clinica), row])),
    groupIds: uniqueInts(clinics.map((row) => row.grupoClinicaId)),
  };
}

async function loadAppointmentMaps(rows, clinicMap) {
  const patientIds = uniqueInts(rows.map((row) => row.paciente_id));
  const doctorIds = uniqueInts(rows.map((row) => row.doctor_id));
  const installationIds = uniqueInts(rows.map((row) => row.instalacion_id));
  const treatmentIds = uniqueInts(rows.map((row) => row.tratamiento_id));

  const [patients, doctors, installations, treatments] = await Promise.all([
    patientIds.length && Paciente
      ? Paciente.findAll({
          where: scopedWhere('id_paciente', patientIds),
          attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos', 'foto'],
          raw: true,
        })
      : [],
    doctorIds.length && Usuario
      ? Usuario.findAll({
          where: scopedWhere('id_usuario', doctorIds),
          attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'],
          raw: true,
        })
      : [],
    installationIds.length && Instalacion
      ? Instalacion.findAll({
          where: scopedWhere('id', installationIds),
          attributes: ['id', 'nombre', 'color'],
          raw: true,
        })
      : [],
    treatmentIds.length && Tratamiento
      ? Tratamiento.findAll({
          where: scopedWhere('id_tratamiento', treatmentIds),
          attributes: ['id_tratamiento', 'nombre', 'disciplina', 'especialidad', 'color'],
          raw: true,
        })
      : [],
  ]);

  return {
    patients: new Map(patients.map((row) => [Number(row.id_paciente), row])),
    doctors: new Map(doctors.map((row) => [Number(row.id_usuario), row])),
    installations: new Map(installations.map((row) => [Number(row.id), row])),
    treatments: new Map(treatments.map((row) => [Number(row.id_tratamiento), row])),
    clinics: clinicMap,
  };
}

function mapAppointment(row, maps, now) {
  const patient = maps.patients.get(Number(row.paciente_id));
  const doctor = maps.doctors.get(Number(row.doctor_id));
  const installation = maps.installations.get(Number(row.instalacion_id));
  const treatment = maps.treatments.get(Number(row.tratamiento_id));
  const clinic = maps.clinics.get(Number(row.clinica_id));
  const ui = statusUi(row.estado);
  const start = row.inicio instanceof Date ? row.inicio : new Date(row.inicio);
  const end = row.fin instanceof Date ? row.fin : new Date(row.fin || row.inicio);
  const date = dateOnly(start);
  const appointmentId = Number(row.id_cita);

  return {
    id: String(appointmentId),
    appointmentId,
    patientId: Number(row.paciente_id) || null,
    patientName: fullName(patient, `Paciente ${row.paciente_id}`),
    patientAvatar: patient?.foto || null,
    doctorId: Number(row.doctor_id) || null,
    doctorName: fullName(doctor, 'Profesional'),
    doctorShort: doctorShort(doctor),
    clinicId: Number(row.clinica_id) || null,
    clinicName: clinic?.nombre_clinica || `Clínica ${row.clinica_id}`,
    installationId: Number(row.instalacion_id) || null,
    installationName: installation?.nombre || null,
    treatmentId: Number(row.tratamiento_id) || null,
    treatment: treatment?.nombre || row.motivo || row.titulo || null,
    specialty: treatment?.especialidad || treatment?.disciplina || null,
    timeLabel: timeLabel(start),
    timeISO: Number.isNaN(start.getTime()) ? null : start.toISOString(),
    endTimeISO: Number.isNaN(end.getTime()) ? null : end.toISOString(),
    date,
    status: ui.status,
    statusLabel: ui.label,
    rawStatus: row.estado || null,
    visualType: 'normal',
    attendanceDue:
      ATTENDANCE_OPEN_STATUSES.has(String(row.estado || '').toLowerCase()) &&
      !Number.isNaN(end.getTime()) &&
      end.getTime() <= now.getTime(),
    agendaQuery: {
      fecha: date,
      cita_id: appointmentId,
      action: 'view',
      clinica_id: row.clinica_id,
    },
  };
}

async function loadAppointments({ clinicIds, clinicMap, todayStart, todayEnd, now }) {
  if (!clinicIds.length || !CitaPaciente) {
    return { today: [], pastAttendance: [], next: [] };
  }

  const pastStart = new Date(todayStart);
  pastStart.setDate(pastStart.getDate() - 14);

  const appointmentAttributes = [
    'id_cita', 'clinica_id', 'paciente_id', 'doctor_id', 'instalacion_id',
    'tratamiento_id', 'titulo', 'motivo', 'tipo_cita', 'estado', 'inicio', 'fin',
  ];

  const [todayRows, pastRows, nextRows] = await Promise.all([
    CitaPaciente.findAll({
      where: {
        ...scopedWhere('clinica_id', clinicIds),
        inicio: { [Op.between]: [todayStart, todayEnd] },
      },
      attributes: appointmentAttributes,
      order: [['inicio', 'ASC']],
      raw: true,
    }),
    CitaPaciente.findAll({
      where: {
        ...scopedWhere('clinica_id', clinicIds),
        fin: { [Op.between]: [pastStart, now] },
        estado: { [Op.in]: [...ATTENDANCE_OPEN_STATUSES] },
      },
      attributes: appointmentAttributes,
      order: [['fin', 'DESC']],
      limit: 30,
      raw: true,
    }),
    CitaPaciente.findAll({
      where: {
        ...scopedWhere('clinica_id', clinicIds),
        inicio: { [Op.gt]: todayEnd },
        estado: { [Op.notIn]: [...CANCELLED_STATUSES] },
      },
      attributes: appointmentAttributes,
      order: [['inicio', 'ASC']],
      limit: 4,
      raw: true,
    }),
  ]);

  const allRows = [...todayRows, ...pastRows, ...nextRows];
  const maps = await loadAppointmentMaps(allRows, clinicMap);

  return {
    today: todayRows
      .filter((row) => !CANCELLED_STATUSES.has(String(row.estado || '').toLowerCase()))
      .map((row) => mapAppointment(row, maps, now)),
    pastAttendance: pastRows
      .filter((row) => !CANCELLED_STATUSES.has(String(row.estado || '').toLowerCase()))
      .map((row) => mapAppointment(row, maps, now))
      .filter((item) => item.attendanceDue),
    next: nextRows.map((row) => mapAppointment(row, maps, now)),
  };
}

async function countTasks({ clinicIds, todayStart, todayEnd }) {
  if (!clinicIds.length) {
    return { leadsPending: 0, pendingConsents: 0, pendingReviews: 0 };
  }

  const [leadsPending, pendingConsents, pendingReviews] = await Promise.all([
    LeadIntake
      ? LeadIntake.count({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            status_lead: { [Op.in]: ['nuevo', 'esperando_info', 'info_recibida'] },
            num_contactos: 0,
          },
        })
      : 0,
    PatientConsentDocument
      ? PatientConsentDocument.count({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            status: { [Op.in]: PENDING_CONSENT_STATUSES },
          },
        })
      : 0,
    BusinessProfileReview
      ? BusinessProfileReview.count({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            has_reply: false,
          },
        })
      : 0,
  ]);

  const unconfirmedToday = CitaPaciente
    ? await CitaPaciente.count({
        where: {
          ...scopedWhere('clinica_id', clinicIds),
          inicio: { [Op.between]: [todayStart, todayEnd] },
          estado: { [Op.in]: UNCONFIRMED_TODAY_STATUSES },
        },
      })
    : 0;

  return { leadsPending, pendingConsents, pendingReviews, unconfirmedToday };
}

function taskItems(counts, todayDate, clinicIds, pendingAttendanceCount = 0) {
  const singleClinicId = clinicIds.length === 1 ? clinicIds[0] : null;
  const pendingAttendance = Number(pendingAttendanceCount || 0);
  const items = [
    ...(pendingAttendance > 0
      ? [{
          id: 'pending_attendance',
          label: 'Citas pendientes de cerrar asistencia',
          count: pendingAttendance,
          link: '/agenda-de-citas',
          queryParams: { clinica_id: singleClinicId },
        }]
      : []),
    {
      id: 'leads_pending',
      label: 'Leads sin contactar',
      count: counts.leadsPending || 0,
      link: '/marketing/leads',
      queryParams: { status: 'nuevo', contactado: '0' },
    },
    {
      id: 'unconfirmed_today',
      label: 'Pacientes sin confirmar cita hoy',
      count: counts.unconfirmedToday || 0,
      link: '/agenda-de-citas',
      queryParams: { fecha: todayDate, clinica_id: singleClinicId },
    },
    {
      id: 'pending_consents',
      label: 'Consentimientos sin firmar',
      count: counts.pendingConsents || 0,
      link: '/consentimientos',
      queryParams: { tab: 'pendientes', clinica_id: singleClinicId },
    },
    {
      id: 'pending_reviews',
      label: 'Reseñas Google sin contestar',
      count: counts.pendingReviews || 0,
      link: '/marketing/perfil-google',
      queryParams: { reviews: 'unanswered', clinica_id: singleClinicId },
    },
  ];

  return items;
}

async function loadPendingConsentCards({ clinicIds, doctorId = null, limit = 6 }) {
  if (!clinicIds.length || !PatientConsentDocument) return [];

  const docs = await PatientConsentDocument.findAll({
    where: {
      ...scopedWhere('clinica_id', clinicIds),
      status: { [Op.in]: PENDING_CONSENT_STATUSES },
    },
    attributes: ['id', 'public_id', 'paciente_id', 'clinica_id', 'cita_id', 'tratamiento_id', 'title', 'status', 'updatedAt'],
    order: [['updatedAt', 'DESC']],
    limit: doctorId ? 80 : limit,
    raw: true,
  });

  if (!docs.length) return [];

  let filtered = docs;
  if (doctorId && CitaPaciente) {
    const citaIds = uniqueInts(docs.map((doc) => doc.cita_id));
    const citas = citaIds.length
      ? await CitaPaciente.findAll({
          where: {
            ...scopedWhere('id_cita', citaIds),
            doctor_id: doctorId,
          },
          attributes: ['id_cita'],
          raw: true,
        })
      : [];
    const allowed = new Set(citas.map((row) => Number(row.id_cita)));
    filtered = docs.filter((doc) => allowed.has(Number(doc.cita_id))).slice(0, limit);
  } else {
    filtered = docs.slice(0, limit);
  }

  const patientIds = uniqueInts(filtered.map((doc) => doc.paciente_id));
  const treatmentIds = uniqueInts(filtered.map((doc) => doc.tratamiento_id));
  const [patients, treatments] = await Promise.all([
    patientIds.length && Paciente
      ? Paciente.findAll({
          where: scopedWhere('id_paciente', patientIds),
          attributes: ['id_paciente', 'nombre', 'apellidos'],
          raw: true,
        })
      : [],
    treatmentIds.length && Tratamiento
      ? Tratamiento.findAll({
          where: scopedWhere('id_tratamiento', treatmentIds),
          attributes: ['id_tratamiento', 'nombre'],
          raw: true,
        })
      : [],
  ]);

  const patientMap = new Map(patients.map((row) => [Number(row.id_paciente), row]));
  const treatmentMap = new Map(treatments.map((row) => [Number(row.id_tratamiento), row]));

  return filtered.map((doc) => {
    const patient = patientMap.get(Number(doc.paciente_id));
    const treatment = treatmentMap.get(Number(doc.tratamiento_id));
    return {
      id: doc.id,
      publicId: doc.public_id,
      title: doc.title,
      status: doc.status,
      patientId: Number(doc.paciente_id) || null,
      patientName: fullName(patient, `Paciente ${doc.paciente_id}`),
      treatmentName: treatment?.nombre || 'Sin tratamiento asignado',
      updatedAt: doc.updatedAt || null,
      link: '/consentimientos',
    };
  });
}

async function loadWeeklySchedule({ clinicIds, clinicMap, userId, todayIso }) {
  if (!userId || !clinicIds.length || !DoctorClinica || !DoctorHorario) return [];

  const from = startOfWeek(todayIso);
  const to = addDays(from, 6);
  const doctorClinics = await DoctorClinica.findAll({
    where: {
      doctor_id: userId,
      activo: true,
      ...scopedWhere('clinica_id', clinicIds),
    },
    attributes: ['id', 'doctor_id', 'clinica_id'],
    raw: true,
  });
  const doctorClinicIds = uniqueInts(doctorClinics.map((row) => row.id));
  if (!doctorClinicIds.length) return [];

  const [horarios, exceptions] = await Promise.all([
    DoctorHorario.findAll({
      where: {
        ...scopedWhere('doctor_clinica_id', doctorClinicIds),
        activo: true,
      },
      attributes: ['id', 'doctor_clinica_id', 'dia_semana', 'activo', 'hora_inicio', 'hora_fin', 'rrule', 'fecha_inicio_vigencia', 'fecha_fin_vigencia'],
      raw: true,
    }),
    DoctorHorarioExcepcion
      ? DoctorHorarioExcepcion.findAll({
          where: {
            fecha: { [Op.between]: [from, to] },
          },
          attributes: ['id', 'doctor_horario_id', 'fecha', 'cancelado', 'hora_inicio_override', 'hora_fin_override'],
          raw: true,
        })
      : [],
  ]);

  const doctorClinicMap = new Map(doctorClinics.map((row) => [Number(row.id), row]));
  const exceptionMap = buildHorarioExceptionMap(exceptions);
  const expanded = expandHorariosForRange(horarios, from, to, exceptionMap);

  return expanded.map((slot) => {
    const doctorClinic = doctorClinicMap.get(Number(slot.doctor_clinica_id));
    const clinic = clinicMap.get(Number(doctorClinic?.clinica_id));
    return {
      date: slot.fecha,
      dayLabel: dayLabel(slot.fecha),
      clinicId: Number(doctorClinic?.clinica_id) || null,
      clinicName: clinic?.nombre_clinica || 'Clínica',
      start: slot.hora_inicio,
      end: slot.hora_fin,
    };
  });
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function hasMissingPaymentSignal(additional) {
  const payment = parseJsonObject(additional.payment || additional.payment_method || additional.paymentMethod);
  const status = String(payment.status || payment.state || payment.code || '').toLowerCase();
  const errorCode = String(
    payment.error_code ||
    payment.code ||
    additional.wa_error?.code ||
    additional.last_error?.code ||
    additional.lastError?.code ||
    ''
  );
  return status.includes('missing') || status.includes('required') || errorCode === '131042';
}

async function loadWhatsappStatus({ clinicIds, groupIds }) {
  if (!ClinicMetaAsset || (!clinicIds.length && !groupIds.length)) {
    return { connected: null, paymentReady: null, paymentMissing: false };
  }
  const scopeOr = [];
  if (clinicIds.length) {
    scopeOr.push({ clinicaId: { [Op.in]: clinicIds } });
  }
  if (groupIds.length) {
    scopeOr.push({ assignmentScope: 'group', grupoClinicaId: { [Op.in]: groupIds } });
  }
  if (!scopeOr.length) return null;

  const assets = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
      [Op.or]: scopeOr,
    },
    attributes: ['id', 'assetType', 'phoneNumberId', 'wabaId', 'additionalData', 'assignmentScope'],
    raw: true,
  });

  const connected = assets.some((asset) => {
    const additional = parseJsonObject(asset.additionalData);
    const status = String(
      additional.status ||
      additional.whatsapp_status ||
      additional.connection_status ||
      additional.coexistence?.status ||
      ''
    ).toLowerCase();
    return Boolean(asset.phoneNumberId || asset.wabaId || ['connected', 'live', 'active'].includes(status));
  });
  const paymentMissing = assets.some((asset) => hasMissingPaymentSignal(parseJsonObject(asset.additionalData)));

  return {
    connected,
    paymentReady: connected && !paymentMissing,
    paymentMissing,
  };
}

async function loadSetupStatus({ clinicIds, groupIds, clinics, whatsappStatus }) {
  if (!clinicIds.length) {
    return { total: 0, completed: 0, items: [] };
  }

  const treatmentScope = [];
  if (clinicIds.length) {
    treatmentScope.push({ clinica_id: { [Op.in]: clinicIds } });
  }
  if (groupIds.length) {
    treatmentScope.push({ grupo_clinica_id: { [Op.in]: groupIds } });
  }

  const [localProfileCount, staffCount, doctorClinics, installationCount, treatmentCount, appointmentCount] = await Promise.all([
    ClinicBusinessLocation
      ? ClinicBusinessLocation.count({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            is_active: true,
          },
        })
      : 0,
    UsuarioClinica
      ? UsuarioClinica.count({
          where: {
            ...scopedWhere('id_clinica', clinicIds),
            rol_clinica: 'personaldeclinica',
          },
        })
      : 0,
    DoctorClinica
      ? DoctorClinica.findAll({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            activo: true,
          },
          attributes: ['id'],
          raw: true,
        })
      : [],
    Instalacion
      ? Instalacion.count({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            activo: true,
          },
        })
      : 0,
    Tratamiento && treatmentScope.length
      ? Tratamiento.count({
          where: {
            activo: true,
            [Op.or]: treatmentScope,
          },
        })
      : 0,
    CitaPaciente
      ? CitaPaciente.count({
          where: scopedWhere('clinica_id', clinicIds),
        })
      : 0,
  ]);

  const doctorClinicIds = uniqueInts(doctorClinics.map((row) => row.id));
  const scheduleCount = doctorClinicIds.length && DoctorHorario
    ? await DoctorHorario.count({
        where: {
          ...scopedWhere('doctor_clinica_id', doctorClinicIds),
          activo: true,
        },
      })
    : 0;

  const hasLocalProfile = localProfileCount > 0 || (clinics || []).some((clinic) => String(clinic.url_ficha_local || '').trim());
  const items = [
    {
      id: 'whatsapp_connected',
      label: 'Conectar WhatsApp',
      description: 'Necesario para plantillas, confirmaciones y recordatorios automáticos.',
      completed: whatsappStatus.connected === true,
      link: '/ajustes',
      queryParams: { tab: 'connected-accounts' },
      actionLabel: 'Conectar',
    },
    {
      id: 'whatsapp_payment',
      label: 'Validar método de pago de WhatsApp',
      description: 'Evita bloqueos de envío por facturación de Meta.',
      completed: whatsappStatus.paymentReady === true,
      severity: whatsappStatus.paymentMissing ? 'critical' : 'normal',
      link: '/ajustes',
      queryParams: { tab: 'connected-accounts' },
      actionLabel: 'Revisar',
    },
    {
      id: 'local_profile',
      label: 'Conectar ficha local',
      description: 'Permite medir reseñas, visibilidad local y llamadas desde Google.',
      completed: hasLocalProfile,
      link: '/marketing/perfil-google',
      actionLabel: 'Ver ficha',
    },
    {
      id: 'staff',
      label: 'Dar de alta al personal',
      description: 'Añade doctores, recepción y auxiliares con su rol operativo.',
      completed: staffCount > 0,
      link: '/personal',
      actionLabel: 'Personal',
    },
    {
      id: 'schedules',
      label: 'Publicar horarios',
      description: 'Define disponibilidad para que agenda y recordatorios funcionen bien.',
      completed: scheduleCount > 0,
      link: '/personal',
      actionLabel: 'Horarios',
    },
    {
      id: 'installations',
      label: 'Configurar instalaciones',
      description: 'Boxes, salas y recursos que condicionan la agenda.',
      completed: installationCount > 0,
      link: '/instalaciones',
      actionLabel: 'Instalaciones',
    },
    {
      id: 'treatments',
      label: 'Configurar tratamientos',
      description: 'Duración, precio base y reglas clínicas de los servicios.',
      completed: treatmentCount > 0,
      link: '/catalogo-tratamientos',
      actionLabel: 'Tratamientos',
    },
    {
      id: 'appointments',
      label: 'Comenzar a dar citas',
      description: 'La operativa diaria empieza cuando la agenda ya tiene citas reales.',
      completed: appointmentCount > 0,
      link: '/agenda-de-citas',
      actionLabel: 'Agenda',
    },
  ];

  return {
    total: items.length,
    completed: items.filter((item) => item.completed).length,
    items,
  };
}

async function loadOpportunities({ clinicIds }) {
  if (!clinicIds.length) return [];

  const [activeCampaigns, activeFlows] = await Promise.all([
    Campaign
      ? Campaign.findAll({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            activa: true,
          },
          attributes: ['id', 'nombre', 'tipo'],
          raw: true,
        })
      : [],
    AutomationFlow
      ? AutomationFlow.findAll({
          where: {
            ...scopedWhere('clinica_id', clinicIds),
            activo: true,
            estado: 'activo',
          },
          attributes: ['id', 'nombre', 'disparador'],
          raw: true,
        })
      : [],
  ]);

  const flowsText = activeFlows.map((flow) => `${flow.nombre || ''} ${flow.disparador || ''}`.toLowerCase()).join(' ');
  const opportunities = [];
  if (!activeCampaigns.length) {
    opportunities.push({
      id: 'new_patients',
      title: 'No tienes campañas activas ni automatizaciones para captar nuevos pacientes.',
      subtitle: 'Activa una estrategia de captación desde Marketing > Campañas.',
      link: '/marketing/campanas',
      actionLabel: 'Ver campañas',
    });
  }
  if (!flowsText.includes('reactiv')) {
    opportunities.push({
      id: 'reactivate_patients',
      title: 'No tienes campañas de reactivación de pacientes programadas.',
      subtitle: 'Prepara una audiencia de pacientes históricos para recuperar actividad.',
      link: '/marketing/campanas',
      actionLabel: 'Ver cómo funciona',
    });
  }
  if (!flowsText.includes('resena') && !flowsText.includes('reseña') && !flowsText.includes('review')) {
    opportunities.push({
      id: 'get_reviews',
      title: 'No tienes automatizaciones para conseguir reseñas.',
      subtitle: 'Configura la solicitud de reseñas tras tratamientos completados.',
      link: '/marketing/campanas',
      actionLabel: 'Configurar',
    });
  }
  return opportunities;
}

function roleSections(role, subrolCode) {
  const normalizedRole = String(role || '').toLowerCase();
  const ownerLike = ['administrador', 'propietario', 'agencia'].includes(normalizedRole);
  const operations =
    ownerLike ||
    ['assistant', 'reception', 'admin_staff'].includes(subrolCode);
  const doctor = normalizedRole === 'personaldeclinica' && subrolCode === 'doctor';
  const shared = !['paciente', 'laboratorio'].includes(normalizedRole);
  return { ownerLike, operations, doctor, shared };
}

async function getMainDashboard({ userId, query = {} }) {
  const requestedScope = query.clinica_id || query.clinic_id || query.clinicId || null;
  const firstRequestedClinicIds = requestedScope && String(requestedScope) !== 'all' && !String(requestedScope).startsWith('group:')
    ? parseCsvIds(requestedScope)
    : [];
  const today = dayRange(query.date || query.fecha);
  const now = new Date();

  const context = await loadUserContext({
    userId,
    requestedClinicIds: firstRequestedClinicIds,
    requestedRole: query.role,
    requestedSubrol: query.subrol,
  });

  const scope = await resolveClinicScope(requestedScope, context.memberships);
  const sections = roleSections(context.role, context.subrolCode);
  const appointments = await loadAppointments({
    clinicIds: scope.clinicIds,
    clinicMap: scope.clinicMap,
    todayStart: today.start,
    todayEnd: today.end,
    now,
  });
  const counts = await countTasks({
    clinicIds: scope.clinicIds,
    todayStart: today.start,
    todayEnd: today.end,
  });

  const doctorId = sections.doctor ? userId : null;
  const [
    pendingPatientConsents,
    doctorPendingConsents,
    weeklySchedule,
    whatsappStatus,
    opportunities,
  ] = await Promise.all([
    loadPendingConsentCards({ clinicIds: scope.clinicIds, limit: 6 }),
    doctorId ? loadPendingConsentCards({ clinicIds: scope.clinicIds, doctorId, limit: 6 }) : [],
    doctorId ? loadWeeklySchedule({ clinicIds: scope.clinicIds, clinicMap: scope.clinicMap, userId: doctorId, todayIso: today.date }) : [],
    loadWhatsappStatus({ clinicIds: scope.clinicIds, groupIds: scope.groupIds }),
    loadOpportunities({ clinicIds: scope.clinicIds }),
  ]);

  const setup = await loadSetupStatus({
    clinicIds: scope.clinicIds,
    groupIds: scope.groupIds,
    clinics: scope.clinics,
    whatsappStatus,
  });

  const doctorAppointments = doctorId
    ? appointments.today.filter((item) => Number(item.doctorId) === Number(doctorId))
    : [];

  const errors = [];
  if (whatsappStatus.connected === false) {
    errors.push({
      id: 'whatsapp_not_connected',
      title: 'No tienes WhatsApp conectado',
      subtitle: 'Conecta o asigna el numero para enviar plantillas y automatizaciones.',
      link: '/ajustes',
      queryParams: { tab: 'connected-accounts' },
      actionLabel: 'Ir a Cuentas conectadas',
    });
  } else if (whatsappStatus.paymentMissing) {
    errors.push({
      id: 'whatsapp_payment_missing',
      title: 'WhatsApp no tiene método de pago activo',
      subtitle: 'Meta puede bloquear plantillas y recordatorios hasta que se configure la facturación.',
      link: '/ajustes',
      queryParams: { tab: 'connected-accounts' },
      actionLabel: 'Revisar pago',
    });
  }

  const dashboardTasks = taskItems(counts, today.date, scope.clinicIds, appointments.pastAttendance.length);

  return {
    user: context.user,
    role: {
      code: context.role || null,
      label: context.role || 'usuario',
      subrolLabel: context.subrolLabel || null,
      subrolCode: context.subrolCode,
    },
    scope: {
      clinicIds: scope.clinicIds,
      clinicName: scope.clinics.length === 1 ? scope.clinics[0].nombre_clinica : 'Clínicas seleccionadas',
      clinicAvatar: scope.clinics.length === 1 ? scope.clinics[0].url_avatar || null : null,
      date: today.date,
    },
    sections: {
      showOperations: sections.operations,
      showDoctor: sections.doctor,
      showShared: sections.shared,
      showOwnerFeedback: sections.ownerLike,
    },
    todayAppointments: appointments.today,
    nextAppointments: appointments.next,
    pastAttendancePending: appointments.pastAttendance,
    doctorAppointmentsToday: doctorAppointments,
    pendingPatientConsents,
    doctorPendingConsents,
    weeklySchedule,
    tasks: {
      items: dashboardTasks,
      total: dashboardTasks.reduce((total, item) => total + Number(item.count || 0), 0),
    },
    setup,
    criticalAlerts: errors,
    growthOpportunities: opportunities,
    opportunities,
    errors,
    feedback: [],
    meta: {
      generatedAt: new Date().toISOString(),
      source: 'backend',
    },
  };
}

module.exports = {
  getMainDashboard,
};
