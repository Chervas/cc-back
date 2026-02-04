'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class InstalacionBloqueo extends Model {
    static associate(models) {
      InstalacionBloqueo.belongsTo(models.Instalacion, { foreignKey: 'instalacion_id', as: 'instalacion' });
    }
  }
  InstalacionBloqueo.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    instalacion_id: { type: DataTypes.INTEGER, allowNull: false },
    fecha_inicio: { type: DataTypes.DATE, allowNull: false },
    fecha_fin: { type: DataTypes.DATE, allowNull: false },
    motivo: DataTypes.STRING(255),
    recurrente: { type: DataTypes.ENUM('none','daily','weekly','monthly'), defaultValue: 'none' },
    creado_por: DataTypes.INTEGER
  }, {
    sequelize,
    modelName: 'InstalacionBloqueo',
    tableName: 'InstalacionBloqueos',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
  return InstalacionBloqueo;
};
