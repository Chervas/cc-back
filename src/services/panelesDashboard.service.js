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
const { isGlobalAdmin } = require('../lib/role-helpers');
const { getAccessibleClinicIdsForFeature } = require('../lib/access-policy');
const {
  DEFAULT_TIME_ZONE,
  addLocalDays,
  localDateTimeToUtc,
  resolveClinicTimeZone,
} = require('./clinicOpeningHours.service');
const personalPresenceService = require('./personalPresence.service');

const {
  AccountingCashSession,
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
  'cambio_solicitado',
]);
const CANCELLED_STATUSES = new Set(['cancelada', 'reprogramada']);
const CLOSED_ATTENDANCE_STATUSES = new Set(['completada', 'no_asistio']);
const UNCONFIRMED_TODAY_STATUSES = ['pendiente', 'info_enviada', 'recordatorio_enviado'];
const PENDING_CONSENT_STATUSES = ['pending', 'sent', 'viewed'];

function toInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueInts(values) {
  return [...new Set((values || []).map(toInt).filter(Boolean))];
}

function intersectClinicIds(...collections) {
  if (!collections.length) return [];
  const normalized = collections.map((values) => uniqueInts(values));
  return normalized[0].filter((clinicId) => (
    normalized.slice(1).every((values) => values.includes(clinicId))
  ));
}

