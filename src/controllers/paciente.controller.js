'use strict';
const { Paciente, Clinica, PacienteRelacion, PacienteClinica, PacienteConsentimiento, CitaPaciente, Usuario, Tratamiento, PatientCustomField, PatientNutritionReport, PatientNutritionMeasurement, sequelize } = require('../../models');
const { Op, literal, QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { normalizePhoneDigits } = require('../lib/phone');
const { normalizeHumanName } = require('../lib/name');
const {
  normalizePatientLanguage,
  languageForNewPatient,
} = require('../lib/patient-language');
const {
  assertUserCanAccessFeature,
  canUserAccessFeature,
  getAccessibleClinicIdsForFeature,
} = require('../lib/access-policy');

const normalizePhone = (phone) => {
  return normalizePhoneDigits(phone);
};

const normalizeEmail = (email) => {
  if (!email) return null;
  return email.toString().trim().toLowerCase();
};

const normalizeSearchTerm = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ñ/g, 'n')
  .replace(/Ñ/g, 'n')
  .trim()
  .toLowerCase();

const ACCENT_FOLD_REPLACEMENTS = [
  ['á', 'a'], ['à', 'a'], ['ä', 'a'], ['â', 'a'], ['ã', 'a'],
  ['é', 'e'], ['è', 'e'], ['ë', 'e'], ['ê', 'e'],
  ['í', 'i'], ['ì', 'i'], ['ï', 'i'], ['î', 'i'],
  ['ó', 'o'], ['ò', 'o'], ['ö', 'o'], ['ô', 'o'], ['õ', 'o'],
  ['ú', 'u'], ['ù', 'u'], ['ü', 'u'], ['û', 'u'],
  ['ñ', 'n'],
  ['ç', 'c'],
];

const accentFoldSql = (expression) => ACCENT_FOLD_REPLACEMENTS.reduce(
  (sql, [from, to]) => `REPLACE(${sql}, '${from}', '${to}')`,
  `LOWER(${expression})`
);

const generatePacientePublicId = () => `pac_${crypto.randomBytes(10).toString('hex')}`;

const isNumericPacienteIdentifier = (value) => /^\d+$/.test(String(value || '').trim());

async function assertPatientEditAccess(req, clinicId) {
  const actorId = Number(req.userData?.userId);
  const normalizedClinicId = Number(clinicId);

  if (!Number.isFinite(actorId)) {
    const error = new Error('auth_failed');
    error.status = 401;
    throw error;
  }

  if (!Number.isFinite(normalizedClinicId)) {
    const error = new Error('clinic_id_required');
    error.status = 400;
    throw error;
  }

  await assertUserCanAccessFeature({
    actorId,
    featureKey: 'patients.edit',
    clinicId: normalizedClinicId,
  });
}

function sendAccessPolicyError(error, res) {
  if (error.status === 401 || error.message === 'auth_failed') {
    return res.status(401).json({ message: 'Auth failed!' });
  }
  if (error.status === 403 || error.message === 'access_policy_forbidden') {
    const featureKey = error.details?.feature_key;
    return res.status(403).json({
      message: featureKey === 'patients.edit'
        ? 'No tienes permiso para editar pacientes'
        : 'No tienes permiso para ver pacientes en esta clínica',
      details: error.details || null,
    });
  }
  if (error.status === 400 && error.message === 'clinic_id_required') {
    return res.status(400).json({ message: 'clinica_id es obligatorio' });
  }
  return null;
}

const normalizeClinicIds = (values) => Array.from(new Set(
  (Array.isArray(values) ? values : [values])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isInteger(value) && value > 0)
));

const patientClinicIds = (paciente) => normalizeClinicIds([
  paciente?.clinica_id,
  ...((paciente?.clinicasVinculadas || []).map((link) => link?.clinica_id)),
]);

async function accessibleClinicIds(req, featureKey, clinicIds, { requireAll = false } = {}) {
  const actorId = Number(req.userData?.userId);
  const requested = normalizeClinicIds(clinicIds);
  if (!Number.isFinite(actorId)) {
    const error = new Error('auth_failed');
    error.status = 401;
    throw error;
  }
  if (!requested.length) {
    const error = new Error('clinic_id_required');
    error.status = 400;
    throw error;
  }

  const allowed = await getAccessibleClinicIdsForFeature({
    actorId,
    featureKey,
    clinicIds: requested,
  });
  if (!allowed.length || (requireAll && allowed.length !== requested.length)) {
    const error = new Error('access_policy_forbidden');
    error.status = 403;
    error.details = { feature_key: featureKey, clinic_ids: requested };
    throw error;
  }
  return allowed;
}

async function allClinicsAccessibleToActor(req, featureKey) {
  const actorId = Number(req.userData?.userId);
  if (!Number.isFinite(actorId)) {
    const error = new Error('auth_failed');
    error.status = 401;
    throw error;
  }
  return getAccessibleClinicIdsForFeature({ actorId, featureKey });
}

async function canViewSensitivePatientData(req, clinicIds) {
  const actorId = Number(req.userData?.userId);
  const ids = normalizeClinicIds(clinicIds);
  if (!Number.isFinite(actorId) || !ids.length) return false;
  const decisions = await Promise.all(ids.map((clinicId) => canUserAccessFeature({
    actorId,
    featureKey: 'patients.sensitive.view',
    clinicId,
  }).catch(() => false)));
  return decisions.every(Boolean);
}

const patientPseudonym = (paciente) => crypto
  .createHash('sha256')
  .update(`patient:${paciente?.public_id || paciente?.id_paciente || 'unknown'}`)
  .digest('hex')
  .slice(0, 6)
  .toUpperCase();

function redactEmbeddedPatient(paciente) {
  if (!paciente) return paciente;
  const plain = typeof paciente.toJSON === 'function' ? paciente.toJSON() : { ...paciente };
  const suffix = patientPseudonym(plain);
  const sensitiveFields = [
    'dni', 'telefono_movil', 'email', 'telefono_secundario', 'foto',
    'fecha_nacimiento', 'edad', 'estatura', 'peso', 'sexo', 'profesion',
    'alergias', 'antecedentes', 'medicacion',
  ];
  const redacted = {
    ...plain,
    nombre: 'Paciente',
    apellidos: `#${suffix}`,
    privacy_redacted: true,
  };
  sensitiveFields.forEach((field) => { redacted[field] = null; });
  delete redacted.proxima_cita;
  delete redacted.ultima_cita;
  if (Array.isArray(redacted.relaciones)) {
    redacted.relaciones = redacted.relaciones.map((relation) => ({
      ...relation,
      relacionado: redactEmbeddedPatient(relation?.relacionado),
    }));
  }
  if (Array.isArray(redacted.tutorDe)) {
    redacted.tutorDe = redacted.tutorDe.map((relation) => ({
      ...relation,
      paciente: redactEmbeddedPatient(relation?.paciente),
    }));
  }
  return redacted;
}

const generateUniquePacientePublicId = async () => {
  for (let i = 0; i < 8; i++) {
    const publicId = generatePacientePublicId();
    const existing = await Paciente.findOne({ where: { public_id: publicId }, attributes: ['id_paciente'] });
    if (!existing) {
      return publicId;
    }
  }
  throw new Error('paciente_public_id_generation_failed');
};

const ensurePacientePublicId = async (paciente) => {
  if (!paciente || paciente.public_id) {
    return paciente;
  }
  paciente.public_id = await generateUniquePacientePublicId();
  await paciente.save({ fields: ['public_id'] });
  return paciente;
};

