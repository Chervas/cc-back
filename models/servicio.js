'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class Servicio extends Model {
        static associate(models) {
            Servicio.belongsToMany(models.Clinica, {
                through: 'clinica_servicio',
                foreignKey: 'id_servicio',
                otherKey: 'id_clinica'
            });
        }
    }
    Servicio.init({
        id_servicio: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        nombre_servicio: {
            type: DataTypes.STRING,
            allowNull: false
        },
        descripcion_servicio: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        precio_servicio: {
            type: DataTypes.FLOAT,
            allowNull: false
        },
        iva_servicio: {
            type: DataTypes.FLOAT,
            allowNull: false
        },
        categoria_servicio: {
            type: DataTypes.ENUM,
            values: ['SEO', 'Redes Sociales', 'Gestión publicitaria', 'Inversión publicitaria', 'Desarrollo web', 'Diseño gráfico y cartelería', 'Mentoría'],
            allowNull: false
        },
        empresa_servicio: {
            type: DataTypes.ENUM,
            values: ['La voz medios digitales SL', 'Parallel Campaign OU'],
            allowNull: false
        }
    }, {
        sequelize,
        modelName: 'Servicio',
        tableName: 'Servicios',
        timestamps: false
    });
    return Servicio;
};
