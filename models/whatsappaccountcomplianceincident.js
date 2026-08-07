'use strict';

module.exports = (sequelize, DataTypes) => {
  const WhatsappAccountComplianceIncident = sequelize.define('WhatsappAccountComplianceIncident', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    dedupe_key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    asset_id: { type: DataTypes.INTEGER, allowNull: true },
    waba_id: { type: DataTypes.STRING(255), allowNull: true },
    phone_number_id: { type: DataTypes.STRING(255), allowNull: true },
    phone_number: { type: DataTypes.STRING(64), allowNull: true },
    webhook_field: { type: DataTypes.STRING(96), allowNull: false, defaultValue: 'account_update' },
    provider_event: { type: DataTypes.STRING(96), allowNull: false },
    severity: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'warning' },
    operational_status: { type: DataTypes.STRING(64), allowNull: false },
    violation_type: { type: DataTypes.STRING(96), allowNull: true },
    ban_state: { type: DataTypes.STRING(64), allowNull: true },
    ban_date: { type: DataTypes.DATE, allowNull: true },
    restriction_info: { type: DataTypes.JSON, allowNull: true },
    remediation: { type: DataTypes.TEXT, allowNull: true },
    raw_payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    status: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'open' },
    appealable: { type: DataTypes.BOOLEAN, allowNull: true },
    client_requested_at: { type: DataTypes.DATE, allowNull: true },
    client_requested_by: { type: DataTypes.INTEGER, allowNull: true },
    appeal_draft: { type: DataTypes.TEXT, allowNull: true },
    appeal_context: { type: DataTypes.JSON, allowNull: true },
    appeal_prepared_at: { type: DataTypes.DATE, allowNull: true },
    appeal_prepared_by: { type: DataTypes.INTEGER, allowNull: true },
    appeal_submitted_at: { type: DataTypes.DATE, allowNull: true },
    appeal_submitted_by: { type: DataTypes.INTEGER, allowNull: true },
    provider_resolution: { type: DataTypes.STRING(96), allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'WhatsappAccountComplianceIncidents',
    underscored: true,
    timestamps: true,
  });

  WhatsappAccountComplianceIncident.associate = function(models) {
    WhatsappAccountComplianceIncident.belongsTo(models.Clinica, {
      foreignKey: 'clinic_id',
      targetKey: 'id_clinica',
      as: 'clinic',
    });
    WhatsappAccountComplianceIncident.belongsTo(models.GrupoClinica, {
      foreignKey: 'group_id',
      targetKey: 'id_grupo',
      as: 'group',
    });
    WhatsappAccountComplianceIncident.belongsTo(models.ClinicMetaAsset, {
      foreignKey: 'asset_id',
      targetKey: 'id',
      as: 'asset',
    });
  };

  return WhatsappAccountComplianceIncident;
};
