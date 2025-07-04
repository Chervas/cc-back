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
  }, {
    sequelize,
    modelName: 'GrupoClinica',
    tableName: 'GruposClinicas',
    timestamps: false,
  });
  return GrupoClinica;
};
