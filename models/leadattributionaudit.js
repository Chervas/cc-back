'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class LeadAttributionAudit extends Model {
    static associate(models) {
      LeadAttributionAudit.belongsTo(models.LeadIntake, { foreignKey: 'lead_intake_id', as: 'leadIntake' });
    }
  }

  LeadAttributionAudit.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    lead_intake_id: { type: DataTypes.INTEGER, allowNull: false },
    raw_payload: { type: DataTypes.JSON, allowNull: true },
    attribution_steps: { type: DataTypes.JSON, allowNull: true }
  }, {
    sequelize,
    modelName: 'LeadAttributionAudit',
    tableName: 'LeadAttributionAudits',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return LeadAttributionAudit;
};