const findPacienteByIdentifier = async (identifier, options = {}) => {
  const value = String(identifier || '').trim();
  if (!value) {
    return null;
  }

  const { where, ...restOptions } = options || {};
  const publicIds = value.startsWith('pat_') ? [value, `pac_${value.slice(4)}`] : [value];
  const lookupWhere = isNumericPacienteIdentifier(value)
    ? { id_paciente: Number(value) }
    : { public_id: { [Op.in]: publicIds } };
  const finalWhere = where ? { [Op.and]: [lookupWhere, where] } : lookupWhere;
  return Paciente.findOne({ ...restOptions, where: finalWhere });
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatDateEs = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(date)
    : null;
};

const formatTimeEs = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
    : null;
};

const buildActorLabel = (usuario) => {
  if (!usuario) return 'Sistema';
  const name = [usuario.nombre, usuario.apellidos].filter(Boolean).join(' ').trim();
  if (name && usuario.email_usuario) {
    return `${name} <${usuario.email_usuario}>`;
  }
  return name
    || usuario.email_usuario
    || `Usuario ${usuario.id_usuario}`;
};

const formatAppointmentStateLabel = (estado) => {
  const normalized = (estado || '').toString().trim().toLowerCase();
  if (!normalized) return null;
  const labels = {
    pendiente: 'Pendiente',
    info_enviada: 'Datos de la cita enviados',
    info_confirmada: 'Cita confirmada',
    recordatorio_enviado: 'Recordatorio enviado',
    recordatorio_confirmado: 'Cita confirmada',
    completada: 'Completada',
    no_asistio: 'No asistió',
    cancelada: 'Cancelada',
    reprogramada: 'Reprogramada',
  };
  return labels[normalized] || normalized.replace(/_/g, ' ');
};

// "Reprogramada" sigue siendo una cita operativa cuando conserva una fecha futura:
// el hub del paciente debe poder mostrarla como próxima cita. Solo ocultamos
// estados realmente no atendibles.
const ACTIVE_APPOINTMENT_EXCLUDED_STATES = ['cancelada'];

