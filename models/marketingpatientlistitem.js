'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingPatientListItem extends Model {
    static associate(models) {
      MarketingPatientListItem.belongsTo(models.MarketingPatientList, { foreignKey: 'list_id', as: 'list' });
      MarketingPatientListItem.belongsTo(models.Paciente, { foreignKey: 'paciente_id', targetKey: 'id_paciente', as: 'paciente' });
      MarketingPatientListItem.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      MarketingPatientListItem.belongsTo(models.Tratamiento, { foreignKey: 'treatment_id', targetKey: 'id_tratamiento', as: 'tratamiento' });
      if (models.MarketingPatientContactEvent) {
        MarketingPatientListItem.hasMany(models.MarketingPatientContactEvent, { foreignKey: 'item_id', as: 'events' });
      }
    }
  }

  MarketingPatientListItem.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    list_id: { type: DataTypes.INTEGER, allowNull: false },
    paciente_id: { type: DataTypes.INTEGER, allowNull: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    phone: { type: DataTypes.STRING(64), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: true },
    treatment: { type: DataTypes.STRING(255), allowNull: true },
    treatment_id: { type: DataTypes.INTEGER, allowNull: true },
    last_visit_at: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'ready' },
    reason: { type: DataTypes.STRING(512), allowNull: true },
    exclusion_reason: { type: DataTypes.STRING(64), allowNull: true },
    selected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    custom_fields: { type: DataTypes.JSON, allowNull: true },
    missing_variables: { type: DataTypes.JSON, allowNull: true },
    appointment_at: { type: DataTypes.DATE, allowNull: true },
    treatment_completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
  }, {
    sequelize,
    modelName: 'MarketingPatientListItem',
    tableName: 'MarketingPatientListItems',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return MarketingPatientListItem;
};
