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
            await db.PacienteClinica.create({
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
            await db.PacienteClinica.create({
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

    await db.PacienteClinica.create({
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
 * Crear cita para paciente (y lead opcional)
 */
exports.createCita = asyncHandler(async (req, res) => {
    const {
        clinica_id,
        inicio,
        fin,
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

    if (!clinica_id || !inicio || !fin || !datosPaciente) {
        return res.status(400).json({ message: 'clinica_id, inicio, fin y paciente son obligatorios' });
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

    // Chequear disponibilidad si hay doctor/instalación
    const conflicts = await checkDisponibilidad({ clinica_id, inicio, fin, doctor_id, instalacion_id });
    if (conflicts.length && !parseBool(force)) {
        return res.status(409).json({ message: 'Conflicto de agenda', conflicts });
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
        inicio,
        fin
    });

    // Marcar lead como citado si aplica
    if (lead) {
        await lead.update({ status_lead: 'citado' });
    }

    const citaCreada = await CitaPaciente.findByPk(cita.id_cita, {
        include: [
            { model: Paciente, as: 'paciente' },
            { model: LeadIntake, as: 'lead' },
            { model: Clinica, as: 'clinica' },
            Campana ? { model: Campana, as: 'campana' } : null
        ].filter(Boolean)
    });

    return res.status(201).json(citaCreada);
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