const buildPacienteAppointmentInclude = () => [
  { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'], required: false },
  { model: Tratamiento, as: 'tratamiento', attributes: ['id_tratamiento', 'nombre', 'disciplina'], required: false },
  Usuario ? { model: Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'], required: false } : null,
].filter(Boolean);

const serializePacienteAppointmentSummary = (cita) => {
  if (!cita) return null;
  const plain = typeof cita.toJSON === 'function' ? cita.toJSON() : cita;
  const doctorName = [plain.doctor?.nombre, plain.doctor?.apellidos].filter(Boolean).join(' ').trim();
  return {
    id_cita: plain.id_cita,
    clinica_id: plain.clinica_id,
    paciente_id: plain.paciente_id,
    doctor_id: plain.doctor_id,
    tratamiento_id: plain.tratamiento_id,
    estado: plain.estado,
    estado_label: formatAppointmentStateLabel(plain.estado),
    inicio: plain.inicio,
    fin: plain.fin,
    titulo: plain.titulo || plain.motivo || null,
    clinica: plain.clinica ? {
      id_clinica: plain.clinica.id_clinica,
      nombre_clinica: plain.clinica.nombre_clinica,
    } : null,
    tratamiento: plain.tratamiento ? {
      id_tratamiento: plain.tratamiento.id_tratamiento,
      nombre: plain.tratamiento.nombre,
      disciplina: plain.tratamiento.disciplina,
    } : null,
    doctor: plain.doctor ? {
      id_usuario: plain.doctor.id_usuario,
      nombre: plain.doctor.nombre,
      apellidos: plain.doctor.apellidos,
      nombre_completo: doctorName || null,
      avatar: plain.doctor.avatar || null,
    } : null,
  };
};

const getPacienteAppointmentBounds = async (pacienteId, clinicIds) => {
  const now = new Date();
  const readableClinicIds = normalizeClinicIds(clinicIds);
  const baseWhere = {
    paciente_id: pacienteId,
    clinica_id: { [Op.in]: readableClinicIds },
    estado: { [Op.notIn]: ACTIVE_APPOINTMENT_EXCLUDED_STATES },
  };
  const include = buildPacienteAppointmentInclude();
  const [proxima, ultima] = await Promise.all([
    CitaPaciente.findOne({
      where: {
        ...baseWhere,
        [Op.or]: [
          { inicio: { [Op.gte]: now } },
          { fin: { [Op.gte]: now } },
        ],
      },
      include,
      order: [['inicio', 'ASC']],
    }),
    CitaPaciente.findOne({
      where: {
        ...baseWhere,
        inicio: { [Op.lt]: now },
      },
      include,
      order: [['inicio', 'DESC']],
    }),
  ]);
  return {
    proxima_cita: serializePacienteAppointmentSummary(proxima),
    ultima_cita: serializePacienteAppointmentSummary(ultima),
  };
};

const buildAppointmentActivityDescription = ({ telefono, inicio, tratamiento, estado }) => {
  const fields = [];
  if (telefono) fields.push({ label: 'Teléfono', value: telefono });
  const dateValue = formatDateEs(inicio);
  const timeValue = formatTimeEs(inicio);
  if (dateValue) fields.push({ label: 'Fecha', value: dateValue });
  if (timeValue) fields.push({ label: 'Hora', value: timeValue });
  if (tratamiento) fields.push({ label: 'Tratamiento', value: tratamiento });
  const stateValue = formatAppointmentStateLabel(estado);
  if (stateValue) fields.push({ label: 'Estado', value: stateValue });

  return {
    plain: fields.map(({ label, value }) => `${label}: ${value}`).join('\n') || 'Sin detalles',
    html: fields.map(({ label, value }) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`).join('') || '<div>Sin detalles</div>',
  };
};

const isImportedHistoricalAppointment = (cita) => {
  const tipoCita = String(cita?.tipo_cita || '').trim().toLowerCase();
  const sourceSystem = String(cita?.source_system || '').trim().toLowerCase();
  const motivo = String(cita?.motivo || '').trim().toLowerCase();
  const nota = String(cita?.nota || '').trim().toLowerCase();
  return tipoCita === 'historico_importado'
    || sourceSystem === 'cliniccloud'
    || motivo === 'importación de pacientes para reactivación'
    || nota.includes('cita histórica creada automáticamente desde una importación');
};

const buildReviewActivityDescription = ({ rating, reason, reviewerName, clinicName }) => {
  const fields = [];
  if (rating) fields.push({ label: 'Valoración', value: `${rating}/5` });
  if (reason) fields.push({ label: 'Motivo', value: reason });
  if (reviewerName) fields.push({ label: 'Google', value: reviewerName });
  if (clinicName) fields.push({ label: 'Sede', value: clinicName });

  return {
    plain: fields.map(({ label, value }) => `${label}: ${value}`).join('\n') || 'Sin detalles',
    html: fields.map(({ label, value }) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`).join('') || '<div>Sin detalles</div>',
  };
};

const shortHash = (value) => {
  const hash = String(value || '').trim();
  if (!hash) return null;
  return hash.length > 16 ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : hash;
};

const isMissingNutritionReportsTableError = (error) => {
  const message = String(error?.message || error?.parent?.message || '');
  return /PatientNutritionReports/i.test(message) && /doesn't exist|does not exist|no such table|unknown column/i.test(message);
};

const buildNutritionReportActivityDescription = ({ report, measurement, treatment }) => {
  const fields = [];
  if (report?.title) fields.push({ label: 'Informe', value: report.title });
  const measuredDate = formatDateEs(measurement?.measured_at);
  const measuredTime = formatTimeEs(measurement?.measured_at);
  if (measuredDate) fields.push({ label: 'Medición', value: measuredTime ? `${measuredDate} ${measuredTime}` : measuredDate });
  if (treatment?.nombre) fields.push({ label: 'Servicio', value: treatment.nombre });
  if (report?.formula_version) fields.push({ label: 'Fórmula', value: report.formula_version });
  const snapshot = shortHash(report?.snapshot_hash);
  if (snapshot) fields.push({ label: 'Snapshot', value: snapshot });

  return {
    plain: fields.map(({ label, value }) => `${label}: ${value}`).join('\n') || 'Informe nutricional final',
    html: fields.map(({ label, value }) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`).join('') || '<div>Informe nutricional final</div>',
  };
};

const collectPacienteClinics = (paciente) => {
  const clinics = new Map();

  const addClinic = (clinicLike) => {
    const clinicId = parseInt(clinicLike?.clinica_id ?? clinicLike?.id_clinica, 10);
    if (!clinicId) return;
    clinics.set(clinicId, {
      clinica_id: clinicId,
      nombre_clinica: clinicLike?.nombre_clinica || clinicLike?.clinica?.nombre_clinica || null,
      grupoClinicaId: clinicLike?.grupoClinicaId ?? clinicLike?.clinica?.grupoClinicaId ?? null
    });
  };

  addClinic({
    clinica_id: paciente?.clinica_id,
    nombre_clinica: paciente?.clinica?.nombre_clinica,
    grupoClinicaId: paciente?.clinica?.grupoClinicaId
  });

  for (const vinculo of (paciente?.clinicasVinculadas || [])) {
    addClinic({
      clinica_id: vinculo?.clinica_id,
      nombre_clinica: vinculo?.clinica?.nombre_clinica,
      grupoClinicaId: vinculo?.clinica?.grupoClinicaId
    });
  }

  return Array.from(clinics.values());
};

const restrictEmbeddedPatientClinicScope = (patientLike, readableClinicIds) => {
  if (!patientLike) return patientLike;
  const plain = typeof patientLike.toJSON === 'function' ? patientLike.toJSON() : { ...patientLike };
  const allowed = new Set(normalizeClinicIds(readableClinicIds));
  const scoped = { ...plain };
  const primaryClinicId = Number.parseInt(String(plain.clinica_id ?? plain.clinica?.id_clinica ?? ''), 10);
  if (primaryClinicId && !allowed.has(primaryClinicId)) {
    scoped.clinica_id = null;
    scoped.clinica = null;
    // Las relaciones y tutorías pueden apuntar a una ficha de otra sede. El
    // include no trae todos sus vínculos, así que no se puede inferir de forma
    // segura que el actor la vea por otra clínica: se conserva la relación,
    // pero nunca sus datos identificativos o clínicos.
    return redactEmbeddedPatient(scoped);
  }
  if (Array.isArray(plain.clinicasVinculadas)) {
    scoped.clinicasVinculadas = plain.clinicasVinculadas.filter((link) => (
      allowed.has(Number.parseInt(String(link?.clinica_id ?? ''), 10))
    ));
  }
  return scoped;
};

const restrictPacientePayloadToClinics = (paciente, readableClinicIds) => {
  const plain = typeof paciente?.toJSON === 'function' ? paciente.toJSON() : { ...(paciente || {}) };
  const allowed = new Set(normalizeClinicIds(readableClinicIds));
  const originalClinicIds = patientClinicIds(plain);
  const scopedLinks = Array.isArray(plain.clinicasVinculadas)
    ? plain.clinicasVinculadas.filter((link) => (
        allowed.has(Number.parseInt(String(link?.clinica_id ?? ''), 10))
      ))
    : [];
  const primaryClinicId = Number.parseInt(String(plain.clinica_id ?? ''), 10);
  const primaryVisible = allowed.has(primaryClinicId);
  const fallbackLink = scopedLinks[0] || null;
  const scoped = {
    ...plain,
    clinica_id: primaryVisible
      ? primaryClinicId
      : (Number.parseInt(String(fallbackLink?.clinica_id ?? ''), 10) || null),
    clinica: primaryVisible ? (plain.clinica || null) : (fallbackLink?.clinica || null),
    clinicasVinculadas: scopedLinks,
    scope_limited: originalClinicIds.some((clinicId) => !allowed.has(clinicId)),
  };

  if (Array.isArray(plain.relaciones)) {
    scoped.relaciones = plain.relaciones.map((relation) => ({
      ...relation,
      relacionado: restrictEmbeddedPatientClinicScope(relation?.relacionado, readableClinicIds),
    }));
  }
  if (Array.isArray(plain.tutorDe)) {
    scoped.tutorDe = plain.tutorDe.map((relation) => ({
      ...relation,
      paciente: restrictEmbeddedPatientClinicScope(relation?.paciente, readableClinicIds),
    }));
  }
  return scoped;
};

const isPacienteLinkedToClinic = (paciente, clinicaId) => {
  const targetClinicaId = parseInt(clinicaId, 10);
  if (!targetClinicaId) return false;
  return collectPacienteClinics(paciente).some((clinic) => clinic.clinica_id === targetClinicaId);
};

const resolvePacienteClinicLabel = (paciente, clinicaId) => {
  const targetClinicaId = parseInt(clinicaId, 10);
  const clinics = collectPacienteClinics(paciente);
  const preferred = clinics.find((clinic) => clinic.clinica_id !== targetClinicaId && clinic.nombre_clinica);
  return preferred?.nombre_clinica || paciente?.clinica?.nombre_clinica || null;
};

const buildDuplicateContactOrClause = ({ telefono, email, normPhone, normEmail }) => {
  const orClause = [];

  if (normPhone) {
    orClause.push({ telefono_movil: normPhone });
    if (telefono && telefono !== normPhone) {
      orClause.push({ telefono_movil: telefono });
    }
  } else if (telefono) {
    orClause.push({ telefono_movil: telefono });
  }

  if (normEmail) {
    orClause.push({ email: normEmail });
    if (email && email !== normEmail) {
      orClause.push({ email });
    }
  } else if (email) {
    orClause.push({ email });
  }

  return orClause;
};

const resolveDuplicateContactLabel = ({ normPhone, normEmail }) => {
  if (normPhone && normEmail) return 'teléfono o email';
  if (normPhone) return 'teléfono';
  if (normEmail) return 'email';
  return 'contacto';
};

const findDuplicatePaciente = async ({
  telefono,
  email,
  clinicaId,
  scope = 'grupo',
  excludePacienteId = null
}) => {
  const normPhone = normalizePhone(telefono);
  const normEmail = normalizeEmail(email);
  const contactoOr = buildDuplicateContactOrClause({ telefono, email, normPhone, normEmail });

  if (!contactoOr.length || !clinicaId) {
    return null;
  }

  const clinicaIds = await getClinicaIdsForScope(clinicaId, scope);
  const clinicIdsList = clinicaIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  const clinicFilter = clinicIdsList.length === 1 ? clinicIdsList[0] : { [Op.in]: clinicIdsList };
  const clinicExists = clinicIdsList.length > 0
    ? literal(`EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id = Paciente.id_paciente AND pc.clinica_id IN (${clinicIdsList.join(',')}))`)
    : literal('0=1');

  const where = {
    [Op.and]: [
      { [Op.or]: contactoOr },
      {
        [Op.or]: [
          { clinica_id: clinicFilter },
          clinicExists
        ]
      }
    ]
  };

  if (excludePacienteId) {
    where[Op.and].push({ id_paciente: { [Op.ne]: excludePacienteId } });
  }

  return Paciente.findOne({
    where,
    include: [
      { model: Clinica, as: 'clinica' },
      { model: PacienteClinica, as: 'clinicasVinculadas', required: false, include: [{ model: Clinica, as: 'clinica' }] }
    ],
    distinct: true
  });
};

const buildPacienteDuplicadoPayload = ({ paciente, clinicaId, normPhone, normEmail }) => {
  const sameClinic = isPacienteLinkedToClinic(paciente, clinicaId);
  const contactLabel = resolveDuplicateContactLabel({ normPhone, normEmail });
  const clinicaNombre = sameClinic ? null : resolvePacienteClinicLabel(paciente, clinicaId);

  return {
    error: 'PACIENTE_DUPLICADO',
    message: sameClinic
      ? `Ya existe un paciente con este ${contactLabel} en esta clínica`
      : `Ya existe un paciente con este ${contactLabel} en ${clinicaNombre || 'otra clínica del grupo'}`,
    paciente,
    sameClinic,
    clinicaNombre,
    reuseCandidate: !sameClinic,
    vinculos: collectPacienteClinics(paciente)
  };
};

const buildPacienteDuplicadoPayloadForRequest = async (req, args) => {
  const { paciente, clinicaId, normPhone, normEmail } = args;
  const base = buildPacienteDuplicadoPayload(args);
  const actorId = Number(req.userData?.userId);
  const linkedClinicIds = patientClinicIds(paciente);
  const allowedClinicIds = Number.isFinite(actorId) && linkedClinicIds.length
    ? await getAccessibleClinicIdsForFeature({
        actorId,
        featureKey: 'patients.sensitive.view',
        clinicIds: linkedClinicIds,
      }).catch(() => [])
    : [];

  if (!allowedClinicIds.length) {
    return {
      ...base,
      message: `Ya existe un paciente con este ${resolveDuplicateContactLabel({ normPhone, normEmail })} en otra clínica del grupo`,
      paciente: null,
      clinicaNombre: null,
      reuseCandidate: false,
      vinculos: [],
      privacy_redacted: true,
    };
  }

  const scopedPatient = restrictPacientePayloadToClinics(paciente, allowedClinicIds);
  return {
    ...base,
    paciente: scopedPatient,
    clinicaNombre: base.sameClinic ? null : resolvePacienteClinicLabel(scopedPatient, clinicaId),
    vinculos: collectPacienteClinics(scopedPatient),
    privacy_redacted: false,
  };
};

const getClinicaIdsForScope = async (clinicaId, scope) => {
  if (!clinicaId) return [];
  if (scope !== 'grupo') return [parseInt(clinicaId, 10)];

  const clinica = await Clinica.findOne({ where: { id_clinica: clinicaId } });
  if (!clinica || !clinica.grupoClinicaId) {
    return [parseInt(clinicaId, 10)];
  }
  const clinicasGrupo = await Clinica.findAll({
    where: { grupoClinicaId: clinica.grupoClinicaId },
    attributes: ['id_clinica']
  });
  return clinicasGrupo.map(c => c.id_clinica);
};

exports.getAllPacientes = async (req, res) => {
  try {
    const requestedClinicIds = req.query.clinica_id
      ? normalizeClinicIds(String(req.query.clinica_id).split(','))
      : null;
    const readableClinicIds = requestedClinicIds
      ? await accessibleClinicIds(req, 'patients.view', requestedClinicIds, { requireAll: true })
      : await allClinicsAccessibleToActor(req, 'patients.view');
    if (!readableClinicIds.length) {
      return res.json([]);
    }

    const include = [
      { model: Clinica, as: 'clinica' },
      {
        model: PacienteClinica,
        as: 'clinicasVinculadas',
        required: false,
        include: [{ model: Clinica, as: 'clinica' }]
      },
      {
        model: PacienteRelacion,
        as: 'relaciones',
        required: false,
        include: [
          { model: Paciente, as: 'relacionado', attributes: ['id_paciente', 'nombre', 'apellidos'], include: [{ model: Clinica, as: 'clinica', attributes: ['nombre_clinica'] }] }
        ]
      },
      {
        model: PacienteRelacion,
        as: 'tutorDe',
        required: false,
        include: [
          { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos'], include: [{ model: Clinica, as: 'clinica', attributes: ['nombre_clinica'] }] }
        ]
      }
    ];
    const clinicFilter = readableClinicIds.length === 1 ? readableClinicIds[0] : { [Op.in]: readableClinicIds };
    const clinicExists = literal(`EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id = Paciente.id_paciente AND pc.clinica_id IN (${readableClinicIds.join(',')}))`);
    const whereClause = {
      [Op.or]: [
        { clinica_id: clinicFilter },
        clinicExists
      ]
    };
    const pacientes = await Paciente.findAll({
      where: whereClause,
      include,
      distinct: true,
      order: [['nombre', 'ASC']]
    });
    await Promise.all(pacientes.map((paciente) => ensurePacientePublicId(paciente)));
    const mayViewSensitive = await canViewSensitivePatientData(req, readableClinicIds);
    const scopedPatients = pacientes.map((paciente) => (
      restrictPacientePayloadToClinics(paciente, readableClinicIds)
    ));
    res.json(mayViewSensitive ? scopedPatients : scopedPatients.map(redactEmbeddedPatient));
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error retrieving pacientes', error: error.message });
  }
};

exports.searchPacientes = async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim().replace(/\s+/g, ' ');
    const scope = req.query.scope || 'clinica';
    const clinicaId = req.query.clinica_id;
    const normPhone = normalizePhone(req.query.telefono || '');
    const normEmail = normalizeEmail(req.query.email || '');

    // No permitir búsqueda vacía para evitar devolver todo
    if (!query && !normPhone && !normEmail) {
      return res.json([]);
    }

    const accentInsensitiveLike = (expression, term) => {
      const normalized = normalizeSearchTerm(term);
      if (!normalized) return null;
      return literal(`${accentFoldSql(expression)} LIKE ${Paciente.sequelize.escape(`%${normalized}%`)}`);
    };

    const fieldLike = (field, term) => {
      const normalized = normalizeSearchTerm(term);
      const clauses = [
        { [field]: { [Op.like]: `%${term}%` } },
      ];
      if (normalized) {
        clauses.push(accentInsensitiveLike(`\`Paciente\`.\`${field}\``, term));
      }
      return clauses.filter(Boolean);
    };

    const fullNameLike = (term) => {
      const escaped = Paciente.sequelize.escape(`%${term}%`);
      const clauses = [
        literal(`CONCAT_WS(' ', \`Paciente\`.\`nombre\`, \`Paciente\`.\`apellidos\`) LIKE ${escaped}`),
        literal(`CONCAT_WS(' ', \`Paciente\`.\`apellidos\`, \`Paciente\`.\`nombre\`) LIKE ${escaped}`),
      ];
      const normalized = normalizeSearchTerm(term);
      if (normalized) {
        clauses.push(
          accentInsensitiveLike(`CONCAT_WS(' ', \`Paciente\`.\`nombre\`, \`Paciente\`.\`apellidos\`)`, term),
          accentInsensitiveLike(`CONCAT_WS(' ', \`Paciente\`.\`apellidos\`, \`Paciente\`.\`nombre\`)`, term)
        );
      }
      return clauses.filter(Boolean);
    };

    const whereOr = [];
    if (query) {
      whereOr.push(
        ...fieldLike('nombre', query),
        ...fieldLike('apellidos', query),
        { telefono_movil: { [Op.like]: `%${query}%` } },
        { email: { [Op.like]: `%${query}%` } },
        ...fullNameLike(query)
      );

      const tokens = query.split(' ').filter(token => token.length >= 2).slice(0, 8);
      if (tokens.length > 1) {
        whereOr.push({
          [Op.and]: tokens.map(token => ({
            [Op.or]: [
              ...fieldLike('nombre', token),
              ...fieldLike('apellidos', token),
              { telefono_movil: { [Op.like]: `%${token}%` } },
              { email: { [Op.like]: `%${token}%` } },
              ...fullNameLike(token)
            ]
          }))
        });
      }
    }
    if (normPhone) {
      whereOr.push({ telefono_movil: { [Op.like]: `%${normPhone}%` } });
    }
    if (normEmail) {
      whereOr.push({ email: { [Op.like]: `%${normEmail}%` } });
    }
    if (!whereOr.length) {
      return res.json([]);
    }

    if (!clinicaId) {
      return res.status(400).json({ message: 'clinica_id es obligatorio para la búsqueda' });
    }

    const clinicaIds = await getClinicaIdsForScope(clinicaId, scope);
    const clinicIdsList = await accessibleClinicIds(req, 'patients.view', clinicaIds);
    if (!await canViewSensitivePatientData(req, clinicIdsList)) {
      return res.status(403).json({
        message: 'La búsqueda identificativa de pacientes no está disponible para este rol',
        error: 'patient_sensitive_data_forbidden',
      });
    }
    const clinicFilter = clinicIdsList.length === 1 ? clinicIdsList[0] : { [Op.in]: clinicIdsList };
    const clinicExists = clinicIdsList.length > 0
      ? literal(`EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id = Paciente.id_paciente AND pc.clinica_id IN (${clinicIdsList.join(',')}))`)
      : literal('0=1');

    const whereClause = {
      [Op.and]: [
        { [Op.or]: whereOr },
        {
          [Op.or]: [
            { clinica_id: clinicFilter },
            clinicExists
          ]
        }
      ]
    };

    const pacientes = await Paciente.findAll({
      where: whereClause,
      include: [
        { model: Clinica, as: 'clinica' },
        {
          model: PacienteClinica,
          as: 'clinicasVinculadas',
          required: false,
          include: [{ model: Clinica, as: 'clinica' }]
        }
      ],
      order: [['nombre', 'ASC']],
      limit: 20,
      distinct: true
    });
    await Promise.all(pacientes.map((paciente) => ensurePacientePublicId(paciente)));
    res.json(pacientes.map((paciente) => (
      restrictPacientePayloadToClinics(paciente, clinicIdsList)
    )));
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error al buscar pacientes', error: error.message });
  }
};

