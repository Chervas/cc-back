'use strict';

module.exports = (sequelize, DataTypes) => {
  const GoogleAdsConversionUploadAttempt = sequelize.define('GoogleAdsConversionUploadAttempt', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    dedupeKey: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'dedupe_key' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    intakeConfigId: { type: DataTypes.INTEGER, allowNull: true, field: 'intake_config_id' },
    googleConnectionId: { type: DataTypes.INTEGER, allowNull: true, field: 'google_connection_id' },
    googleConnectionAssignmentId: { type: DataTypes.INTEGER, allowNull: true, field: 'google_connection_assignment_id' },
    assignmentScope: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, field: 'assignment_scope' },
    destinationKey: { type: DataTypes.STRING(128), allowNull: true, field: 'destination_key' },
    connectionSource: { type: DataTypes.STRING(64), allowNull: true, field: 'connection_source' },
    customerId: { type: DataTypes.STRING(32), allowNull: true, field: 'customer_id' },
    loginCustomerId: { type: DataTypes.STRING(32), allowNull: true, field: 'login_customer_id' },
    conversionAction: { type: DataTypes.STRING(256), allowNull: true, field: 'conversion_action' },
    eventName: { type: DataTypes.STRING(64), allowNull: false, field: 'event_name' },
    eventId: { type: DataTypes.STRING(191), allowNull: true, field: 'event_id' },
    clickIdType: { type: DataTypes.ENUM('gclid', 'gbraid', 'wbraid'), allowNull: false, field: 'click_id_type' },
    clickIdHash: { type: DataTypes.STRING(64), allowNull: false, field: 'click_id_hash' },
    consentStatus: {
      type: DataTypes.ENUM('GRANTED', 'DENIED', 'UNSPECIFIED'),
      allowNull: false,
      defaultValue: 'UNSPECIFIED',
      field: 'consent_status'
    },
    status: { type: DataTypes.ENUM('pending', 'succeeded', 'failed', 'skipped'), allowNull: false, defaultValue: 'pending' },
    reason: { type: DataTypes.STRING(128), allowNull: true },
    providerRequestId: { type: DataTypes.STRING(191), allowNull: true, field: 'provider_request_id' },
    attemptCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1, field: 'attempt_count' },
    requestMetadata: { type: DataTypes.JSON, allowNull: true, field: 'request_metadata' },
    responseMetadata: { type: DataTypes.JSON, allowNull: true, field: 'response_metadata' },
    history: { type: DataTypes.JSON, allowNull: true },
    lastErrorCode: { type: DataTypes.STRING(128), allowNull: true, field: 'last_error_code' },
    lastErrorMessage: { type: DataTypes.TEXT, allowNull: true, field: 'last_error_message' },
    attemptedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'attempted_at' },
    completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' }
  }, {
    tableName: 'GoogleAdsConversionUploadAttempts',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['dedupe_key'] },
      { fields: ['clinica_id', 'attempted_at'] },
      { fields: ['grupo_clinica_id', 'attempted_at'] },
      { fields: ['customer_id', 'status', 'attempted_at'] },
      { fields: ['destination_key', 'status', 'attempted_at'] },
      { fields: ['event_id'] }
    ]
  });

  GoogleAdsConversionUploadAttempt.associate = function associate(models) {
    GoogleAdsConversionUploadAttempt.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    GoogleAdsConversionUploadAttempt.belongsTo(models.GrupoClinica, { foreignKey: 'grupoClinicaId', targetKey: 'id_grupo', as: 'grupoClinica' });
    GoogleAdsConversionUploadAttempt.belongsTo(models.IntakeConfig, { foreignKey: 'intakeConfigId', as: 'intakeConfig' });
    GoogleAdsConversionUploadAttempt.belongsTo(models.GoogleConnection, { foreignKey: 'googleConnectionId', as: 'googleConnection' });
    GoogleAdsConversionUploadAttempt.belongsTo(models.GoogleConnectionAssignment, {
      foreignKey: 'googleConnectionAssignmentId',
      as: 'googleConnectionAssignment'
    });
  };

  return GoogleAdsConversionUploadAttempt;
};
