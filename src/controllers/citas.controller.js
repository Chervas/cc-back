const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../models');

const CitaPaciente = db.CitaPaciente;
const LeadIntake = db.LeadIntake;
const Paciente = db.Paciente;
const Clinica = db.Clinica;
const Campana = db.Campana;
const Instalacion = db.Instalacion;
const InstalacionHorario = db.InstalacionHorario;
const InstalacionBloqueo = db.InstalacionBloqueo;
const DoctorClinica = db.DoctorClinica;
const DoctorHorario = db.DoctorHorario;
const DoctorBloqueo = db.DoctorBloqueo;
const Tratamiento = db.Tratamiento;

/**
 * Helper: asegurar vínculo paciente-clínica sin romper por duplicados
 */
async function ensurePacienteClinica({ paciente_id, clinica_id, es_principal }) {
    try {
        const [vinculo] = await db.PacienteClinica.findOrCreate({
            where: { paciente_id, clinica_id },
            defaults: { es_principal }
        });
        return vinculo;
    } catch (err) {
        if (err && err.name === 'SequelizeUniqueConstraintError') {
            return db.PacienteClinica.findOne({ where: { paciente_id, clinica_id } });
        }
        throw err;
    }
}

/**
 * Helper: encontrar o crear paciente por teléfono/email en una clínica
 */
async function findOrCreatePaciente({ clinica_id, nombre, apellidos, telefono, email, id_paciente }) {
    if (!telefono && !email && !id_paciente) {
        throw new Error('Se requiere teléfono o email para crear el paciente');
    }

    // Si viene un id_paciente, vincularlo si hace falta y devolverlo
    if (id_paciente) {
        const existente = await Paciente.findByPk(id_paciente, {
            include: [{ model: db.PacienteClinica, as: 'clinicasVinculadas', required: false }]
        });
        if (!existente) {
            throw new Error('Paciente no encontrado');
        }
        const yaVinculado = existente.clinica_id === clinica_id ||
            (existente.clinicasVinculadas || []).some(vc => vc.clinica_id === clinica_id);
        if (!yaVinculado) {
            await ensurePacienteClinica({
                paciente_id: existente.id_paciente,
                clinica_id,
                es_principal: false
            });
        }
        return existente;
    }

    const whereContacto = [];
    if (telefono) {
        whereContacto.push({ telefono_movil: telefono });
    }
    if (email) {
        whereContacto.push({ email });
    }

    const paciente = await Paciente.findOne({
        where: {
            [Op.and]: [
                { [Op.or]: whereContacto },
                {
                    [Op.or]: [
                        { clinica_id },
                        { '$clinicasVinculadas.clinica_id$': clinica_id }
                    ]
                }
            ]
        },
        include: [
            {
                model: db.PacienteClinica,
                as: 'clinicasVinculadas',
                required: false
            }
        ]
    });
    if (paciente) {
        // Asegurar vínculo explícito
        const yaVinculado = (paciente.clinicasVinculadas || []).some(vc => vc.clinica_id === clinica_id);
        if (!yaVinculado) {
            await ensurePacienteClinica({
                paciente_id: paciente.id_paciente,
                clinica_id,
                es_principal: false
            });
        }
        return paciente;
    }

    const nuevoPaciente = await Paciente.create({
        nombre: nombre || 'Sin nombre',
        apellidos: apellidos || '',
        telefono_movil: telefono || '',
        email: email || null,
        clinica_id: clinica_id
    });

    await ensurePacienteClinica({
        paciente_id: nuevoPaciente.id_paciente,
        clinica_id,
        es_principal: true
    });

    return nuevoPaciente;
}

const parseBool = (v) => v === true || v === 'true' || v === '1';
const overlap = (startA, endA, startB, endB) => startA < endB && startB < endA;
const dayIndex = (date) => new Date(date).getDay();
const toTime = (d) => d.toTimeString().slice(0,5);