exports.checkDuplicates = async (req, res) => {
  try {
    const { telefono, email, clinica_id, scope = 'grupo' } = req.query;
    const normPhone = normalizePhone(telefono);
    const normEmail = normalizeEmail(email);
    if (!normPhone && !normEmail) {
      return res.json({ exists: false });
    }
    if (!clinica_id) {
      return res.status(400).json({ message: 'clinica_id es obligatorio' });
    }
    await assertPatientEditAccess(req, clinica_id);

    const pacienteExistente = await findDuplicatePaciente({
      telefono,
      email,
      clinicaId: clinica_id,
      scope
    });

    if (!pacienteExistente) {
      return res.json({ exists: false });
    }

    const duplicatePayload = await buildPacienteDuplicadoPayloadForRequest(req, {
      paciente: pacienteExistente,
      clinicaId: parseInt(clinica_id, 10),
      normPhone,
      normEmail,
    });
    return res.json({ exists: true, ...duplicatePayload });
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error al verificar duplicados', error: error.message });
  }
};

exports.getConsents = async (req, res) => {
  try {
    const pacienteId = req.params.id;
    const paciente = await findPacienteByIdentifier(pacienteId, {
      include: [{ model: PacienteClinica, as: 'clinicasVinculadas', required: false }],
    });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }
    // La tabla legacy no identifica la clínica que originó cada documento.
    // Si el paciente pertenece también a una clínica no visible, no es posible
    // filtrar el contenido sin arriesgar una fuga entre sedes.
    await accessibleClinicIds(req, 'consents.view', patientClinicIds(paciente), { requireAll: true });

    const consents = await PacienteConsentimiento.findAll({
      where: { paciente_id: paciente.id_paciente },
      order: [['createdAt', 'DESC']]
    });

    return res.status(200).json(consents);
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    return res.status(500).json({ message: 'Error obteniendo consentimientos', error: error.message });
  }
};

