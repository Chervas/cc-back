'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class InstalacionHorario extends Model {
    static associate(models) {
      InstalacionHorario.belongsTo(models.Instalacion, { foreignKey: 'instalacion_id', as: 'instalacion' });
    }
  }
  InstalacionHorario.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    instalacion_id: { type: DataTypes.INTEGER, allowNull: false },
    dia_semana: { type: DataTypes.INTEGER, allowNull: false },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true },
    hora_inicio: { type: DataTypes.STRING(5), allowNull: false },
    hora_fin: { type: DataTypes.STRING(5), allowNull: false }
  }, {
    sequelize,
    modelName: 'InstalacionHorario',
    tableName: 'InstalacionHorarios',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
  return InstalacionHorario;
};
