const { Servicio } = require('../../models');
const { Op } = require('sequelize');

// Obtener todos los servicios
exports.getAllServicios = async (req, res) => {
    try {
        const servicios = await Servicio.findAll();
        res.json(servicios);
    } catch (error) {
        res.status(500).send({ message: 'Error al recuperar los servicios', error: error.message });
    }
};

// Obtener servicios por ID
exports.getServicioById = async (req, res) => {
    try {
        const servicio = await Servicio.findByPk(req.params.id);
        if (!servicio) {
            return res.status(404).send({ message: 'Servicio no encontrado' });
        }
        res.json(servicio);
    } catch (error) {
        res.status(500).send({ message: 'Error al recuperar el servicio', error: error.message });
    }
};



// Crear un nuevo servicio
// Crear un nuevo servicio
exports.createServicio = async (req, res) => {
    try {
        const { nombre_servicio, descripcion_servicio, precio_servicio, iva_servicio, categoria_servicio, empresa_servicio } = req.body;

        // Validar la categoría
        const categoriasValidas = ['SEO', 'Redes Sociales', 'Gestión publicitaria', 'Inversión publicitaria', 'Desarrollo web', 'Diseño gráfico y cartelería', 'Mentoría'];
        if (!categoriasValidas.includes(categoria_servicio)) {
            return res.status(400).send({ message: 'Categoría no válida' });
        }

        const newServicio = await Servicio.create({
            nombre_servicio,
            descripcion_servicio,
            precio_servicio,
            iva_servicio,
            categoria_servicio,
            empresa_servicio
        });
        res.status(201).send(newServicio);
    } catch (error) {
        res.status(500).send({ message: 'Error al crear el servicio', error: error.message });
    }
};




// Actualizar un servicio existente
exports.updateServicio = async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre_servicio, descripcion_servicio, precio_servicio, iva_servicio, categoria_servicio, empresa_servicio } = req.body;

        // Validar la categoría
        const categoriasValidas = ['SEO', 'Redes Sociales', 'Gestión publicitaria', 'Inversión publicitaria', 'Desarrollo web', 'Diseño gráfico y cartelería', 'Mentoría'];
        if (!categoriasValidas.includes(categoria_servicio)) {
            return res.status(400).send({ message: 'Categoría no válida' });
        }

        const servicio = await Servicio.findByPk(id);
        if (!servicio) {
            return res.status(404).send({ message: 'Servicio no encontrado' });
        }

        servicio.nombre_servicio = nombre_servicio;
        servicio.descripcion_servicio = descripcion_servicio;
        servicio.precio_servicio = precio_servicio;
        servicio.iva_servicio = iva_servicio;
        servicio.categoria_servicio = categoria_servicio;
        servicio.empresa_servicio = empresa_servicio;

        await servicio.save();
        res.status(200).send(servicio);
    } catch (error) {
        res.status(500).send({ message: 'Error al actualizar el servicio', error: error.message });
    }
};

// Eliminar un servicio
exports.deleteServicio = async (req, res) => {
    try {
        const { id } = req.params;
        const servicio = await Servicio.findByPk(id);
        if (!servicio) {
            return res.status(404).send({ message: 'Servicio no encontrado' });
        }
        await servicio.destroy();
        res.send({ message: 'Servicio eliminado correctamente' });
    } catch (error) {
        res.status(500).send({ message: 'Error al eliminar el servicio', error: error.message });
    }
};

// Obtener todos los servicios con paginación
exports.getProducts = async (req, res) => {
    try {
        const { page = 0, size = 10, sort = 'nombre_servicio', order = 'asc', search = '' } = req.query;

        // Configuración de la paginación
        const limit = parseInt(size);
        const offset = parseInt(page) * limit;

        // Configuración de la ordenación
        const orderOption = [[sort, order.toUpperCase()]];

        // Configuración de la búsqueda
        const whereCondition = search ? {
            [Op.or]: [
                { nombre_servicio: { [Op.like]: `%${search}%` } },
                { descripcion_servicio: { [Op.like]: `%${search}%` } }
            ]
        } : {};

        const { count, rows } = await Servicio.findAndCountAll({
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
        res.status(500).send({ message: 'Error al recuperar los servicios', error: error.message });
    }
};