exports.getPacienteById = async (req, res) => {
  try {
    const paciente = await findPacienteByIdentifier(req.params.id, {
      include: [
        { model: Clinica, as: 'clinica' },
        { model: PacienteClinica, as: 'clinicasVinculadas', required: false, include: [{ model: Clinica, as: 'clinica' }] },
        {
          model: PatientCustomField,
          as: 'camposPersonalizados',
          required: false,
          attributes: ['field_key', 'label', 'value', 'value_type', 'source']
        },
        {
          model: PacienteRelacion,
          as: 'relaciones',
          include: [{ model: Paciente, as: 'relacionado', include: [{ model: Clinica, as: 'clinica' }] }]
        },
        {
          model: PacienteRelacion,
          as: 'tutorDe',
          include: [{ model: Paciente, as: 'paciente', include: [{ model: Clinica, as: 'clinica' }] }]
        }
      ]
    });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    await ensurePacientePublicId(paciente);
    const readableClinicIds = await accessibleClinicIds(req, 'patients.view', patientClinicIds(paciente));
    const mayViewSensitive = await canViewSensitivePatientData(req, readableClinicIds);
    if (!mayViewSensitive) {
      return res.status(403).json({
        message: 'El detalle del paciente no está disponible para este rol',
        error: 'patient_detail_forbidden',
      });
    }
    const payload = {
      ...restrictPacientePayloadToClinics(paciente, readableClinicIds),
      ...await getPacienteAppointmentBounds(paciente.id_paciente, readableClinicIds),
    };
    res.json(payload);
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error retrieving paciente', error: error.message });
  }
};

