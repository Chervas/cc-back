'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ClinicaServicio extends Model {
    static associate(models) {
      ClinicaServicio.belongsTo(models.Clinica, { foreignKey: 'id_clinica' });
      ClinicaServicio.belongsTo(models.Servicio, { foreignKey: 'id_servicio' });
    }
  }
  ClinicaServicio.init({
    id_servicio_asignado: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    id_clinica: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      }
    },
    nombre_clinica: {
      type: DataTypes.STRING,
      allowNull: false
    },
    id_servicio: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Servicios',
        key: 'id_servicio'
      }
    },
    nombre_servicio: {
      type: DataTypes.STRING,
      allowNull: false
    },
    descripcion_servicio: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    descripcion_detallada_servicio: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    precio_servicio: {
      type: DataTypes.FLOAT,
      allowNull: false
    },
    iva_servicio: {
      type: DataTypes.FLOAT,
      allowNull: false
    },
    servicio_recurrente: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    fecha_cobro: {
      type: DataTypes.DATE,
      allowNull: true
    },
    precio_especial: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    empresa_servicio: {
      type: DataTypes.STRING,
      allowNull: false
    },
    estado_servicio: {
      type: DataTypes.ENUM('activo', 'pausa', 'pausado hasta fecha'),
      allowNull: false
    },    
    fecha_pausa: {
      type: DataTypes.DATE,
      allowNull: true
    },
    datos_fiscales_clinica: {
      type: DataTypes.JSON,
      allowNull: true
    },
    mes_cerrado: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  }, {
    sequelize,
    modelName: 'ClinicaServicio',
    tableName: 'ClinicaServicio',
    timestamps: false
  });
  return ClinicaServicio;
};
