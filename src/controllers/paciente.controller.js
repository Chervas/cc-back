'use strict';
const { Paciente, Clinica, PacienteRelacion, PacienteClinica, PacienteConsentimiento, CitaPaciente, Usuario, Tratamiento } = require('../../models');
const { Op, literal } = require('sequelize');
const { normalizePhoneDigits } = require('../lib/phone');

const normalizePhone = (phone) => {
  return normalizePhoneDigits(phone);
};

const normalizeEmail = (email) => {
  if (!email) return null;
  return email.toString().trim().toLowerCase();
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
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('es-ES') : null;
};

const formatTimeEs = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
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
    info_enviada: 'Info enviada',
    info_confirmada: 'Info confirmada',
    recordatorio_enviado: 'Recordatorio enviado',
    recordatorio_confirmado: 'Recordatorio confirmado',
    completada: 'Completada',
    no_asistio: 'No asistió',
    cancelada: 'Cancelada',
    reprogramada: 'Reprogramada',
  };
  return labels[normalized] || normalized.replace(/_/g, ' ');
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
    res.json(pacientes);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving pacientes', error: error.message });
  }
};

exports.searchPacientes = async (req, res) => {
  try {
    const query = req.query.q || req.query.query || '';
    const scope = req.query.scope || 'clinica';
    const clinicaId = req.query.clinica_id;
    const normPhone = normalizePhone(req.query.telefono || '');
    const normEmail = normalizeEmail(req.query.email || '');

    // No permitir búsqueda vacía para evitar devolver todo
    if (!query && !normPhone && !normEmail) {
      return res.json([]);
    }

    const whereOr = [
      { nombre: { [Op.like]: `%${query}%` } },
      { apellidos: { [Op.like]: `%${query}%` } },
      { telefono_movil: { [Op.like]: `%${query}%` } },
      { email: { [Op.like]: `%${query}%` } }
    ];
    if (normPhone) {
      whereOr.push({ telefono_movil: { [Op.like]: `%${normPhone}%` } });
    }
    if (normEmail) {
      whereOr.push({ email: { [Op.like]: `%${normEmail}%` } });
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
    const paciente = await Paciente.findByPk(pacienteId);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }

    const consents = await PacienteConsentimiento.findAll({
      where: { paciente_id: pacienteId },
      order: [['createdAt', 'DESC']]
    });

    return res.status(200).json(consents);
  } catch (error) {
    return res.status(500).json({ message: 'Error obteniendo consentimientos', error: error.message });
  }
};

exports.getPacienteById = async (req, res) => {
  try {
    const paciente = await Paciente.findByPk(req.params.id, {
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
    res.json(paciente);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving paciente', error: error.message });
  }
};

exports.getPacienteActivity = async (req, res) => {
  try {
    const pacienteId = Number(req.params.id);
    if (!Number.isFinite(pacienteId) || pacienteId <= 0) {
      return res.status(400).json({ message: 'Paciente inválido' });
    }

    const citas = await CitaPaciente.findAll({
      where: { paciente_id: pacienteId },
      attributes: [
        'id_cita',
        'paciente_id',
        'estado',
        'inicio',
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
      items.push({
        id: `appointment-created-${cita.id_cita}`,
        pacienteId: String(pacienteId),
        fecha: cita.created_at || cita.inicio,
        tipo: 'appointment_created',
        titulo: 'Cita agendada',
        descripcion: createdDescriptions.plain,
        descripcion_html: createdDescriptions.html,
        icono: 'heroicons_outline:calendar-days',
        color: 'info',
        citaId: String(cita.id_cita),
        usuarioId: createdByUser ? String(createdByUser.id_usuario) : 'system',
        usuarioNombre: buildActorLabel(createdByUser),
        detalles: {
          estado: cita.estado || null,
        },
      });

      const updatedById = Number(cita.updated_by);
      const updatedAt = cita.updated_at ? new Date(cita.updated_at).getTime() : null;
      const createdAt = cita.created_at ? new Date(cita.created_at).getTime() : null;
      if (!updatedById || !updatedAt || !createdAt || updatedAt <= createdAt) {
        continue;
      }

      const eventTypeByStatus = {
        info_confirmada: 'appointment_confirmed',
        recordatorio_confirmado: 'appointment_confirmed',
        completada: 'appointment_completed',
        cancelada: 'appointment_cancelled',
        no_asistio: 'appointment_no_show',
        reprogramada: 'appointment_rescheduled',
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
        titulo: 'Estado de cita actualizado',
        descripcion: updatedDescriptions.plain,
        descripcion_html: updatedDescriptions.html,
        icono: 'heroicons_outline:check-badge',
        color: ['cancelada', 'no_asistio'].includes(cita.estado) ? 'warning' : 'success',
        citaId: String(cita.id_cita),
        usuarioId: updatedByUser ? String(updatedByUser.id_usuario) : 'system',
        usuarioNombre: buildActorLabel(updatedByUser),
        detalles: {
          estado: cita.estado,
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
    if (!nombre) {
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
      nombre,
      apellidos,
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

    const paciente = await Paciente.findByPk(id, { include: [{ model: Clinica, as: 'clinica' }] });
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
    const paciente = await Paciente.findByPk(req.params.id);
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

    const paciente = await Paciente.findByPk(id, { include: [{ model: Clinica, as: 'clinica' }] });
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

    const updated = await Paciente.findByPk(id, {
      include: [{ model: Clinica, as: 'clinica' }, { model: PacienteRelacion, as: 'relaciones', include: [{ model: Paciente, as: 'relacionado' }] }]
    });

    res.json({ message: 'Contacto transferido al paciente', paciente: updated });
  } catch (error) {
    res.status(500).json({ message: 'Error al transferir contacto', error: error.message });
  }
};

exports.deletePaciente = async (req, res) => {
  try {
    const paciente = await Paciente.findByPk(req.params.id);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    await paciente.destroy();
    res.json({ message: 'Paciente eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting paciente', error: error.message });
  }
};
