'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class GrupoClinica extends Model {
    static associate(models) {
      // Un grupo puede tener muchas clínicas
      GrupoClinica.hasMany(models.Clinica, { foreignKey: 'grupoClinicaId', as: 'clinicas' });
    }
  }
  GrupoClinica.init({
    id_grupo: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre_grupo: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    ads_assignment_mode: {
      type: DataTypes.ENUM('manual', 'automatic'),
      allowNull: false,
      defaultValue: 'automatic'
    },
    ads_assignment_delimiter: {
      type: DataTypes.STRING(8),
      allowNull: false,
      defaultValue: '**'
    },
    ads_assignment_last_run: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    web_assignment_mode: {
      type: DataTypes.ENUM('manual', 'automatic'),
      allowNull: false,
      defaultValue: 'automatic'
    },
    web_primary_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    web_assignment_updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    }
  }, {
    sequelize,
    modelName: 'GrupoClinica',
    tableName: 'GruposClinicas',
    timestamps: false,
  });
  return GrupoClinica;
};
