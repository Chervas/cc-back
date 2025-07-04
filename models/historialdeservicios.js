// models/historialdeservicios.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class HistorialDeServicios extends Model {
    static associate(models) {
      this.belongsTo(models.Servicio, {
        foreignKey: 'id_servicio',
        as: 'servicio'
      });
    }
  }

  HistorialDeServicios.init({
    id_servicio_asignado: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    fecha_cobro: {  // Cambiado a fecha_cobro
      type: DataTypes.DATE,
      allowNull: false
    },
    id_clinica: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    nombre_clinica: {
      type: DataTypes.STRING,
      allowNull: false
    },
    nombre_servicio: {
      type: DataTypes.STRING,
      allowNull: false
    },
    descripcion_detallada_servicio: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    descripcion_servicio: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    servicio_recurrente: {
      type: DataTypes.BOOLEAN,
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
    num_factura_asociada: {
      type: DataTypes.STRING,
      allowNull: true
    },
    empresa_servicio: {
      type: DataTypes.STRING,
      allowNull: false
    },
    datos_fiscales_clinica: {
      type: DataTypes.JSON,
      allowNull: false
    },
    id_servicio: {
      type: DataTypes.INTEGER,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'HistorialDeServicios',
    tableName: 'HistorialDeServicios',
    timestamps: false
  });

  return HistorialDeServicios;
};
