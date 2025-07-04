const { HistorialDeServicios, Clinica, Servicio } = require('../../models');
const { Op } = require('sequelize');

exports.getAllHistorialDeServicios = async (req, res) => {
    console.log('Ejecutando getAllHistorialDeServicios');
    try {
        const historialDeServicios = await HistorialDeServicios.findAll();
        res.json(historialDeServicios);
    } catch (error) {
        console.error('Error en getAllHistorialDeServicios:', error);
        res.status(500).send({ message: 'Error al recuperar los servicios históricos', error: error.message });
    }
};

// Obtener servicios históricos con paginación
exports.getProducts = async (req, res) => {
    try {
        const { page = 0, size = 10, sort = 'id_servicio_asignado', order = 'desc', search = '' } = req.query;

        // Configuración de la paginación
        const limit = parseInt(size);
        const offset = parseInt(page) * limit;

        // Configuración de la ordenación
        const orderOption = [[sort, order.toUpperCase()]];

        // Configuración de la búsqueda
        const whereCondition = search ? {
            [Op.or]: [
                { nombre_clinica: { [Op.like]: `%${search}%` } },
                { nombre_servicio: { [Op.like]: `%${search}%` } }
            ]
        } : {};

        const { count, rows } = await HistorialDeServicios.findAndCountAll({
            where: whereCondition,
            order: orderOption,
            limit,
            offset
        });

        res.json({
            pagination: {
                length: count,
                size: limit,
                page: parseInt(page),
                lastPage: Math.ceil(count / limit) - 1,
                startIndex: offset,
                endIndex: offset + rows.length - 1
            },
            products: rows
        });
    } catch (error) {
        res.status(500).send({ message: 'Error al recuperar los servicios históricos', error: error.message });
    }
};





exports.getHistorialDeServiciosById = async (req, res) => {
    console.log('Ejecutando getHistorialDeServiciosById');
    try {
        const historialDeServicios = await HistorialDeServicios.findByPk(req.params.id, {
            include: [{
                model: Servicio,
                as: 'servicio', // Asegúrate de que el alias coincida con el definido en la asociación
                attributes: ['id_servicio', 'nombre_servicio', 'descripcion_servicio']
            }]
        });
        if (!historialDeServicios) {
            return res.status(404).send({ message: 'Servicio histórico no encontrado' });
        }
        res.json(historialDeServicios);
    } catch (error) {
        console.error('Error en getHistorialDeServiciosById:', error);
        res.status(500).send({ message: 'Error al recuperar el servicio histórico', error: error.message });
    }
};




// controllers/historialdeservicios.controller.js

// controllers/historialdeservicios.controller.js

exports.createHistorialDeServicios = async (req, res) => {
    console.log('Ejecutando createHistorialDeServicios');
    console.log('Datos recibidos:', req.body);
    try {
        const {
            fecha_cobro, id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_detallada_servicio,
            descripcion_servicio, servicio_recurrente, precio_servicio, iva_servicio, num_factura_asociada = '', empresa_servicio, incluir_en_factura, datos_fiscales_clinica
        } = req.body;

        console.log('Valores recibidos después de destructurar:', {
            fecha_cobro, id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_detallada_servicio,
            descripcion_servicio, servicio_recurrente, precio_servicio, iva_servicio, num_factura_asociada, empresa_servicio, incluir_en_factura, datos_fiscales_clinica
        });

        if (!fecha_cobro) {
            console.error('fecha_cobro es requerido');
            return res.status(400).send({ message: 'fecha_cobro es requerido' });
        }

        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(400).send({ message: 'Clínica o servicio no encontrado' });
        }

        const newHistorialDeServicios = await HistorialDeServicios.create({
            fecha_cobro, 
            id_clinica,
            nombre_clinica,
            id_servicio,
            nombre_servicio,
            descripcion_detallada_servicio,
            descripcion_servicio, 
            servicio_recurrente,
            precio_servicio,
            iva_servicio,
            num_factura_asociada,
            empresa_servicio,
            incluir_en_factura,
            datos_fiscales_clinica
        });

        res.status(201).send(newHistorialDeServicios);
    } catch (error) {
        console.error('Error en createHistorialDeServicios:', error);
        res.status(500).send({ message: 'Error al crear el servicio histórico', error: error.message });
    }
};