exports.getPacienteActivity = async (req, res) => {
  try {
    const paciente = await findPacienteByIdentifier(req.params.id, {
      attributes: ['id_paciente', 'public_id', 'clinica_id'],
      include: [{ model: PacienteClinica, as: 'clinicasVinculadas', required: false, attributes: ['clinica_id'] }],
    });
    if (!paciente) {
      return res.status(400).json({ message: 'Paciente inválido' });
    }
    const readableClinicIds = await accessibleClinicIds(req, 'patients.view', patientClinicIds(paciente));
    if (!await canViewSensitivePatientData(req, readableClinicIds)) {
      return res.status(403).json({
        message: 'El registro clínico del paciente no está disponible para este rol',
        error: 'patient_sensitive_data_forbidden',
      });
    }
    const pacienteId = Number(paciente.id_paciente);

    const citas = await CitaPaciente.findAll({
      where: {
        paciente_id: pacienteId,
        clinica_id: { [Op.in]: readableClinicIds },
      },
      attributes: [
        'id_cita',
        'paciente_id',
        'estado',
        'inicio',
        'tipo_cita',
        'motivo',
        'nota',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
      ],
      include: [
        { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'telefono_movil'], required: false },
        { model: Tratamiento, as: 'tratamiento', attributes: ['id_tratamiento', 'nombre'], required: false },
      ],
      order: [['inicio', 'DESC']],
    });

    const actorIds = Array.from(new Set(
      citas
        .flatMap((cita) => [Number(cita.created_by), Number(cita.updated_by)])
        .filter((id) => Number.isFinite(id) && id > 0)
    ));

    const usuarios = actorIds.length
      ? await Usuario.findAll({
          where: { id_usuario: { [Op.in]: actorIds } },
          attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
          raw: true,
        })
      : [];

    const usuariosById = new Map(usuarios.map((usuario) => [Number(usuario.id_usuario), usuario]));
    const items = [];

    for (const citaRow of citas) {
      const cita = typeof citaRow.get === 'function' ? citaRow.get({ plain: true }) : citaRow;
      const createdByUser = usuariosById.get(Number(cita.created_by));
      const createdDescriptions = buildAppointmentActivityDescription({
        telefono: cita?.paciente?.telefono_movil || null,
        inicio: cita.inicio,
        tratamiento: cita?.tratamiento?.nombre || null,
      });
      const importedHistorical = isImportedHistoricalAppointment(cita);
      items.push({
        id: importedHistorical
          ? `historical-treatment-imported-${cita.id_cita}`
          : `appointment-created-${cita.id_cita}`,
        pacienteId: String(pacienteId),
        fecha: cita.created_at || cita.inicio,
        tipo: importedHistorical ? 'historical_treatment_imported' : 'appointment_created',
        titulo: importedHistorical ? 'Tratamiento histórico importado' : 'Cita agendada',
        descripcion: createdDescriptions.plain,
        descripcion_html: createdDescriptions.html,
        icono: importedHistorical ? 'heroicons_outline:archive-box' : 'heroicons_outline:calendar-days',
        color: 'info',
        citaId: String(cita.id_cita),
        usuarioId: createdByUser ? String(createdByUser.id_usuario) : 'system',
        usuarioNombre: buildActorLabel(createdByUser),
        detalles: {
          estado: cita.estado || null,
          importado: importedHistorical,
        },
      });

      if (importedHistorical) {
        continue;
      }

      const updatedById = Number(cita.updated_by);
      const updatedAt = cita.updated_at ? new Date(cita.updated_at).getTime() : null;
      const createdAt = cita.created_at ? new Date(cita.created_at).getTime() : null;
      if (!updatedAt || !createdAt || updatedAt <= createdAt) {
        continue;
      }

      const eventTypeByStatus = {
        info_enviada: 'appointment_info_sent',
        info_confirmada: 'appointment_confirmed',
        recordatorio_enviado: 'appointment_reminder_sent',
        recordatorio_confirmado: 'appointment_confirmed',
        completada: 'appointment_completed',
        cancelada: 'appointment_cancelled',
        no_asistio: 'appointment_no_show',
        reprogramada: 'appointment_rescheduled',
      };
      const titleByStatus = {
        info_enviada: 'Datos de la cita enviados',
        info_confirmada: 'Cita confirmada',
        recordatorio_enviado: 'Recordatorio enviado',
        recordatorio_confirmado: 'Cita confirmada por el paciente',
        completada: 'Cita completada',
        cancelada: 'Cita cancelada',
        no_asistio: 'Paciente no acude',
        reprogramada: 'Cita reprogramada',
      };
      const iconByStatus = {
        info_enviada: 'heroicons_outline:paper-airplane',
        info_confirmada: 'heroicons_outline:check-badge',
        recordatorio_enviado: 'heroicons_outline:bell-alert',
        recordatorio_confirmado: 'heroicons_outline:hand-thumb-up',
        completada: 'heroicons_outline:check',
        cancelada: 'heroicons_outline:x-circle',
        no_asistio: 'heroicons_outline:hand-thumb-down',
        reprogramada: 'heroicons_outline:arrow-path-rounded-square',
      };
      const eventType = eventTypeByStatus[cita.estado];
      if (!eventType) {
        continue;
      }

      const updatedByUser = usuariosById.get(updatedById);
      const updatedDescriptions = buildAppointmentActivityDescription({
        telefono: cita?.paciente?.telefono_movil || null,
        inicio: cita.inicio,
        tratamiento: cita?.tratamiento?.nombre || null,
        estado: cita.estado,
      });
      items.push({
        id: `appointment-status-${cita.id_cita}-${cita.estado}`,
        pacienteId: String(pacienteId),
        fecha: cita.updated_at,
        tipo: eventType,
        titulo: titleByStatus[cita.estado] || 'Estado de cita actualizado',
        descripcion: updatedDescriptions.plain,
        descripcion_html: updatedDescriptions.html,
        icono: iconByStatus[cita.estado] || 'heroicons_outline:check-badge',
        color: ['cancelada', 'no_asistio'].includes(cita.estado)
          ? 'warning'
          : (['info_enviada', 'recordatorio_enviado', 'reprogramada'].includes(cita.estado) ? 'info' : 'success'),
        citaId: String(cita.id_cita),
        usuarioId: updatedByUser ? String(updatedByUser.id_usuario) : 'system',
        usuarioNombre: buildActorLabel(updatedByUser),
        detalles: {
          estado: cita.estado,
        },
      });
    }

    const reviewEvents = await sequelize.query(
      `
      SELECT
        e.id,
        e.event_type,
        e.channel,
        e.payload,
        e.occurred_at,
        l.name AS list_name,
        i.name AS item_name,
        i.clinica_id,
        cl.nombre_clinica AS clinic_name
      FROM MarketingPatientContactEvents e
      INNER JOIN MarketingPatientLists l ON l.id = e.list_id
      LEFT JOIN MarketingPatientListItems i ON i.id = e.item_id
      LEFT JOIN Clinicas cl ON cl.id_clinica = COALESCE(i.clinica_id, l.clinica_id)
      WHERE COALESCE(e.paciente_id, i.paciente_id) = :pacienteId
        AND COALESCE(i.clinica_id, l.clinica_id) IN (:readableClinicIds)
        AND e.event_type IN (
          'review_rating_received',
          'review_rating_followup_sent',
          'review_private_feedback_received',
          'google_review_matched'
        )
        AND NOT (
          e.event_type = 'review_private_feedback_received'
          AND EXISTS (
            SELECT 1
            FROM MarketingPatientContactEvents re
            WHERE re.list_id = e.list_id
              AND re.item_id = e.item_id
              AND re.event_type IN ('review_rating_received', 'review_request_rating')
              AND JSON_UNQUOTE(JSON_EXTRACT(re.payload, '$.inbound_message_id')) = JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.inbound_message_id'))
          )
        )
      ORDER BY e.occurred_at DESC
      LIMIT 60
      `,
      { replacements: { pacienteId, readableClinicIds }, type: QueryTypes.SELECT }
    );

    const reviewEventConfig = {
      review_rating_received: {
        tipo: 'review_rating_received',
        titulo: 'Valoración privada recibida',
        icono: 'heroicons_outline:star',
        color: 'success',
      },
      review_rating_followup_sent: {
        tipo: 'review_rating_followup_sent',
        titulo: 'Respuesta de reseña enviada',
        icono: 'heroicons_outline:paper-airplane',
        color: 'info',
      },
      review_private_feedback_received: {
        tipo: 'review_private_feedback_received',
        titulo: 'Motivo privado recibido',
        icono: 'heroicons_outline:chat-bubble-left-ellipsis',
        color: 'warning',
      },
      google_review_matched: {
        tipo: 'google_review_matched',
        titulo: 'Reseña de Google vinculada',
        icono: 'brand:google-business-profile',
        color: 'success',
      },
    };

    for (const event of reviewEvents) {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      const kind = String(payload.kind || '').trim();
      const rating = Number(payload.rating || payload.star_rating || 0) || null;
      const reason = event.event_type === 'review_private_feedback_received' || event.event_type === 'google_review_matched'
        ? String(payload.content || payload.content_preview || '').trim()
        : '';
      const config = reviewEventConfig[event.event_type] || reviewEventConfig.review_rating_received;
      const title = event.event_type === 'review_rating_followup_sent'
        ? (kind === 'review_google_link_followup' ? 'Enlace de Google enviado' : 'Motivo privado solicitado')
        : config.titulo;
      const descriptions = buildReviewActivityDescription({
        rating,
        reason,
        reviewerName: payload.reviewer_name || null,
        clinicName: event.clinic_name || null,
      });

      items.push({
        id: `review-${event.id}`,
        pacienteId: String(pacienteId),
        fecha: event.occurred_at,
        tipo: config.tipo,
        titulo: title,
        descripcion: descriptions.plain,
        descripcion_html: descriptions.html,
        icono: config.icono,
        color: config.color,
        usuarioId: 'system',
        usuarioNombre: 'Sistema',
        detalles: {
          channel: event.channel || null,
          listName: event.list_name || null,
          rating,
          kind: kind || null,
        },
      });
    }

    const nutritionClinicIds = PatientNutritionReport && PatientNutritionMeasurement
      ? await getAccessibleClinicIdsForFeature({
          actorId: Number(req.userData?.userId),
          featureKey: 'nutrition.workspace.view',
          clinicIds: readableClinicIds,
        }).catch(() => [])
      : [];

    if (nutritionClinicIds.length) {
      try {
        const nutritionReports = await PatientNutritionReport.findAll({
          where: {
            patient_id: pacienteId,
            clinic_id: { [Op.in]: nutritionClinicIds },
            status: 'final',
          },
          attributes: [
            'id',
            'public_id',
            'measurement_id',
            'appointment_id',
            'treatment_id',
            'report_type',
            'title',
            'status',
            'formula_version',
            'snapshot_hash',
            'storage_strategy',
            'finalized_by',
            'finalized_at',
          ],
          include: [
            PatientNutritionMeasurement
              ? {
                  model: PatientNutritionMeasurement,
                  as: 'measurement',
                  attributes: ['id', 'profile_code', 'measured_at'],
                  required: false,
                }
              : null,
            Tratamiento
              ? {
                  model: Tratamiento,
                  as: 'treatment',
                  attributes: ['id_tratamiento', 'nombre'],
                  required: false,
                }
              : null,
            Usuario
              ? {
                  model: Usuario,
                  as: 'finalizedBy',
                  attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
                  required: false,
                }
              : null,
          ].filter(Boolean),
          order: [['finalized_at', 'DESC'], ['id', 'DESC']],
          limit: 20,
        });

        for (const reportRow of nutritionReports) {
          const report = typeof reportRow.get === 'function' ? reportRow.get({ plain: true }) : reportRow;
          const descriptions = buildNutritionReportActivityDescription({
            report,
            measurement: report.measurement || null,
            treatment: report.treatment || null,
          });
          const finalizedByUser = report.finalizedBy || usuariosById.get(Number(report.finalized_by));
          items.push({
            id: `nutrition-report-final-${report.id}`,
            pacienteId: String(pacienteId),
            fecha: report.finalized_at,
            tipo: 'nutrition_report_finalized',
            titulo: 'Informe de Nutrición cerrado',
            descripcion: descriptions.plain,
            descripcion_html: descriptions.html,
            icono: 'heroicons_outline:document-chart-bar',
            color: 'success',
            citaId: report.appointment_id ? String(report.appointment_id) : undefined,
            usuarioId: finalizedByUser ? String(finalizedByUser.id_usuario) : 'system',
            usuarioNombre: buildActorLabel(finalizedByUser),
            detalles: {
              reportId: report.id,
              reportPublicId: report.public_id || null,
              measurementId: report.measurement_id || null,
              appointmentId: report.appointment_id || null,
              treatmentId: report.treatment_id || null,
              reportType: report.report_type || null,
              storageStrategy: report.storage_strategy || null,
              snapshotHash: report.snapshot_hash || null,
              profileCode: report.measurement?.profile_code || null,
              status: report.status,
            },
          });
        }
      } catch (error) {
        if (!isMissingNutritionReportsTableError(error)) {
          throw error;
        }
      }
    }

    return res.json(items.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()));
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    return res.status(500).json({ message: 'Error retrieving paciente activity', error: error.message });
  }
};

