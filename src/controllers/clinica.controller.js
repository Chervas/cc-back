'use strict';

const { Clinica, GrupoClinica, Servicio } = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

// Obtener todas las clínicas
exports.getAllClinicas = async (req, res) => {
    try {
        const clinicas = await Clinica.findAll({
            order: [['nombre_clinica', 'ASC']]
        });
        res.json(clinicas);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving clinicas', error: error.message });
    }
};

// Buscar clínicas
exports.searchClinicas = async (req, res) => {
    try {
        const query = req.query.query;
        const clinicas = await Clinica.findAll({
            where: {
                nombre_clinica: { [Op.like]: `%${query}%` }
            },
            order: [['nombre_clinica', 'ASC']]
        });
        res.status(200).json(clinicas);
    } catch (error) {
        console.error('Error al buscar clínicas:', error);
        res.status(500).json({ message: 'Error al procesar la búsqueda', error: error.message });
    }
};

// Obtener una clínica por ID (incluyendo la asociación con GrupoClinica)
exports.getClinicaById = async (req, res) => {
    try {
        const clinica = await Clinica.findByPk(req.params.id, {
            include: [{
                model: GrupoClinica,
                as: 'grupoClinica'
            }]
        });
        if (!clinica) {
            return res.status(404).json({ message: 'Clinica not found' });
        }
        res.json(clinica);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving clinica', error: error.message });
    }
};

// Crear una nueva clínica (con grupoClinicaId opcional)
exports.createClinica = async (req, res) => {
    console.log('Intentando crear clinica con datos:', req.body);
    try {
        const {
            nombre_clinica,
            url_web,
            url_avatar,
            url_fondo, 
            url_ficha_local, 
            fecha_creacion = new Date(),
            id_publicidad_meta,
            filtro_pc_meta,
            url_publicidad_meta,
            id_publicidad_google,
            filtro_pc_google,
            url_publicidad_google,
            servicios,
            checklist,
            estado_clinica = true,
            datos_fiscales_clinica,
            grupoClinicaId  // Campo opcional para asignar grupo
        } = req.body;

        const newClinica = await Clinica.create({   
            nombre_clinica,
            url_web,
            url_avatar,
            url_fondo, 
            url_ficha_local, 
            fecha_creacion,
            id_publicidad_meta,
            filtro_pc_meta,
            url_publicidad_meta,
            id_publicidad_google,
            filtro_pc_google,
            url_publicidad_google,
            servicios,
            checklist,
            estado_clinica,
            datos_fiscales_clinica,
            grupoClinicaId
        });

        res.status(201).json({
            message: 'Clinica creada exitosamente',
            clinica: newClinica
        });
    } catch (error) {
        console.error('Error al crear la clínica:', error);
        res.status(500).json({ message: 'Error al crear la clínica', error: error.message });
    }
};

// Actualizar una clínica (incluyendo grupoClinicaId) y devolver la clínica actualizada con la asociación
// ✅ MÉTODO UPDATECLINICA CORREGIDO PARA EL CONTROLADOR


exports.updateClinica = async (req, res) => {
    try {
        // ✅ DEBUG COMPLETO para identificar el problema
        console.log('=== DEBUG RUTA ===');
        console.log('URL completa:', req.url);
        console.log('Método:', req.method);
        console.log('Params completos:', req.params);
        console.log('Param id_clinica:', req.params.id_clinica);
        console.log('Param id:', req.params.id);
        console.log('==================');
        
        // ✅ INTENTAR AMBAS OPCIONES
        let id_clinica = req.params.id_clinica || req.params.id;
        
        console.log('ID de clínica final:', id_clinica);
        
        // ✅ INCLUIR TODOS LOS CAMPOS que pueden venir del frontend
        const {
            nombre_clinica,
            telefono,
            email,
            descripcion,
            direccion,
            codigo_postal,
            ciudad,
            provincia,
            pais,
            horario_atencion,
            url_web,
            url_avatar,
            url_fondo,
            url_ficha_local,
            id_publicidad_meta,
            url_publicidad_meta,
            filtro_pc_meta,
            id_publicidad_google,
            url_publicidad_google,
            filtro_pc_google,
            servicios,
            checklist,
            estado_clinica,
            datos_fiscales_clinica,
            redes_sociales,
            configuracion,
            grupoClinicaId
        } = req.body;

        console.log('Datos recibidos para actualizar clínica:', req.body);

        // ✅ VERIFICAR que id_clinica no sea undefined
        if (!id_clinica) {
            console.error('❌ ID de clínica no encontrado en params');
            return res.status(400).json({ 
                message: 'ID de clínica requerido',
                debug: {
                    url: req.url,
                    params: req.params,
                    method: req.method
                }
            });
        }

        // ✅ ACTUALIZAR con TODOS los campos
        const [updatedRowsCount] = await Clinica.update({
            nombre_clinica,
            telefono,
            email,
            descripcion,
            direccion,
            codigo_postal,
            ciudad,
            provincia,
            pais,
            horario_atencion,
            url_web,
            url_avatar,
            url_fondo,
            url_ficha_local,
            id_publicidad_meta,
            url_publicidad_meta,
            filtro_pc_meta,
            id_publicidad_google,
            url_publicidad_google,
            filtro_pc_google,
            servicios,
            checklist,
            estado_clinica,
            datos_fiscales_clinica,
            redes_sociales,
            configuracion,
            grupoClinicaId
        }, {
            where: { id_clinica: id_clinica }
        });

        if (updatedRowsCount === 0) {
            return res.status(404).json({ message: 'Clínica no encontrada' });
        }

        // ✅ OBTENER la clínica actualizada con TODOS los campos
        const updatedClinica = await Clinica.findByPk(id_clinica, {
            include: [{
                model: GrupoClinica,
                as: 'grupoClinica',
                attributes: ['id_grupo', 'nombre_grupo']
            }]
        });

        console.log('Clínica actualizada con éxito:', updatedClinica);
        res.status(200).json(updatedClinica);

    } catch (error) {
        console.error('Error updating clinic:', error);
        res.status(500).json({ 
            message: 'Error al actualizar la clínica', 
            error: error.message 
        });
    }
};






// Eliminar una clínica
exports.deleteClinica = async (req, res) => {
    try {
        const clinica = await Clinica.findByPk(req.params.id);
        if (!clinica) {
            return res.status(404).json({ message: 'Clinica not found' });
        }
        await clinica.destroy();
        res.json({ message: 'Clinica deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting clinica', error: error.message });
    }
};

// Asignar servicio a clínica
exports.addServicioToClinica = async (req, res) => {
    try {
        const { id_clinica, id_servicio } = req.body;
        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(404).send({ message: 'Clínica o Servicio no encontrado' });
        }

        await clinica.addServicio(servicio);
        res.status(200).send({ message: 'Servicio asignado a clínica correctamente' });
    } catch (error) {
        res.status(500).send({ message: 'Error al asignar servicio a clínica', error: error.message });
    }
};

// Obtener servicios de una clínica
exports.getServiciosByClinica = async (req, res) => {
    try {
        const { id_clinica } = req.params;
        const clinica = await Clinica.findByPk(id_clinica, {
            include: Servicio
        });

        if (!clinica) {
            return res.status(404).send({ message: 'Clínica no encontrada' });
        }

        res.status(200).send(clinica.servicios);
    } catch (error) {
        res.status(500).send({ message: 'Error al obtener servicios de la clínica', error: error.message });
    }
};