async function checkDisponibilidad({ clinica_id, inicio, fin, doctor_id, instalacion_id }) {
    const conflicts = [];
    const start = new Date(inicio);
    const end = new Date(fin);
    const dow = dayIndex(start);

    if (instalacion_id) {
        const inst = await Instalacion.findByPk(instalacion_id, { include: [{ model: InstalacionHorario, as: 'horarios' }, { model: InstalacionBloqueo, as: 'bloqueos' }] });
        if (!inst || !inst.activo) conflicts.push({ type: 'not_found', message: 'Instalación no encontrada o inactiva' });
        else {
            if (inst.clinica_id !== clinica_id) conflicts.push({ type: 'not_in_clinic', message: 'Instalación fuera de la clínica' });
            const h = (inst.horarios || []).find(h => h.dia_semana === dow);
            const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
            if (!inRange) conflicts.push({ type: 'out_of_hours', message: 'Instalación fuera de horario' });
            (inst.bloqueos || []).forEach(b => {
                if (overlap(start, end, b.fecha_inicio, b.fecha_fin)) conflicts.push({ type: 'blocked', message: b.motivo || 'Bloqueo instalación' });
            });
            const citasInst = await CitaPaciente.findAll({ where: { instalacion_id, inicio: { [db.Sequelize.Op.lt]: end }, fin: { [db.Sequelize.Op.gt]: start } }, attributes: ['id_cita'] });
            if (citasInst.length) conflicts.push({ type: 'overlap', message: 'Instalación ocupada' });
        }
    }

    if (doctor_id) {
        const dc = await DoctorClinica.findOne({ where: { doctor_id, clinica_id }, include: [{ model: DoctorHorario, as: 'horarios' }] });
        if (!dc || !dc.activo) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor no asignado a la clínica' });
        else {
            const h = (dc.horarios || []).find(h => h.dia_semana === dow);
            const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
            if (!inRange) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor fuera de horario' });
        }
        const bloqueos = await DoctorBloqueo.findAll({ where: { doctor_id, fecha_inicio: { [db.Sequelize.Op.lt]: end }, fecha_fin: { [db.Sequelize.Op.gt]: start } } });
        if (bloqueos.length) conflicts.push({ type: 'doctor_unavailable', message: bloqueos[0].motivo || 'Bloqueo doctor' });
        const citasDoc = await CitaPaciente.findAll({ where: { doctor_id, inicio: { [db.Sequelize.Op.lt]: end }, fin: { [db.Sequelize.Op.gt]: start } }, attributes: ['id_cita'] });
        if (citasDoc.length) conflicts.push({ type: 'overlap', message: 'Doctor ocupado' });
    }
    return conflicts;
}

/**
 * Helper: conflictos canónicos (17.6) + compatibilidad legacy para el 409 de POST /citas.
 * Fuente de verdad: solo se permite `force=true` cuando el único conflicto es `STAFF_OVERLAP` (doctor).
 */
