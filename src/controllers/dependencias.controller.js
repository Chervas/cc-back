'use strict';
const asyncHandler = require('express-async-handler');
const db = require('../../models');

const DependenciaTratamiento = db.DependenciaTratamiento;
const Tratamiento = db.Tratamiento;

// Listar dependencias de un tratamiento
exports.getDependencias = asyncHandler(async (req, res) => {
    const { id_tratamiento } = req.params;

    const dependencias = await DependenciaTratamiento.findAll({
        where: { id_tratamiento_origen: id_tratamiento },
        include: [
            { model: Tratamiento, as: 'destino', attributes: ['id_tratamiento', 'codigo', 'nombre'] }
        ]
    });
    res.json(dependencias);
});

// Crear dependencia
exports.createDependencia = asyncHandler(async (req, res) => {
    const { id_tratamiento_origen, id_tratamiento_destino, tipo = 'obligatoria', dias_espera = 0, notas } = req.body;

    if (!id_tratamiento_origen || !id_tratamiento_destino) {
        return res.status(400).json({ message: 'id_tratamiento_origen e id_tratamiento_destino son obligatorios' });
    }
    if (id_tratamiento_origen === id_tratamiento_destino) {
        return res.status(400).json({ message: 'Un tratamiento no puede depender de sí mismo' });
    }

    const dependencia = await DependenciaTratamiento.create({
        id_tratamiento_origen,
        id_tratamiento_destino,
        tipo,
        dias_espera,
        notas
    });
    res.status(201).json(dependencia);
});

// Actualizar dependencia
exports.updateDependencia = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const dependencia = await DependenciaTratamiento.findByPk(id);
    if (!dependencia) return res.status(404).json({ message: 'Dependencia no encontrada' });

    const { tipo, dias_espera, notas } = req.body;
    if (tipo !== undefined) dependencia.tipo = tipo;
    if (dias_espera !== undefined) dependencia.dias_espera = dias_espera;
    if (notas !== undefined) dependencia.notas = notas;
    await dependencia.save();
    res.json(dependencia);
});

// Eliminar dependencia
exports.deleteDependencia = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const dependencia = await DependenciaTratamiento.findByPk(id);
    if (!dependencia) return res.status(404).json({ message: 'Dependencia no encontrada' });

    await dependencia.destroy();
    res.json({ message: 'Dependencia eliminada' });
});