exports.createPaciente = async (req, res) => {
  try {
    const { nombre, apellidos, dni, telefono_movil, email, telefono_secundario, foto, fecha_nacimiento, edad, estatura, peso, sexo, profesion, fecha_alta, fecha_baja, alergias, antecedentes, medicacion, idioma_preferido, paciente_conocido, como_nos_conocio, procedencia, clinica_id, tutor } = req.body;
    const normPhone = normalizePhone(telefono_movil);
    const normEmail = normalizeEmail(email);
    const normalizedNombre = normalizeHumanName(nombre);
    const normalizedApellidos = normalizeHumanName(apellidos || '');
    if (!normalizedNombre) {
      return res.status(400).json({ message: 'Faltan campos obligatorios (nombre)' });
    }
    // Permitimos sin teléfono/email solo si hay tutor
    if (!normPhone && !normEmail && !tutor?.id_paciente_relacionado) {
      return res.status(400).json({ message: 'Se requiere teléfono/email o un tutor como contacto principal' });
    }
    if (!clinica_id) {
      return res.status(400).json({ message: 'clinica_id es obligatorio' });
    }
    await assertPatientEditAccess(req, clinica_id);

    let tutorPaciente = null;
    if (tutor?.id_paciente_relacionado) {
      tutorPaciente = await findPacienteByIdentifier(tutor.id_paciente_relacionado, {
        include: [{ model: PacienteClinica, as: 'clinicasVinculadas', required: false }],
      });
      const actorId = Number(req.userData?.userId);
      const tutorClinicIds = patientClinicIds(tutorPaciente);
      const visibleTutorClinics = tutorPaciente && Number.isFinite(actorId)
        ? await getAccessibleClinicIdsForFeature({
            actorId,
            featureKey: 'patients.sensitive.view',
            clinicIds: tutorClinicIds,
          }).catch(() => [])
        : [];
      if (!tutorPaciente || !visibleTutorClinics.length) {
        return res.status(404).json({ message: 'Tutor no encontrado' });
      }
    }

    if (normPhone || normEmail) {
      const existente = await findDuplicatePaciente({
        telefono: telefono_movil,
        email,
        clinicaId: clinica_id,
        scope: 'grupo'
      });
      if (existente) {
        return res.status(409).json(
          await buildPacienteDuplicadoPayloadForRequest(req, {
            paciente: existente,
            clinicaId: clinica_id,
            normPhone,
            normEmail
          })
        );
      }
    }

    const newPaciente = await Paciente.create({
      public_id: await generateUniquePacientePublicId(),
      nombre: normalizedNombre,
      apellidos: normalizedApellidos,
      dni,
      telefono_movil: normPhone,
      email: normEmail,
      telefono_secundario,
      foto,
      fecha_nacimiento,
      edad,
      estatura,
      peso,
      sexo,
      profesion,
      fecha_alta,
      fecha_baja,
      alergias,
      antecedentes,
      medicacion,
      idioma_preferido: languageForNewPatient(idioma_preferido),
      paciente_conocido,
      como_nos_conocio,
      procedencia,
      clinica_id
    });

    // Crear relación con tutor si aplica
    if (tutorPaciente) {
      await PacienteRelacion.create({
        id_paciente: newPaciente.id_paciente,
        id_paciente_relacionado: tutorPaciente.id_paciente,
        tipo_relacion: tutor.tipo_relacion || 'tutor_legal',
        es_contacto_principal: tutor.es_contacto_principal === false ? false : true,
        fecha_inicio: tutor.fecha_inicio || new Date()
      });
    }
    // Vincular a la clínica actual como principal
    await PacienteClinica.create({
      paciente_id: newPaciente.id_paciente,
      clinica_id,
      es_principal: true
    });

    res.status(201).json({
      message: 'Paciente creado exitosamente',
      paciente: newPaciente,
      reuseCandidate: false,
      vinculado: true
    });
  } catch (error) {
    if (error.status === 400 && error.message === 'unsupported_patient_language') {
      return res.status(400).json({
        message: 'idioma_preferido inválido',
        allowed: error.details?.allowed || ['es', 'ca', 'en'],
      });
    }
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error creating paciente', error: error.message });
  }
};