exports.updateHistorialDeServicios = async (req, res) => {
    console.log('Ejecutando updateHistorialDeServicios');
    try {
        const { id } = req.params;
        const {
            fecha_cobro, id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_detallada_servicio,
            descripcion_servicio, servicio_recurrente, precio_servicio, iva_servicio, num_factura_asociada, empresa_servicio, incluir_en_factura, datos_fiscales_clinica
        } = req.body;

        console.log('Datos recibidos para actualizar:', req.body);

        const historialDeServicios = await HistorialDeServicios.findByPk(id);
        if (!historialDeServicios) {
            return res.status(404).send({ message: 'Servicio histórico no encontrado' });
        }

        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(400).send({ message: 'Clínica o servicio no encontrado' });
        }

        historialDeServicios.set({
            fecha_cobro, id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_detallada_servicio,
            descripcion_servicio, servicio_recurrente, precio_servicio, iva_servicio, num_factura_asociada, empresa_servicio, incluir_en_factura, datos_fiscales_clinica
        });

        await historialDeServicios.save();
        res.status(200).send(historialDeServicios);
    } catch (error) {
        console.error('Error en updateHistorialDeServicios:', error);
        res.status(500).send({ message: 'Error al actualizar el servicio histórico', error: error.message });
    }
};


exports.deleteHistorialDeServicios = async (req, res) => {
    console.log('Ejecutando deleteHistorialDeServicios');
    try {
        const { id } = req.params;
        const historialDeServicios = await HistorialDeServicios.findByPk(id);
        if (!historialDeServicios) {
            return res.status(404).send({ message: 'Servicio histórico no encontrado' });
        }
        await historialDeServicios.destroy();
        res.send({ message: 'Servicio histórico eliminado correctamente' });
    } catch (error) {
        console.error('Error en deleteHistorialDeServicios:', error);
        res.status(500).send({ message: 'Error al eliminar el servicio histórico', error: error.message });
    }
};

exports.duplicateHistorialDeServicios = async (req, res) => {
    console.log('Ejecutando duplicateHistorialDeServicios');
    console.log('Datos recibidos:', req.body);
    try {
        const {
            fecha_cobro, id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_detallada_servicio,
            descripcion_servicio, servicio_recurrente, precio_servicio, iva_servicio, num_factura_asociada = '', empresa_servicio, incluir_en_factura, datos_fiscales_clinica
        } = req.body;

        console.log('Valores recibidos después de destructurar:', {
            fecha_cobro, id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_detallada_servicio,
            descripcion_servicio, servicio_recurrente, precio_servicio, iva_servicio, num_factura_asociada, empresa_servicio, incluir_en_factura, datos_fiscales_clinica
        });

        if (!fecha_cobro) {
            console.error('fecha_cobro es requerido');
            return res.status(400).send({ message: 'fecha_cobro es requerido' });
        }

        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(400).send({ message: 'Clínica o servicio no encontrado' });
        }

        const duplicatedHistorialDeServicios = await HistorialDeServicios.create({
            fecha_cobro,  // Asegúrate de usar fecha_cobro
            id_clinica,
            nombre_clinica,
            id_servicio,
            nombre_servicio,
            descripcion_detallada_servicio,
            descripcion_servicio, // Añadido
            servicio_recurrente,
            precio_servicio,
            iva_servicio,
            num_factura_asociada,
            empresa_servicio,
            incluir_en_factura,
            datos_fiscales_clinica
        });

        res.status(201).send(duplicatedHistorialDeServicios);
    } catch (error) {
        console.error('Error en duplicateHistorialDeServicios:', error);
        res.status(500).send({ message: 'Error al duplicar el servicio histórico', error: error.message });
    }
};