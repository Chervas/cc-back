const { ClinicaServicio, Clinica, Servicio, HistorialDeServicios } = require('../../models');
const { Op } = require('sequelize');

// Obtener todos los servicios asignados
exports.getAllClinicaServicios = async (req, res) => {
    try {
        const clinicaServicios = await ClinicaServicio.findAll();
        res.json(clinicaServicios);
    } catch (error) {
        res.status(500).send({ message: 'Error al recuperar los servicios asignados', error: error.message });
    }
};

// Obtener servicios asignados con paginación
exports.getProducts = async (req, res) => {
    try {
        const { page = 0, size = 1000, sort = 'nombre_servicio', order = 'asc', search = '', startDate, endDate } = req.query;

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

        // Añadir condiciones de fecha si están presentes
        if (startDate && endDate) {
            whereCondition.fecha_cobro = {
                [Op.between]: [startDate, endDate]
            };
        }

        const { count, rows } = await ClinicaServicio.findAndCountAll({
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
        res.status(500).send({ message: 'Error al recuperar los servicios asignados', error: error.message });
    }
};

// Obtener servicio asignado por ID
exports.getClinicaServicioById = async (req, res) => {
    try {
        const clinicaServicio = await ClinicaServicio.findByPk(req.params.id);
        if (!clinicaServicio) {
            return res.status(404).send({ message: 'Servicio asignado no encontrado' });
        }
        res.json(clinicaServicio);
    } catch (error) {
        res.status(500).send({ message: 'Error al recuperar el servicio asignado', error: error.message });
    }
};


exports.createClinicaServicio = async (req, res) => {
    try {
        const {
            id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_servicio,
            descripcion_detallada_servicio, precio_servicio, iva_servicio, servicio_recurrente,
            fecha_cobro, precio_especial, empresa_servicio, estado_servicio, fecha_pausa, datos_fiscales_clinica
        } = req.body;

        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(400).send({ message: 'Clínica o servicio no encontrado' });
        }

        const newClinicaServicio = {
            id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_servicio,
            descripcion_detallada_servicio, precio_servicio, iva_servicio, servicio_recurrente,
            fecha_cobro, precio_especial, empresa_servicio, estado_servicio, fecha_pausa, datos_fiscales_clinica,
            num_factura_asociada: '',  // Asegurarse de incluir este campo para historial_de_servicios
            incluir_en_factura: false  // o cualquier valor por defecto necesario
        };

        await ClinicaServicio.create(newClinicaServicio);  // Siempre crear en ClinicaServicio

        res.status(201).send(newClinicaServicio);
    } catch (error) {
        res.status(500).send({ message: 'Error al crear el servicio asignado', error: error.message });
    }
};







// Actualizar un servicio asignado existente
exports.updateClinicaServicio = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_servicio,
            descripcion_detallada_servicio, precio_servicio, iva_servicio, servicio_recurrente,
            fecha_cobro, precio_especial, empresa_servicio, estado_servicio, fecha_pausa, datos_fiscales_clinica
        } = req.body;

        console.log('Datos recibidos para actualizar:', req.body);

        const clinicaServicio = await ClinicaServicio.findByPk(id);
        if (!clinicaServicio) {
            return res.status(404).send({ message: 'Servicio asignado no encontrado' });
        }

        // Verificar que la clínica y el servicio existen
        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(400).send({ message: 'Clínica o servicio no encontrado' });
        }

        clinicaServicio.set({
            id_clinica, nombre_clinica, id_servicio, nombre_servicio, descripcion_servicio,
            descripcion_detallada_servicio, precio_servicio, iva_servicio, servicio_recurrente,
            fecha_cobro, precio_especial, empresa_servicio, estado_servicio, fecha_pausa, datos_fiscales_clinica
        });

        await clinicaServicio.save();
        res.status(200).send(clinicaServicio);
    } catch (error) {
        console.error('Error al actualizar el servicio asignado:', error);
        res.status(500).send({ message: 'Error al actualizar el servicio asignado', error: error.message });
    }
};

// Eliminar un servicio asignado
exports.deleteClinicaServicio = async (req, res) => {
    try {
        const { id } = req.params;
        const clinicaServicio = await ClinicaServicio.findByPk(id);
        if (!clinicaServicio) {
            return res.status(404).send({ message: 'Servicio asignado no encontrado' });
        }
        await clinicaServicio.destroy();
        res.send({ message: 'Servicio asignado eliminado correctamente' });
    } catch (error) {
        res.status(500).send({ message: 'Error al eliminar el servicio asignado', error: error.message });
    }
};

