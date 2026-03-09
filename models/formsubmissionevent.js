'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class FormSubmissionEvent extends Model {
    static associate(models) {
      if (models.LeadIntake) {
        FormSubmissionEvent.belongsTo(models.LeadIntake, {
          foreignKey: 'lead_intake_id',
          as: 'leadIntake',
        });
      }
      if (models.Clinica) {
        FormSubmissionEvent.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.GrupoClinica) {
        FormSubmissionEvent.belongsTo(models.GrupoClinica, {
          foreignKey: 'group_id',
          targetKey: 'id_grupo',
          as: 'group',
        });
      }
    }
  }

  FormSubmissionEvent.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    lead_intake_id: { type: DataTypes.INTEGER, allowNull: true },
    page_url: { type: DataTypes.STRING(1024), allowNull: true },
    form_id: { type: DataTypes.STRING(255), allowNull: true },
    form_name: { type: DataTypes.STRING(255), allowNull: true },
    form_selector: { type: DataTypes.STRING(512), allowNull: true },
    match_domain: { type: DataTypes.STRING(255), allowNull: true },
    source_detail: { type: DataTypes.STRING(128), allowNull: true },
    email_normalized: { type: DataTypes.STRING(255), allowNull: true },
    phone_normalized: { type: DataTypes.STRING(64), allowNull: true },
    fields_json: { type: DataTypes.JSON, allowNull: true },
    payload_json: { type: DataTypes.JSON, allowNull: true },
    submitted_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    sequelize,
    modelName: 'FormSubmissionEvent',
    tableName: 'FormSubmissionEvents',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return FormSubmissionEvent;
};
