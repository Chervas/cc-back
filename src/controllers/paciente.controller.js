'use strict';
const { Paciente, Clinica, PacienteRelacion, PacienteClinica, PacienteConsentimiento, CitaPaciente, Usuario, Tratamiento, sequelize } = require('../../models');
const { Op, literal, QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { normalizePhoneDigits } = require('../lib/phone');
const { normalizeHumanName } = require('../lib/name');

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

const getPacienteAppointmentBounds = async (pacienteId) => {
  const now = new Date();
  const baseWhere = {
    paciente_id: pacienteId,
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
  const motivo = String(cita?.motivo || '').trim().toLowerCase();
  const nota = String(cita?.nota || '').trim().toLowerCase();
  return tipoCita === 'historico_importado'
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
    let whereClause = {};
    const include = [
      { model: Clinica, as: 'clinica' },
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

    if (req.query.clinica_id) {
      const clinicaParam = req.query.clinica_id;
      const clinicaList = typeof clinicaParam === 'string' && clinicaParam.indexOf(',') !== -1
        ? clinicaParam.split(',').map(id => parseInt(id, 10))
        : [parseInt(clinicaParam, 10)];

      include.push({
        model: PacienteClinica,
        as: 'clinicasVinculadas',
        required: false,
        include: [{ model: Clinica, as: 'clinica' }]
      });

      const clinicFilter = clinicaList.length === 1 ? clinicaList[0] : { [Op.in]: clinicaList };
      const clinicExists = literal(`EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id = Paciente.id_paciente AND pc.clinica_id IN (${clinicaList.join(',')}))`);

      whereClause = {
        [Op.or]: [
          { clinica_id: clinicFilter },
          clinicExists
        ]
      };
    }
    const pacientes = await Paciente.findAll({
      where: whereClause,
      include,
      distinct: true,
      order: [['nombre', 'ASC']]
    });
    await Promise.all(pacientes.map((paciente) => ensurePacientePublicId(paciente)));
    res.json(pacientes);
  } catch (error) {
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
    const clinicIdsList = clinicaIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
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
    res.json(pacientes);
  } catch (error) {
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

    const pacienteExistente = await findDuplicatePaciente({
      telefono,
      email,
      clinicaId: clinica_id,
      scope
    });

    if (!pacienteExistente) {
      return res.json({ exists: false });
    }

    const targetClinicaId = parseInt(clinica_id, 10);
    const hasLink = isPacienteLinkedToClinic(pacienteExistente, targetClinicaId);
    const clinicaNombre = hasLink ? null : resolvePacienteClinicLabel(pacienteExistente, targetClinicaId);

    return res.json({
      exists: true,
      paciente: pacienteExistente,
      sameClinic: hasLink,
      clinicaNombre,
      reuseCandidate: !hasLink,
      vinculos: (pacienteExistente.clinicasVinculadas || []).map(vc => ({
        clinica_id: vc.clinica_id,
        clinicaNombre: vc.clinica?.nombre_clinica || null,
        es_principal: vc.es_principal
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al verificar duplicados', error: error.message });
  }
};

exports.getConsents = async (req, res) => {
  try {
    const pacienteId = req.params.id;
    const paciente = await findPacienteByIdentifier(pacienteId);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }

    const consents = await PacienteConsentimiento.findAll({
      where: { paciente_id: paciente.id_paciente },
      order: [['createdAt', 'DESC']]
    });

    return res.status(200).json(consents);
  } catch (error) {
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
    const appointmentSummary = await getPacienteAppointmentBounds(paciente.id_paciente);
    res.json({
      ...(typeof paciente.toJSON === 'function' ? paciente.toJSON() : paciente),
      ...appointmentSummary,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving paciente', error: error.message });
  }
};

exports.getPacienteActivity = async (req, res) => {
  try {
    const paciente = await findPacienteByIdentifier(req.params.id, { attributes: ['id_paciente', 'public_id'] });
    if (!paciente) {
      return res.status(400).json({ message: 'Paciente inválido' });
    }
    const pacienteId = Number(paciente.id_paciente);

    const citas = await CitaPaciente.findAll({
      where: { paciente_id: pacienteId },
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
      { replacements: { pacienteId }, type: QueryTypes.SELECT }
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

    return res.json(items.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()));
  } catch (error) {
    return res.status(500).json({ message: 'Error retrieving paciente activity', error: error.message });
  }
};

exports.createPaciente = async (req, res) => {
  try {
    const { nombre, apellidos, dni, telefono_movil, email, telefono_secundario, foto, fecha_nacimiento, edad, estatura, peso, sexo, profesion, fecha_alta, fecha_baja, alergias, antecedentes, medicacion, paciente_conocido, como_nos_conocio, procedencia, clinica_id, tutor } = req.body;
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

    if (normPhone || normEmail) {
      const existente = await findDuplicatePaciente({
        telefono: telefono_movil,
        email,
        clinicaId: clinica_id,
        scope: 'grupo'
      });
      if (existente) {
        return res.status(409).json(
          buildPacienteDuplicadoPayload({
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
      paciente_conocido,
      como_nos_conocio,
      procedencia,
      clinica_id
    });

    // Crear relación con tutor si aplica
    if (tutor?.id_paciente_relacionado) {
      await PacienteRelacion.create({
        id_paciente: newPaciente.id_paciente,
        id_paciente_relacionado: tutor.id_paciente_relacionado,
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

    const paciente = await findPacienteByIdentifier(id, { include: [{ model: Clinica, as: 'clinica' }] });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }

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
          buildPacienteDuplicadoPayload({
            paciente: duplicado,
            clinicaId: nextClinicaId,
            normPhone,
            normEmail
          })
        );
      }
    }

    const fieldsToUpdate = ['nombre', 'apellidos', 'dni', 'telefono_movil', 'email', 'telefono_secundario', 'foto', 'fecha_nacimiento', 'edad', 'estatura', 'peso', 'sexo', 'profesion', 'fecha_alta', 'fecha_baja', 'alergias', 'antecedentes', 'medicacion', 'paciente_conocido', 'como_nos_conocio', 'procedencia', 'clinica_id'];
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
        paciente[field] = req.body[field];
      }
    });
    await paciente.save();
    res.json({
      message: 'Paciente actualizado exitosamente',
      paciente
    });
  } catch (error) {
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
          buildPacienteDuplicadoPayload({
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
    res.status(500).json({ message: 'Error al transferir contacto', error: error.message });
  }
};

exports.deletePaciente = async (req, res) => {
  try {
    const paciente = await findPacienteByIdentifier(req.params.id);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    await paciente.destroy();
    res.json({ message: 'Paciente eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting paciente', error: error.message });
  }
};
