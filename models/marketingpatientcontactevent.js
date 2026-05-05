'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingPatientContactEvent extends Model {
    static associate(models) {
      MarketingPatientContactEvent.belongsTo(models.MarketingPatientList, { foreignKey: 'list_id', as: 'list' });
      MarketingPatientContactEvent.belongsTo(models.MarketingPatientListItem, { foreignKey: 'item_id', as: 'item' });
      MarketingPatientContactEvent.belongsTo(models.Paciente, { foreignKey: 'paciente_id', targetKey: 'id_paciente', as: 'paciente' });
    }
  }

  MarketingPatientContactEvent.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    list_id: { type: DataTypes.INTEGER, allowNull: false },
    item_id: { type: DataTypes.INTEGER, allowNull: true },
    paciente_id: { type: DataTypes.INTEGER, allowNull: true },
    event_type: { type: DataTypes.STRING(64), allowNull: false },
    channel: { type: DataTypes.STRING(32), allowNull: true },
    payload: { type: DataTypes.JSON, allowNull: true },
    occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'MarketingPatientContactEvent',
    tableName: 'MarketingPatientContactEvents',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  return MarketingPatientContactEvent;
};