function unionClinicIds(...collections) {
  return uniqueInts(collections.flat());
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

function dateOnly(date, timeZone = DEFAULT_TIME_ZONE) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayRange(dateValue, timeZone = DEFAULT_TIME_ZONE) {
  const normalized = normalizeDateOnly(dateValue) || dateOnly(new Date(), timeZone);
  const nextDate = addLocalDays(normalized, 1);
  const start = localDateTimeToUtc(normalized, '00:00:00', timeZone);
  const nextStart = localDateTimeToUtc(nextDate, '00:00:00', timeZone);
  const end = new Date(nextStart.getTime() - 1);
  return { start, end, date: normalized, timeZone };
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

function timeLabel(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin hora';
  return date.toLocaleTimeString('es-ES', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function buildClinicDayRanges({ clinicIds, clinicMap, dateValue }) {
  const grouped = new Map();
  for (const clinicId of uniqueInts(clinicIds)) {
    const clinic = clinicMap instanceof Map ? clinicMap.get(clinicId) : null;
    const timeZone = resolveClinicTimeZone(clinic);
    const range = dayRange(dateValue, timeZone);
    const key = `${range.start.toISOString()}|${range.end.toISOString()}`;
    if (!grouped.has(key)) {
      grouped.set(key, { ...range, clinicIds: [] });
    }
    grouped.get(key).clinicIds.push(clinicId);
  }
  return Array.from(grouped.values());
}

function clinicRangeWhere(field, ranges, mode = 'today', now = new Date()) {
  const clauses = (Array.isArray(ranges) ? ranges : []).map((range) => {
    let temporalWhere;
    if (mode === 'next') {
      temporalWhere = { [Op.gt]: range.end };
    } else if (mode === 'past') {
      const pastDate = addLocalDays(range.date, -14);
      const pastStart = localDateTimeToUtc(pastDate, '00:00:00', range.timeZone);
      temporalWhere = { [Op.between]: [pastStart, now] };
    } else {
      temporalWhere = { [Op.between]: [range.start, range.end] };
    }
    return {
      ...scopedWhere('clinica_id', range.clinicIds),
      [field]: temporalWhere,
    };
  });
  return clauses.length ? { [Op.or]: clauses } : { id_cita: null };
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
    case 'cambio_solicitado':
      return { status: 'change-requested', label: 'Cambio solicitado' };
    case 'completada':
      return { status: 'attended', label: 'Acudió' };
    case 'no_asistio':
      return { status: 'no-show', label: 'No asistió' };
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

function panelScopeForbidden() {
  const error = new Error('panel_scope_forbidden');
  error.statusCode = 403;
  return error;
}

async function loadUserContext({ userId, requestedClinicIds }) {
  const globalAdmin = isGlobalAdmin(userId);
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

  const role = String(
    globalAdmin
      ? 'administrador'
      : selectedMembership?.rol_clinica || ''
  ).trim().toLowerCase();
  const subrolLabel = String(
    globalAdmin
      ? (selectedMembership?.subrol_clinica || '')
      : selectedMembership?.subrol_clinica || ''
  ).trim();
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
    globalAdmin,
  };
}

async function resolveClinicScope(rawScope, memberships, { allowAllClinics = false } = {}) {
  const raw = String(rawScope || '').trim();
  let clinicIds = [];
  const accessibleClinicIds = uniqueInts((memberships || []).map((row) => row.id_clinica));
  const explicitScopeRequested = Boolean(raw && raw !== 'all');

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

  if (allowAllClinics && (!raw || raw === 'all') && !clinicIds.length && Clinica) {
    const rows = await Clinica.findAll({
      attributes: ['id_clinica'],
      raw: true,
    });
    clinicIds = rows.map((row) => row.id_clinica);
  }

  if (!allowAllClinics && clinicIds.length) {
    const allowed = new Set(accessibleClinicIds);
    clinicIds = clinicIds.filter((clinicId) => allowed.has(Number(clinicId)));
    if (explicitScopeRequested && !clinicIds.length) {
      throw panelScopeForbidden();
    }
  }

  if (!clinicIds.length) {
    clinicIds = accessibleClinicIds;
  }

  const clinics = clinicIds.length && Clinica
    ? await Clinica.findAll({
        where: scopedWhere('id_clinica', clinicIds),
        attributes: [
          'id_clinica',
          'nombre_clinica',
          'url_avatar',
          'url_ficha_local',
          'grupoClinicaId',
          'configuracion',
        ],
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
  const timeZone = resolveClinicTimeZone(clinic);
  const ui = statusUi(row.estado);
  const start = row.inicio instanceof Date ? row.inicio : new Date(row.inicio);
  const end = row.fin instanceof Date ? row.fin : new Date(row.fin || row.inicio);
  const date = dateOnly(start, timeZone);
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
    timeLabel: timeLabel(start, timeZone),
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

function isExpectedTodayAppointment(item, { includeClosedToday = false } = {}) {
  const status = String(item?.rawStatus || '').toLowerCase();
  if (CANCELLED_STATUSES.has(status)) return false;
  if (includeClosedToday) return true;
  if (CLOSED_ATTENDANCE_STATUSES.has(status)) return false;
  return item?.attendanceDue !== true;
}

function isInactiveTodayAppointment(item, { includeClosedToday = false } = {}) {
  const status = String(item?.rawStatus || '').toLowerCase();
  return CANCELLED_STATUSES.has(status) || (!includeClosedToday && CLOSED_ATTENDANCE_STATUSES.has(status));
}

async function loadAppointments({
  clinicIds,
  clinicMap,
  todayDate,
  now,
  doctorId = null,
  includeToday = true,
  includePastAttendance = true,
  includeNext = true,
  includeClosedToday = false,
}) {
  if (!clinicIds.length || !CitaPaciente || (!includeToday && !includePastAttendance && !includeNext)) {
    return { today: [], inactiveToday: [], pastAttendance: [], next: [] };
  }

  const dayRanges = buildClinicDayRanges({
    clinicIds,
    clinicMap,
    dateValue: todayDate,
  });

  const appointmentAttributes = [
    'id_cita', 'clinica_id', 'paciente_id', 'doctor_id', 'instalacion_id',
    'tratamiento_id', 'titulo', 'motivo', 'tipo_cita', 'estado', 'inicio', 'fin',
  ];
  const doctorScope = doctorId ? { doctor_id: doctorId } : {};

  const [todayRows, pastRows, nextRows] = await Promise.all([
    includeToday
      ? CitaPaciente.findAll({
          where: {
            ...doctorScope,
            ...clinicRangeWhere('inicio', dayRanges, 'today', now),
          },
          attributes: appointmentAttributes,
          order: [['inicio', 'ASC']],
          raw: true,
        })
      : [],
    includePastAttendance
      ? CitaPaciente.findAll({
          where: {
            ...doctorScope,
            ...clinicRangeWhere('fin', dayRanges, 'past', now),
            estado: { [Op.in]: [...ATTENDANCE_OPEN_STATUSES] },
          },
          attributes: appointmentAttributes,
          order: [['fin', 'DESC']],
          limit: 30,
          raw: true,
        })
      : [],
    includeNext
      ? CitaPaciente.findAll({
          where: {
            ...doctorScope,
            ...clinicRangeWhere('inicio', dayRanges, 'next', now),
            estado: { [Op.notIn]: [...CANCELLED_STATUSES] },
          },
          attributes: appointmentAttributes,
          order: [['inicio', 'ASC']],
          limit: 4,
          raw: true,
        })
      : [],
  ]);

  const allRows = [...todayRows, ...pastRows, ...nextRows];
  const maps = await loadAppointmentMaps(allRows, clinicMap);

  const mappedToday = todayRows.map((row) => mapAppointment(row, maps, now));

  return {
    today: mappedToday
      .filter((item) => isExpectedTodayAppointment(item, { includeClosedToday })),
    inactiveToday: mappedToday
      .filter((item) => isInactiveTodayAppointment(item, { includeClosedToday })),
    pastAttendance: pastRows
      .filter((row) => !CANCELLED_STATUSES.has(String(row.estado || '').toLowerCase()))
      .map((row) => mapAppointment(row, maps, now))
      .filter((item) => item.attendanceDue),
    next: nextRows.map((row) => mapAppointment(row, maps, now)),
  };
}

async function countTasks({ clinicIds, clinicMap, todayDate }) {
  if (!clinicIds.length) {
    return { leadsPending: 0, pendingConsents: 0, pendingReviews: 0 };
  }

  const [leadsPending, pendingConsents, pendingReviews] = await Promise.all([
    LeadIntake
      ? LeadIntake.count({
          where: {
            archived_at: null,
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

  const dayRanges = buildClinicDayRanges({ clinicIds, clinicMap, dateValue: todayDate });
  const unconfirmedToday = CitaPaciente
    ? await CitaPaciente.count({
        where: {
          ...clinicRangeWhere('inicio', dayRanges),
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

function locationPublicUrl(location) {
  const raw = parseJsonObject(location?.raw_payload);
  return raw.metadata?.mapsUri || raw.mapsUri || null;
}

async function loadUnansweredReviewCards({ clinicIds, clinicMap, limit = 4 }) {
  if (!clinicIds.length || !BusinessProfileReview) return [];

  const reviews = await BusinessProfileReview.findAll({
    where: {
      ...scopedWhere('clinica_id', clinicIds),
      has_reply: false,
    },
    attributes: [
      'id',
      'clinica_id',
      'business_location_id',
      'review_name',
      'reviewer_name',
      'reviewer_profile_photo_url',
      'star_rating',
      'comment',
      'create_time',
      'update_time',
      'is_negative',
      'matched_paciente_id',
      'match_confidence',
    ],
    order: [['create_time', 'DESC']],
    limit,
    raw: true,
  });

  if (!reviews.length) return [];

  const locationIds = uniqueInts(reviews.map((review) => review.business_location_id));
  const patientIds = uniqueInts(reviews.map((review) => review.matched_paciente_id));
  const [locations, patients] = await Promise.all([
    locationIds.length && ClinicBusinessLocation
      ? ClinicBusinessLocation.findAll({
          where: scopedWhere('id', locationIds),
          attributes: ['id', 'location_name', 'raw_payload'],
          raw: true,
        })
      : [],
    patientIds.length && Paciente
      ? Paciente.findAll({
          where: scopedWhere('id_paciente', patientIds),
          attributes: ['id_paciente', 'nombre', 'apellidos'],
          raw: true,
        })
      : [],
  ]);

  const locationMap = new Map(locations.map((row) => [Number(row.id), row]));
  const patientMap = new Map(patients.map((row) => [Number(row.id_paciente), row]));

  return reviews.map((review) => {
    const clinic = clinicMap.get(Number(review.clinica_id));
    const location = locationMap.get(Number(review.business_location_id));
    const patient = patientMap.get(Number(review.matched_paciente_id));
    const reviewId = Number(review.id);
    return {
      id: String(reviewId),
      reviewId,
      reviewName: review.review_name || null,
      clinicId: Number(review.clinica_id) || null,
      clinicName: clinic?.nombre_clinica || `Clínica ${review.clinica_id}`,
      locationName: location?.location_name || null,
      reviewerName: review.reviewer_name || 'Paciente de Google',
      reviewerAvatar: review.reviewer_profile_photo_url || null,
      rating: Number(review.star_rating || 0),
      comment: review.comment || '',
      createdAt: review.create_time || review.update_time || null,
      isNegative: review.is_negative === true || Number(review.star_rating || 0) <= 3,
      matchedPatientId: Number(review.matched_paciente_id) || null,
      matchedPatientName: patient ? fullName(patient, null) : null,
      matchConfidence: review.match_confidence != null ? Number(review.match_confidence) : null,
      replyExternalUrl: locationPublicUrl(location),
      link: '/marketing/perfil-google',
      queryParams: {
        reviews: 'unanswered',
        review_id: reviewId,
        clinica_id: Number(review.clinica_id) || null,
      },
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
      queryParams: { panel: 'connected-accounts' },
      actionLabel: 'Conectar',
    },
    {
      id: 'whatsapp_payment',
      label: 'Validar método de pago de WhatsApp',
      description: 'Evita bloqueos de envío por facturación de Meta.',
      completed: whatsappStatus.paymentReady === true,
      severity: whatsappStatus.paymentMissing ? 'critical' : 'normal',
      link: '/ajustes',
      queryParams: { panel: 'connected-accounts' },
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

async function loadCashStatus({ clinicIds, clinicMap, todayDate, manageClinicIds = [] }) {
  const ids = uniqueInts(clinicIds);
  if (!ids.length || !AccountingCashSession) return null;

  const sessions = await AccountingCashSession.findAll({
    where: {
      clinic_id: ids.length === 1 ? ids[0] : { [Op.in]: ids },
      business_date: todayDate,
    },
    raw: true,
  });
  const byClinic = new Map(sessions.map((session) => [Number(session.clinic_id), session]));
  const clinics = ids.map((clinicId) => {
    const clinic = clinicMap instanceof Map ? clinicMap.get(Number(clinicId)) : null;
    const session = byClinic.get(Number(clinicId)) || null;
    const status = !session
      ? 'pending'
      : String(session.status || '').toLowerCase() === 'closed'
        ? 'closed'
        : 'open';
    return {
      clinicId: Number(clinicId),
      clinicName: clinic?.nombre_clinica || 'Clínica',
      status,
      statusLabel: status === 'pending'
        ? 'Pendiente de apertura'
        : status === 'closed'
          ? 'Caja cerrada'
          : 'Caja abierta',
      openedAt: session?.opened_at || null,
      closedAt: session?.closed_at || null,
    };
  });

  const opened = clinics.filter((item) => item.status !== 'pending').length;
  const closed = clinics.filter((item) => item.status === 'closed').length;
  const pending = clinics.length - opened;
  const status = pending === clinics.length
    ? 'pending'
    : pending > 0
      ? 'mixed'
      : closed === clinics.length
        ? 'closed'
        : 'open';
  const singleClinicName = clinics.length === 1 ? clinics[0].clinicName : null;
  const summaryLabel = status === 'pending'
    ? `La apertura de caja${singleClinicName ? ` de ${singleClinicName}` : ''} está pendiente.`
    : status === 'mixed'
      ? `Hay ${pending} caja${pending === 1 ? '' : 's'} pendiente${pending === 1 ? '' : 's'} de apertura.`
      : status === 'closed'
        ? 'La caja de hoy ya se abrió y está cerrada.'
        : 'La caja de hoy ya está abierta.';

  const manageableIds = uniqueInts(manageClinicIds);
  const linkClinicScope = manageableIds.length ? manageableIds : ids;
  return {
    businessDate: todayDate,
    totalClinics: clinics.length,
    opened,
    closed,
    pending,
    status,
    summaryLabel,
    detailLabel: `${opened}/${clinics.length} clínica${clinics.length === 1 ? '' : 's'} con apertura registrada.`,
    canManage: manageableIds.length > 0,
    link: '/contabilidad',
    queryParams: {
      section: 'cash',
      clinica_id: linkClinicScope.length === 1 ? linkClinicScope[0] : linkClinicScope.join(','),
    },
    clinics,
  };
}

function roleSections(role, subrolCode) {
  const normalizedRole = String(role || '').toLowerCase();
  // Una asignación de agencia concede Marketing, no operativa clínica ni
  // acceso implícito a pacientes. Las excepciones se resuelven por AccessPolicy.
  const ownerLike = ['administrador', 'propietario'].includes(normalizedRole);
  const operations =
    ownerLike ||
    (normalizedRole === 'personaldeclinica' && ['assistant', 'reception', 'admin_staff'].includes(subrolCode));
  const doctor = normalizedRole === 'personaldeclinica' && subrolCode === 'doctor';
  const shared = !['paciente', 'laboratorio'].includes(normalizedRole);
  return { ownerLike, operations, doctor, shared };
}

async function resolveDashboardAccess({ userId, clinicIds }) {
  const requestedClinicIds = uniqueInts(clinicIds);
  const featureClinicIds = async (featureKey) => getAccessibleClinicIdsForFeature({
    actorId: userId,
    featureKey,
    clinicIds: requestedClinicIds,
  });

  const [
    appointmentClinicIds,
    patientSensitiveClinicIds,
    consentClinicIds,
    leadSensitiveClinicIds,
  ] = await Promise.all([
    featureClinicIds('appointments.view'),
    featureClinicIds('patients.sensitive.view'),
    featureClinicIds('consents.view'),
    featureClinicIds('leads.sensitive.view'),
  ]);

  // Todas estas tarjetas contienen o enlazan identidad de paciente. No basta
  // con poder leer el recurso base: también se exige el permiso sensible.
  const patientAppointmentClinicIds = intersectClinicIds(
    appointmentClinicIds,
    patientSensitiveClinicIds,
  );
  const patientConsentClinicIds = intersectClinicIds(
    consentClinicIds,
    patientSensitiveClinicIds,
  );
  const patientReviewClinicIds = patientSensitiveClinicIds;

  // El bloque de tareas combina leads, citas y consentimientos. Solo se carga
  // donde el actor puede abrir de forma segura cada destino de ese resumen.
  const taskClinicIds = intersectClinicIds(
    patientAppointmentClinicIds,
    patientConsentClinicIds,
    leadSensitiveClinicIds,
  );

  return {
    appointmentClinicIds: patientAppointmentClinicIds,
    consentClinicIds: patientConsentClinicIds,
    reviewClinicIds: patientReviewClinicIds,
    taskClinicIds,
    operationalClinicIds: unionClinicIds(
      patientAppointmentClinicIds,
      patientConsentClinicIds,
      patientReviewClinicIds,
      taskClinicIds,
    ),
  };
}

function applyDashboardAccessGuard(dashboard, access = {}) {
  const guarded = { ...dashboard };
  if (!access.appointments) {
    guarded.todayAppointments = [];
    guarded.inactiveTodayAppointments = [];
    guarded.nextAppointments = [];
    guarded.pastAttendancePending = [];
    guarded.doctorAppointmentsToday = [];
  }
  if (!access.consents) {
    guarded.pendingPatientConsents = [];
    guarded.doctorPendingConsents = [];
  }
  if (!access.reviews) {
    guarded.unansweredReviews = [];
  }
  if (!access.tasks) {
    guarded.tasks = { items: [], total: 0 };
  }
  return guarded;
}

function rolePresentation(role, subrolCode, sections) {
  const normalizedRole = String(role || '').toLowerCase();
  const normalizedSubrol = String(subrolCode || '').toLowerCase();

  if (!sections.shared) {
    return {
      mode: 'restricted',
      eyebrow: 'Panel interno no disponible',
      title: 'Este rol no tiene panel operativo interno',
      subtitle: normalizedRole === 'laboratorio'
        ? 'El laboratorio debe trabajar desde los flujos compartidos de casos y documentos, no desde la operativa diaria de clínica.'
        : 'Los pacientes no ven citas internas, tareas de equipo ni configuración de clínica desde este panel.',
      icon: 'heroicons_outline:lock-closed',
      primaryActionLabel: null,
      primaryActionLink: null,
    };
  }

  if (sections.doctor) {
    return {
      mode: 'doctor',
      eyebrow: 'Operativa del doctor',
      title: 'Mi jornada clínica',
      subtitle: 'Citas asignadas, consentimientos pendientes de mis pacientes y horario de esta semana.',
      icon: 'heroicons_outline:user-circle',
      primaryActionLabel: 'Ver mi ficha',
      primaryActionLink: '/personal',
    };
  }

  if (sections.operations) {
    const assistantLike = ['assistant', 'reception', 'admin_staff'].includes(normalizedSubrol);
    return {
      mode: assistantLike ? 'assistant_operations' : 'clinic_operations',
      eyebrow: 'Operativa diaria de la clínica',
      title: assistantLike ? 'Recepción y coordinación del día' : 'Lo importante de hoy',
      subtitle: assistantLike
        ? 'Confirmaciones, asistencia, consentimientos y tareas que mantienen la agenda al día.'
        : 'Agenda, asistencia, consentimientos y oportunidades que requieren acción.',
      icon: 'heroicons_outline:clipboard-document-check',
      primaryActionLabel: 'Ver agenda',
      primaryActionLink: '/agenda-de-citas',
    };
  }

  return {
    mode: 'shared_growth',
    eyebrow: 'Crecimiento y configuración',
    title: 'Oportunidades de mejora',
    subtitle: 'Este rol no gestiona la agenda diaria, pero sí puede revisar recomendaciones y bloqueos de marketing.',
    icon: 'heroicons_outline:light-bulb',
    primaryActionLabel: 'Ver campañas',
    primaryActionLink: '/marketing/campanas',
  };
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
  });

  const scope = await resolveClinicScope(requestedScope, context.memberships, {
    allowAllClinics: context.globalAdmin,
  });
  const sections = roleSections(context.role, context.subrolCode);
  const dashboardAccess = await resolveDashboardAccess({
    userId,
    clinicIds: scope.clinicIds,
  });
  sections.operations = sections.operations && dashboardAccess.operationalClinicIds.length > 0;
  const cashManageClinicIds = await getAccessibleClinicIdsForFeature({
    actorId: userId,
    featureKey: 'accounting.cash.manage',
    clinicIds: scope.clinicIds,
  });
  const showStaffPresence = sections.ownerLike
    || (context.role === 'personaldeclinica' && context.subrolCode === 'admin_staff');
  const presentation = rolePresentation(context.role, context.subrolCode, sections);
  const doctorId = sections.doctor ? userId : null;
  const appointments = await loadAppointments({
    clinicIds: dashboardAccess.appointmentClinicIds,
    clinicMap: scope.clinicMap,
    todayDate: today.date,
    now,
    doctorId,
    includeToday: sections.operations || sections.doctor,
    includePastAttendance: sections.operations,
    includeNext: sections.operations,
    includeClosedToday: sections.doctor,
  });
  const counts = sections.operations
    ? await countTasks({
        clinicIds: dashboardAccess.taskClinicIds,
        clinicMap: scope.clinicMap,
        todayDate: today.date,
      })
    : { leadsPending: 0, pendingConsents: 0, pendingReviews: 0, unconfirmedToday: 0 };

  const [
    pendingPatientConsents,
    unansweredReviews,
    doctorPendingConsents,
    weeklySchedule,
    whatsappStatus,
    opportunities,
    cashStatus,
    staffPresence,
  ] = await Promise.all([
    sections.operations ? loadPendingConsentCards({ clinicIds: dashboardAccess.consentClinicIds, limit: 6 }) : [],
    sections.operations ? loadUnansweredReviewCards({ clinicIds: dashboardAccess.reviewClinicIds, clinicMap: scope.clinicMap, limit: 4 }) : [],
    doctorId ? loadPendingConsentCards({ clinicIds: dashboardAccess.consentClinicIds, doctorId, limit: 6 }) : [],
    doctorId ? loadWeeklySchedule({ clinicIds: dashboardAccess.appointmentClinicIds, clinicMap: scope.clinicMap, userId: doctorId, todayIso: today.date }) : [],
    sections.shared ? loadWhatsappStatus({ clinicIds: scope.clinicIds, groupIds: scope.groupIds }) : { connected: null, paymentReady: null, paymentMissing: false },
    sections.shared ? loadOpportunities({ clinicIds: scope.clinicIds }) : [],
    scope.clinicIds.length ? loadCashStatus({
      clinicIds: scope.clinicIds,
      clinicMap: scope.clinicMap,
      todayDate: today.date,
      manageClinicIds: cashManageClinicIds,
    }).catch((error) => {
      console.warn('[panelesDashboard] cash status unavailable:', error?.message || error);
      return null;
    }) : null,
    showStaffPresence ? personalPresenceService.getDashboardPresenceSummary({
      clinicIds: scope.clinicIds,
      clinicMap: scope.clinicMap,
      businessDate: today.date,
      actorId: userId,
    }).catch((error) => {
      console.warn('[panelesDashboard] staff presence unavailable:', error?.message || error);
      return null;
    }) : null,
  ]);

  const setup = sections.operations
    ? await loadSetupStatus({
        clinicIds: dashboardAccess.operationalClinicIds,
        groupIds: scope.groupIds,
        clinics: scope.clinics,
        whatsappStatus,
      })
    : { total: 0, completed: 0, items: [] };

  const doctorAppointments = doctorId
    ? appointments.today
    : [];

  const errors = [];
  if (sections.shared && whatsappStatus.connected === false) {
    errors.push({
      id: 'whatsapp_not_connected',
      title: 'No tienes WhatsApp conectado',
      subtitle: 'Conecta o asigna el numero para enviar plantillas y automatizaciones.',
      link: '/ajustes',
      queryParams: { panel: 'connected-accounts' },
      actionLabel: 'Ir a Cuentas conectadas',
    });
  } else if (sections.shared && whatsappStatus.paymentMissing) {
    errors.push({
      id: 'whatsapp_payment_missing',
      title: 'WhatsApp no tiene método de pago activo',
      subtitle: 'Meta puede bloquear plantillas y recordatorios hasta que se configure la facturación.',
      link: '/ajustes',
      queryParams: { panel: 'connected-accounts' },
      actionLabel: 'Revisar pago',
    });
  }

  const dashboardTasks = taskItems(
    counts,
    today.date,
    dashboardAccess.taskClinicIds,
    appointments.pastAttendance.length,
  );

  const dashboard = {
    user: context.user,
    role: {
      code: context.role || null,
      label: context.role || 'usuario',
      subrolLabel: context.subrolLabel || null,
      subrolCode: context.subrolCode,
    },
    rolePresentation: presentation,
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
      showSetup: sections.operations,
      showOwnerFeedback: sections.ownerLike,
    },
    todayAppointments: sections.operations ? appointments.today : [],
    inactiveTodayAppointments: sections.operations ? appointments.inactiveToday : [],
    nextAppointments: sections.operations ? appointments.next : [],
    pastAttendancePending: sections.operations ? appointments.pastAttendance : [],
    doctorAppointmentsToday: doctorAppointments,
    pendingPatientConsents,
    unansweredReviews: sections.operations ? unansweredReviews : [],
    doctorPendingConsents,
    weeklySchedule,
    tasks: {
      items: sections.operations ? dashboardTasks : [],
      total: sections.operations ? dashboardTasks.reduce((total, item) => total + Number(item.count || 0), 0) : 0,
    },
    setup,
    cashStatus,
    staffPresence,
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

  return applyDashboardAccessGuard(dashboard, {
    appointments: dashboardAccess.appointmentClinicIds.length > 0,
    consents: dashboardAccess.consentClinicIds.length > 0,
    reviews: sections.operations && dashboardAccess.reviewClinicIds.length > 0,
    tasks: sections.operations && dashboardAccess.taskClinicIds.length > 0,
  });
}

module.exports = {
  getMainDashboard,
  __testing: {
    isExpectedTodayAppointment,
    isInactiveTodayAppointment,
    loadAppointments,
    statusUi,
    roleSections,
    applyDashboardAccessGuard,
    intersectClinicIds,
    buildClinicDayRanges,
    dateOnly,
    dayRange,
    mapAppointment,
    timeLabel,
  },
};
