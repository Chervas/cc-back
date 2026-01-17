const asyncHandler = require('express-async-handler');
const db = require('../../models');

const CitaPaciente = db.CitaPaciente;
const LeadIntake = db.LeadIntake;
const Paciente = db.Paciente;
const Clinica = db.Clinica;
const Campana = db.Campana;

/**
 * Helper: encontrar o crear paciente por teléfono/email en una clínica
 */
async function findOrCreatePaciente({ clinica_id, nombre, apellidos, telefono, email }) {
    if (!telefono && !email) {
        throw new Error('Se requiere teléfono o email para crear el paciente');
    }

    const where = { clinica_id };
    if (telefono) {
        where.telefono_movil = telefono;
    } else if (email) {
        where.email = email;
    }

    let paciente = await Paciente.findOne({ where });
    if (paciente) {
        return paciente;
    }

    paciente = await Paciente.create({
        nombre: nombre || 'Sin nombre',
        apellidos: apellidos || '',
        telefono_movil: telefono || '',
        email: email || null,
        clinica_id: clinica_id
    });

    return paciente;
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
        lead_intake_id = null,
        doctor_id = null,
        instalacion_id = null,
        tratamiento_id = null,
        campana_id = null,
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

    // Resolver/crear paciente
    const paciente = await findOrCreatePaciente({
        clinica_id,
        nombre: datosPaciente.nombre,
        apellidos: datosPaciente.apellidos,
        telefono: datosPaciente.telefono,
        email: datosPaciente.email
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