async function checkDisponibilidadCanonica({ clinica_id, inicio, fin, doctor_id, instalacion_id, ignore_cita_id = null }) {
    const clinicaId = Number(clinica_id);
    const start = new Date(inicio);
    const end = new Date(fin);
    const dow = dayIndex(start);

    const resourceConflicts = [];
    const legacyConflicts = [];

    const addLegacy = (type, message) => legacyConflicts.push({ type, message });
    const addResource = (conflict) => resourceConflicts.push(conflict);

    // Instalación
    if (instalacion_id) {
        const inst = await Instalacion.findByPk(instalacion_id, {
            include: [
                { model: InstalacionHorario, as: 'horarios' },
                { model: InstalacionBloqueo, as: 'bloqueos' }
            ]
        });

        if (!inst || !inst.activo) {
            addLegacy('not_found', 'Instalación no encontrada o inactiva');
            addResource({
                resource_type: 'installation',
                resource_id: Number(instalacion_id),
                clinica_id: clinicaId,
                code: 'INSTALLATION_BLOCKED',
                can_force: false,
                details: { message: 'Instalación no encontrada o inactiva' }
            });
        } else if (inst.clinica_id !== clinicaId) {
            addLegacy('not_in_clinic', 'Instalación fuera de la clínica');
            addResource({
                resource_type: 'installation',
                resource_id: Number(instalacion_id),
                clinica_id: clinicaId,
                code: 'INSTALLATION_BLOCKED',
                can_force: false,
                details: { message: 'Instalación fuera de la clínica' }
            });
        } else {
            const h = (inst.horarios || []).find(h => h.dia_semana === dow);
            const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
            if (!inRange) {
                addLegacy('out_of_hours', 'Instalación fuera de horario');
                addResource({
                    resource_type: 'installation',
                    resource_id: Number(instalacion_id),
                    clinica_id: clinicaId,
                    code: 'INSTALLATION_OUT_OF_HOURS',
                    can_force: false,
                    details: { message: 'Instalación fuera de horario' }
                });
            }

            (inst.bloqueos || []).forEach(b => {
                if (overlap(start, end, b.fecha_inicio, b.fecha_fin)) {
                    addLegacy('blocked', b.motivo || 'Bloqueo instalación');
                    addResource({
                        resource_type: 'installation',
                        resource_id: Number(instalacion_id),
                        clinica_id: clinicaId,
                        code: 'INSTALLATION_BLOCKED',
                        can_force: false,
                        details: { bloqueo_id: b.id, message: b.motivo || 'Bloqueo instalación' }
                    });
                }
            });

            const citasInstWhere = {
                instalacion_id,
                inicio: { [db.Sequelize.Op.lt]: end },
                fin: { [db.Sequelize.Op.gt]: start }
            };
            if (ignore_cita_id) citasInstWhere.id_cita = { [db.Sequelize.Op.ne]: ignore_cita_id };
            const citasInst = await CitaPaciente.findAll({ where: citasInstWhere, attributes: ['id_cita'] });
            if (citasInst.length) {
                addLegacy('overlap', 'Instalación ocupada');
                addResource({
                    resource_type: 'installation',
                    resource_id: Number(instalacion_id),
                    clinica_id: clinicaId,
                    code: 'INSTALLATION_OVERLAP',
                    can_force: false,
                    details: { cita_ids: citasInst.map(c => c.id_cita), message: 'Instalación ocupada' }
                });
            }
        }
    }

    // Staff (doctor)
    if (doctor_id) {
        const dc = await DoctorClinica.findOne({ where: { doctor_id, clinica_id: clinicaId, activo: true }, include: [{ model: DoctorHorario, as: 'horarios' }] });

        if (!dc) {
            addLegacy('doctor_unavailable', 'Doctor no asignado a la clínica');
            addResource({
                resource_type: 'staff',
                resource_role: 'doctor',
                resource_id: Number(doctor_id),
                clinica_id: clinicaId,
                code: 'STAFF_OUT_OF_HOURS',
                can_force: false,
                details: { message: 'Doctor no asignado a la clínica' }
            });
        } else {
            const h = (dc.horarios || []).find(h => h.dia_semana === dow);
            const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
            if (!inRange) {
                addLegacy('doctor_unavailable', 'Doctor fuera de horario');
                addResource({
                    resource_type: 'staff',
                    resource_role: 'doctor',
                    resource_id: Number(doctor_id),
                    clinica_id: clinicaId,
                    code: 'STAFF_OUT_OF_HOURS',
                    can_force: false,
                    details: { message: 'Doctor fuera de horario' }
                });
            }
        }

        const bloqueos = await DoctorBloqueo.findAll({ where: { doctor_id, fecha_inicio: { [db.Sequelize.Op.lt]: end }, fecha_fin: { [db.Sequelize.Op.gt]: start } } });
        if (bloqueos.length) {
            addLegacy('doctor_unavailable', bloqueos[0].motivo || 'Bloqueo doctor');
            addResource({
                resource_type: 'staff',
                resource_role: 'doctor',
                resource_id: Number(doctor_id),
                clinica_id: clinicaId,
                code: 'STAFF_BLOCKED',
                can_force: false,
                details: { bloqueo_id: bloqueos[0].id, message: bloqueos[0].motivo || 'Bloqueo doctor' }
            });
        }

        const citasDocWhere = { doctor_id, inicio: { [db.Sequelize.Op.lt]: end }, fin: { [db.Sequelize.Op.gt]: start } };
        if (ignore_cita_id) citasDocWhere.id_cita = { [db.Sequelize.Op.ne]: ignore_cita_id };
        const citasDoc = await CitaPaciente.findAll({ where: citasDocWhere, attributes: ['id_cita'] });
        if (citasDoc.length) {
            addLegacy('overlap', 'Doctor ocupado');
            addResource({
                resource_type: 'staff',
                resource_role: 'doctor',
                resource_id: Number(doctor_id),
                clinica_id: clinicaId,
                code: 'STAFF_OVERLAP',
                can_force: true,
                details: { cita_ids: citasDoc.map(c => c.id_cita), message: 'Doctor ocupado' }
            });
        }
    }

    const canForce = resourceConflicts.length > 0 && resourceConflicts.every((c) => !!c.can_force);

    return { resourceConflicts, legacyConflicts, canForce };
}

