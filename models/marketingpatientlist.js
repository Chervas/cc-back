'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingPatientList extends Model {
    static associate(models) {
      MarketingPatientList.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      MarketingPatientList.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
      if (models.MessageTemplate) {
        MarketingPatientList.belongsTo(models.MessageTemplate, { foreignKey: 'template_id', as: 'template' });
      }
      if (models.MarketingPatientListItem) {
        MarketingPatientList.hasMany(models.MarketingPatientListItem, { foreignKey: 'list_id', as: 'items' });
      }
      if (models.MarketingPatientContactEvent) {
        MarketingPatientList.hasMany(models.MarketingPatientContactEvent, { foreignKey: 'list_id', as: 'events' });
      }
    }
  }

  MarketingPatientList.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    objective_id: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'reactivate_patients' },
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'clinical_inactive' },
    status: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'draft' },
    scope_type: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'clinic' },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_ids: { type: DataTypes.JSON, allowNull: true },
    treatment: { type: DataTypes.STRING(255), allowNull: true },
    condition_summary: { type: DataTypes.TEXT, allowNull: true },
    exclusion_summary: { type: DataTypes.TEXT, allowNull: true },
    criteria: { type: DataTypes.JSON, allowNull: true },
    action_mode: { type: DataTypes.STRING(64), allowNull: true },
    channel: { type: DataTypes.STRING(32), allowNull: true },
    template_id: { type: DataTypes.INTEGER, allowNull: true },
    template_snapshot: { type: DataTypes.JSON, allowNull: true },
    counters: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    metrics: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    automation: { type: DataTypes.JSON, allowNull: true },
    safety_gates: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    custom_fields_schema: { type: DataTypes.JSON, allowNull: true },
    prepared_at: { type: DataTypes.DATE, allowNull: true },
    last_sent_at: { type: DataTypes.DATE, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'MarketingPatientList',
    tableName: 'MarketingPatientLists',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return MarketingPatientList;
};