/**
 * Vincula un paciente existente a otra clínica del mismo grupo sin duplicar ficha.
 */
exports.vincularPacienteAClinica = async (req, res) => {
  try {
    const { id } = req.params;
    const { clinica_id } = req.body || {};
    const targetClinicaId = parseInt(clinica_id, 10);

    if (!targetClinicaId) {
      return res.status(400).json({ message: 'clinica_id es obligatorio' });
    }
    await assertPatientEditAccess(req, targetClinicaId);

    const paciente = await findPacienteByIdentifier(id, { include: [{ model: Clinica, as: 'clinica' }] });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }
    await assertPatientEditAccess(req, paciente.clinica_id);

    const clinicaOrigen = paciente.clinica;
    const clinicaDestino = await Clinica.findByPk(targetClinicaId);

    if (!clinicaDestino) {
      return res.status(404).json({ message: 'Clínica destino no encontrada' });
    }

    // Solo permitimos vincular dentro del mismo grupo de clínicas
    if (clinicaOrigen?.grupoClinicaId && clinicaDestino.grupoClinicaId && clinicaOrigen.grupoClinicaId !== clinicaDestino.grupoClinicaId) {
      return res.status(400).json({ message: 'El paciente solo puede vincularse a clínicas del mismo grupo' });
    }

    const existente = await PacienteClinica.findOne({
      where: { paciente_id: paciente.id_paciente, clinica_id: targetClinicaId }
    });

    if (existente) {
      return res.json({ message: 'Paciente ya vinculado a la clínica', vinculado: true });
    }

    await PacienteClinica.create({
      paciente_id: paciente.id_paciente,
      clinica_id: targetClinicaId,
      es_principal: false
    });

    return res.json({ message: 'Paciente vinculado correctamente', vinculado: true });
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error al vincular paciente', error: error.message });
  }
};

exports.updatePaciente = async (req, res) => {
  try {
    const paciente = await findPacienteByIdentifier(req.params.id);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    const nextClinicaId = req.body.clinica_id !== undefined ? req.body.clinica_id : paciente.clinica_id;
    await assertPatientEditAccess(req, paciente.clinica_id);
    if (Number(nextClinicaId) !== Number(paciente.clinica_id)) {
      await assertPatientEditAccess(req, nextClinicaId);
    }
    const nextTelefono = req.body.telefono_movil !== undefined ? req.body.telefono_movil : paciente.telefono_movil;
    const nextEmail = req.body.email !== undefined ? req.body.email : paciente.email;
    const normPhone = normalizePhone(nextTelefono);
    const normEmail = normalizeEmail(nextEmail);

    if (normPhone || normEmail) {
      const duplicado = await findDuplicatePaciente({
        telefono: nextTelefono,
        email: nextEmail,
        clinicaId: nextClinicaId,
        scope: 'grupo',
        excludePacienteId: paciente.id_paciente
      });

      if (duplicado) {
        return res.status(409).json(
          await buildPacienteDuplicadoPayloadForRequest(req, {
            paciente: duplicado,
            clinicaId: nextClinicaId,
            normPhone,
            normEmail
          })
        );
      }
    }

    const fieldsToUpdate = ['nombre', 'apellidos', 'dni', 'telefono_movil', 'email', 'telefono_secundario', 'foto', 'fecha_nacimiento', 'edad', 'estatura', 'peso', 'sexo', 'profesion', 'fecha_alta', 'fecha_baja', 'alergias', 'antecedentes', 'medicacion', 'idioma_preferido', 'paciente_conocido', 'como_nos_conocio', 'procedencia', 'clinica_id'];
    fieldsToUpdate.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'telefono_movil') {
          paciente[field] = normPhone;
          return;
        }
        if (field === 'email') {
          paciente[field] = normEmail;
          return;
        }
        if (field === 'nombre' || field === 'apellidos') {
          paciente[field] = normalizeHumanName(req.body[field]);
          return;
        }
        if (field === 'idioma_preferido') {
          paciente[field] = normalizePatientLanguage(req.body[field]);
          return;
        }
        paciente[field] = req.body[field];
      }
    });
    await paciente.save();
    res.json({
      message: 'Paciente actualizado exitosamente',
      paciente
    });
  } catch (error) {
    if (error.status === 400 && error.message === 'unsupported_patient_language') {
      return res.status(400).json({
        message: 'idioma_preferido inválido',
        allowed: error.details?.allowed || ['es', 'ca', 'en'],
      });
    }
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error updating paciente', error: error.message });
  }
};

/**
 * Transferir contacto al propio paciente (al cumplir mayoría de edad, etc.)
 */
exports.transferirContacto = async (req, res) => {
  try {
    const { id } = req.params;
    const { telefono_movil, email } = req.body || {};
    const normPhone = normalizePhone(telefono_movil);
    const normEmail = normalizeEmail(email);
    if (!normPhone && !normEmail) {
      return res.status(400).json({ message: 'Se requiere teléfono o email para transferir el contacto' });
    }

    const paciente = await findPacienteByIdentifier(id, { include: [{ model: Clinica, as: 'clinica' }] });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }
    await assertPatientEditAccess(req, paciente.clinica_id);

    if (normPhone || normEmail) {
      const duplicado = await findDuplicatePaciente({
        telefono: telefono_movil,
        email,
        clinicaId: paciente.clinica_id,
        scope: 'grupo',
        excludePacienteId: paciente.id_paciente
      });
      if (duplicado) {
        return res.status(409).json(
          await buildPacienteDuplicadoPayloadForRequest(req, {
            paciente: duplicado,
            clinicaId: paciente.clinica_id,
            normPhone,
            normEmail
          })
        );
      }
    }

    // Actualizar paciente con sus datos de contacto
    await paciente.update({
      telefono_movil: normPhone || paciente.telefono_movil,
      email: normEmail || paciente.email
    });

    // Cerrar relaciones de tutoría como contacto principal
    await PacienteRelacion.update(
      { es_contacto_principal: false, fecha_fin: new Date() },
      { where: { id_paciente: paciente.id_paciente, es_contacto_principal: true, fecha_fin: null } }
    );

    const updated = await Paciente.findByPk(paciente.id_paciente, {
      include: [{ model: Clinica, as: 'clinica' }, { model: PacienteRelacion, as: 'relaciones', include: [{ model: Paciente, as: 'relacionado' }] }]
    });

    res.json({ message: 'Contacto transferido al paciente', paciente: updated });
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error al transferir contacto', error: error.message });
  }
};

exports.deletePaciente = async (req, res) => {
  try {
    const paciente = await findPacienteByIdentifier(req.params.id);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    await assertPatientEditAccess(req, paciente.clinica_id);
    await paciente.destroy();
    res.json({ message: 'Paciente eliminado' });
  } catch (error) {
    const handled = sendAccessPolicyError(error, res);
    if (handled) return handled;
    res.status(500).json({ message: 'Error deleting paciente', error: error.message });
  }
};

exports.__patientClinicScopeContract = Object.freeze({
  restrictPacientePayloadToClinics,
});