/**
 * Crear cita para paciente (y lead opcional)
 */
exports.createCita = asyncHandler(async (req, res) => {
    try {
        const {
            clinica_id,
            inicio,
            fin,
            duracion_min = null,
            estado = 'pendiente',
            nota,
            motivo,
            tipo_cita = 'continuacion',
            lead_intake_id = null,
            doctor_id = null,
            instalacion_id = null,
            tratamiento_id = null,
            campana_id = null,
            force = false,
            paciente: datosPaciente
        } = req.body || {};

        if (!clinica_id || !inicio || (!fin && !duracion_min) || !datosPaciente) {
            return res.status(400).json({ message: 'clinica_id, inicio, (fin o duracion_min) y paciente son obligatorios' });
        }

        // Validar clínica
        const clinica = await Clinica.findOne({ where: { id_clinica: clinica_id } });
        if (!clinica) {
            return res.status(400).json({ message: 'Clínica no encontrada' });
        }

        // Resolver lead si viene
        let lead = null;
        if (lead_intake_id) {
            lead = await LeadIntake.findByPk(lead_intake_id);
            if (!lead) {
                return res.status(404).json({ message: 'Lead no encontrado' });
            }
        }

        // Calcular fin si falta: prioridad cuerpo -> tratamiento -> instalación -> 30
        const inicioDate = new Date(inicio);
        let finDate = fin ? new Date(fin) : null;
        let duracionEfectiva = duracion_min ? parseInt(duracion_min, 10) : null;

        if (!duracionEfectiva && tratamiento_id) {
            const trat = await Tratamiento.findByPk(tratamiento_id, { attributes: ['duracion_min'] });
            if (trat?.duracion_min) duracionEfectiva = trat.duracion_min;
        }
        if (!duracionEfectiva && instalacion_id) {
            const inst = await Instalacion.findByPk(instalacion_id, { attributes: ['default_duracion_minutos'] });
            if (inst?.default_duracion_minutos) duracionEfectiva = inst.default_duracion_minutos;
        }
        if (!duracionEfectiva) duracionEfectiva = 30;
        if (!finDate) finDate = new Date(inicioDate.getTime() + duracionEfectiva * 60000);

        // Chequear disponibilidad si hay doctor/instalación (canónico + legacy)
        const { resourceConflicts, legacyConflicts, canForce } = await checkDisponibilidadCanonica({
            clinica_id,
            inicio: inicioDate,
            fin: finDate,
            doctor_id,
            instalacion_id
        });

        if (resourceConflicts.length) {
            const wantsForce = parseBool(force);

            // Solo se puede forzar si el único conflicto es STAFF_OVERLAP (doctor).
            if (!wantsForce || !canForce) {
                const firstLegacy = legacyConflicts[0];
                const reason = (firstLegacy && ['overlap', 'blocked', 'out_of_hours', 'doctor_unavailable'].includes(firstLegacy.type))
                    ? firstLegacy.type
                    : 'blocked';

                return res.status(409).json({
                    reason,
                    message: 'No hay disponibilidad para el rango solicitado.',
                    can_force: canForce,
                    resource_conflicts: resourceConflicts,
                    // Compatibilidad con el frontend legacy actual
                    conflicts: legacyConflicts
                });
            }
            // wantsForce && canForce -> seguimos
        }

        // Resolver/crear paciente
        const paciente = await findOrCreatePaciente({
            clinica_id,
            nombre: datosPaciente.nombre,
            apellidos: datosPaciente.apellidos,
            telefono: datosPaciente.telefono,
            email: datosPaciente.email,
            id_paciente: datosPaciente.id_paciente || datosPaciente.id
        });

        // Crear cita
        const cita = await CitaPaciente.create({
            clinica_id,
            paciente_id: paciente.id_paciente,
            lead_intake_id: lead_intake_id || null,
            doctor_id,
            instalacion_id,
            tratamiento_id,
            campana_id: campana_id || lead?.campana_id || null,
            titulo: datosPaciente.titulo || null,
            nota: nota || null,
            motivo: motivo || null,
            tipo_cita,
            estado,
            inicio: inicioDate,
            fin: finDate
        });

        // Marcar lead como citado si aplica
        if (lead) {
            await lead.update({ status_lead: 'citado' });
        }

        const citaCreada = await CitaPaciente.findByPk(cita.id_cita, {
            include: [
                { model: Paciente, as: 'paciente' },
                { model: LeadIntake, as: 'lead' },
                { model: Clinica, as: 'clinica', attributes: ['id_clinica','nombre_clinica', ['grupoClinicaId', 'grupo_clinica_id']] },
                Campana ? { model: Campana, as: 'campana' } : null
            ].filter(Boolean)
        });

        return res.status(201).json(citaCreada);
    } catch (err) {
        console.error('❌ [createCita] Error:', err.message, err.original?.sqlMessage || '', err);
        return res.status(500).json({
            message: 'error_creating_cita',
            detail: err.original?.sqlMessage || err.message
        });
    }
});

