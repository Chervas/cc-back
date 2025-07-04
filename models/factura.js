// models/factura.js
'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Factura extends Model {
    static associate(models) {
      // asociaciones si es necesario
    }
  }
  Factura.init({
    id_factura: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    num_factura: {
      type: DataTypes.STRING,
      allowNull: false
    },
    contenido_factura: {
      type: DataTypes.JSON,
      allowNull: false
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
    base_imponible_total: {
      type: DataTypes.FLOAT,
      allowNull: false
    },
    impuestos_total: {
      type: DataTypes.FLOAT,
      allowNull: false
    },
    precio_con_impuestos_total: {
      type: DataTypes.FLOAT,
      allowNull: false
    },
    factura_enviada: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    factura_enviada_fecha: {
      type: DataTypes.DATE,
      allowNull: true
    },
    factura_conciliada: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    factura_conciliada_fecha: {
      type: DataTypes.DATE,
      allowNull: true
    },
    factura_cobrada: {
      type: DataTypes.BOOLEAN,
      allowNull: false
    },
    factura_cobrada_fecha: {
      type: DataTypes.DATE,
      allowNull: true
    },
    denominacion_social: {
      type: DataTypes.STRING,
      allowNull: false
    },
    incluida_remesa: {
      type: DataTypes.INTEGER,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'Factura',
    tableName: 'Facturas',
    timestamps: false
  });
  return Factura;
};