// Cerrar mes
exports.closeMonth = async (req, res) => {
    try {
        const { month, year } = req.body;
        const startDate = new Date(year, month, 1);
        const endDate = new Date(year, month + 1, 0);

        await ClinicaServicio.update(
            { mes_cerrado: true },
            {
                where: {
                    fecha_cobro: {
                        [Op.between]: [startDate, endDate]
                    }
                }
            }
        );

        res.status(200).send({ message: 'Mes cerrado correctamente' });
    } catch (error) {
        res.status(500).send({ message: 'Error al cerrar el mes', error: error.message });
    }
};

exports.isMonthClosed = async (req, res) => {
    console.log("isMonthClosed endpoint reached");  // Log para verificar que se llega al controlador
    try {
        const { monthName } = req.query;
        console.log("Received monthName:", monthName);  // Log para verificar que se recibe el parámetro

        // Verificar si monthName es undefined o null
        if (!monthName || monthName === 'Invalid Date') {
            console.log("monthName is missing or invalid");
            return res.status(400).send({ message: 'Invalid monthName' });
        }

        // Mapeo de nombres de meses en español a índices de meses
        const monthMapEs = {
            "enero": 0,
            "febrero": 1,
            "marzo": 2,
            "abril": 3,
            "mayo": 4,
            "junio": 5,
            "julio": 6,
            "agosto": 7,
            "septiembre": 8,
            "octubre": 9,
            "noviembre": 10,
            "diciembre": 11
        };

        // Mapeo de nombres de meses en inglés a índices de meses
        const monthMapEn = {
            "january": 0,
            "february": 1,
            "march": 2,
            "april": 3,
            "may": 4,
            "june": 5,
            "july": 6,
            "august": 7,
            "september": 8,
            "october": 9,
            "november": 10,
            "december": 11
        };

        let monthIndex = monthMapEs[monthName.toLowerCase()];
        if (monthIndex === undefined) {
            monthIndex = monthMapEn[monthName.toLowerCase()];
        }

        if (monthIndex === undefined) {
            console.log("monthName is invalid");
            return res.status(400).send({ message: 'Invalid monthName' });
        }

        const currentYear = new Date().getFullYear();

        const startDate = new Date(currentYear, monthIndex, 1);
        const endDate = new Date(currentYear, monthIndex + 1, 0);

        console.log("Querying for dates between:", startDate, "and", endDate);  // Log para verificar las fechas

        const isClosed = await ClinicaServicio.findOne({
            where: {
                fecha_cobro: {
                    [Op.between]: [startDate, endDate]
                },
                mes_cerrado: true
            }
        });

        console.log("Query result:", isClosed);  // Log para verificar el resultado de la consulta
        res.json(isClosed !== null);
    } catch (error) {
        console.error('Error in isMonthClosed:', error);  // Log para verificar cualquier error
        res.status(500).send({ message: 'Error al verificar el estado del mes', error: error.message });
    }
};



exports.getMonthSummary = async (req, res) => {
    try {
        const { month, year } = req.query;

        if (!month || !year) {
            return res.status(400).send({ message: 'Month and year are required' });
        }

        const startDate = new Date(year, month, 1);
        const endDate = new Date(year, parseInt(month) + 1, 0);

        const total = await ClinicaServicio.sum('precio_servicio', {
            where: {
                fecha_cobro: {
                    [Op.between]: [startDate, endDate]
                },
                estado_servicio: 'activo'
            }
        });

        const totalIVA = await ClinicaServicio.sum('iva_servicio', {
            where: {
                fecha_cobro: {
                    [Op.between]: [startDate, endDate]
                },
                estado_servicio: 'activo'
            }
        });

        const pausedServicesTotal = await ClinicaServicio.sum('precio_servicio', {
            where: {
                fecha_cobro: {
                    [Op.between]: [startDate, endDate]
                },
                estado_servicio: 'pausado'
            }
        });

        const pausedServicesCount = await ClinicaServicio.count({
            where: {
                fecha_cobro: {
                    [Op.between]: [startDate, endDate]
                },
                estado_servicio: 'pausado'
            }
        });

        const clinicsCount = await ClinicaServicio.count({
            where: {
                fecha_cobro: {
                    [Op.between]: [startDate, endDate]
                },
                estado_servicio: 'activo'
            }
        });

        res.json({ 
            total, 
            totalIVA, 
            pausedServicesTotal, 
            pausedServicesCount, 
            clinicsCount 
        });
    } catch (error) {
        console.error('Error in getMonthSummary:', error);
        res.status(500).send({ message: 'Error al obtener el resumen del mes', error: error.message });
    }
};