/**
 * Listar citas (simplificado para calendario)
 */
exports.getCitas = asyncHandler(async (req, res) => {
    const { clinica_id, startDate, endDate } = req.query;

    const where = {};
    if (clinica_id) {
        where.clinica_id = clinica_id;
    }
    if (startDate && endDate) {
        where.inicio = { [db.Sequelize.Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const citas = await CitaPaciente.findAll({
        where,
        order: [['inicio', 'ASC']],
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica' }
        ]
    });

    res.json(citas);
});

/**
 * Obtener la próxima cita de un paciente en una clínica
 */
exports.getNextCita = asyncHandler(async (req, res) => {
    const { clinica_id, paciente_id } = req.query;
    const clinicaId = Number(clinica_id);
    const pacienteId = Number(paciente_id);

    if (!clinica_id || !paciente_id || Number.isNaN(clinicaId) || Number.isNaN(pacienteId)) {
        return res.status(400).json({ message: 'clinica_id y paciente_id son obligatorios' });
    }

    const now = new Date();
    const where = {
        clinica_id: clinicaId,
        paciente_id: pacienteId,
        inicio: { [Op.gte]: now }
    };

    const cita = await CitaPaciente.findOne({
        where,
        order: [['inicio', 'ASC']],
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica' }
        ]
    });

    return res.json(cita || null);
});
