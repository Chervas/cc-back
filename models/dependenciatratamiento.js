'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class DependenciaTratamiento extends Model {
    static associate(models) {
      if (models.Tratamiento) {
        DependenciaTratamiento.belongsTo(models.Tratamiento, { foreignKey: 'id_tratamiento_origen', as: 'origen' });
        DependenciaTratamiento.belongsTo(models.Tratamiento, { foreignKey: 'id_tratamiento_destino', as: 'destino' });
      }
    }
  }
  DependenciaTratamiento.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    id_tratamiento_origen: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    id_tratamiento_destino: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    tipo: {
      type: DataTypes.ENUM('obligatoria', 'recomendada'),
      allowNull: false,
      defaultValue: 'obligatoria'
    },
    dias_espera: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    notas: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'DependenciaTratamiento',
    tableName: 'DependenciaTratamiento',
    timestamps: true
  });
  return DependenciaTratamiento;
};
