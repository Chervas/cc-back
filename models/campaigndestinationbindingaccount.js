'use strict';

module.exports = (sequelize, DataTypes) => {
  const CampaignDestinationBindingAccount = sequelize.define('CampaignDestinationBindingAccount', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    bindingId: { type: DataTypes.STRING(36), allowNull: false, field: 'binding_id' },
    managedCampaignId: { type: DataTypes.STRING(36), allowNull: true, field: 'managed_campaign_id' },
    provider: { type: DataTypes.ENUM('google_ads', 'meta_ads'), allowNull: false },
    customerId: { type: DataTypes.STRING(64), allowNull: false, field: 'customer_id' },
    campaignId: { type: DataTypes.STRING(128), allowNull: false, field: 'campaign_id' },
    family: { type: DataTypes.ENUM('google_search', 'google_pmax', 'meta_instant_form', 'meta_reach', 'unsupported'), allowNull: false },
    pmaxUrlExpansion: { type: DataTypes.ENUM('not_applicable', 'pending', 'enabled', 'disabled'), allowNull: false, field: 'pmax_url_expansion', defaultValue: 'not_applicable' },
    state: {
      type: DataTypes.ENUM('ready', 'apply_queued', 'applying', 'readback_pending', 'active', 'rollback_queued', 'rolling_back', 'rolled_back', 'blocked', 'failed', 'drifted'),
      allowNull: false,
      defaultValue: 'ready',
    },
    beforeState: { type: DataTypes.JSON, allowNull: true, field: 'before_state' },
    desiredState: { type: DataTypes.JSON, allowNull: false, field: 'desired_state' },
    observedState: { type: DataTypes.JSON, allowNull: true, field: 'observed_state' },
    operationDigest: { type: DataTypes.STRING(64), allowNull: false, field: 'operation_digest', validate: { is: /^[a-f0-9]{64}$/ } },
    applyEventId: { type: DataTypes.STRING(80), allowNull: true, field: 'apply_event_id' },
    readbackEventId: { type: DataTypes.STRING(80), allowNull: true, field: 'readback_event_id' },
    rollbackEventId: { type: DataTypes.STRING(80), allowNull: true, field: 'rollback_event_id' },
    applyJobRequestId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'apply_job_request_id' },
    rollbackJobRequestId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'rollback_job_request_id' },
    authorization: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    lastErrorCode: { type: DataTypes.STRING(128), allowNull: true, field: 'last_error_code' },
    lastErrorDetails: { type: DataTypes.JSON, allowNull: true, field: 'last_error_details' },
    appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
    readbackAt: { type: DataTypes.DATE, allowNull: true, field: 'readback_at' },
    rolledBackAt: { type: DataTypes.DATE, allowNull: true, field: 'rolled_back_at' },
  }, {
    tableName: 'CampaignDestinationBindingAccounts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, name: 'uniq_campaign_destination_binding_account', fields: ['binding_id', 'provider', 'customer_id', 'campaign_id'] },
      { unique: true, name: 'uniq_campaign_destination_binding_apply_event', fields: ['apply_event_id'] },
      { unique: true, name: 'uniq_campaign_destination_binding_rollback_event', fields: ['rollback_event_id'] },
      { fields: ['provider', 'customer_id', 'state'] },
      { fields: ['binding_id', 'state'] },
    ],
    validate: {
      coherentExpansionPolicy() {
        if (this.family === 'google_pmax' && !['pending', 'enabled', 'disabled'].includes(this.pmaxUrlExpansion)) {
          throw new Error('Performance Max requiere una política explícita de expansión de URL');
        }
        if (this.family !== 'google_pmax' && this.pmaxUrlExpansion !== 'not_applicable') {
          throw new Error('La política de expansión de URL solo se aplica a Performance Max');
        }
      },
    },
  });

  CampaignDestinationBindingAccount.associate = function associate(models) {
    CampaignDestinationBindingAccount.belongsTo(models.CampaignDestinationBinding, { foreignKey: 'bindingId', as: 'binding', onDelete: 'CASCADE' });
    if (models.ManagedCampaign) CampaignDestinationBindingAccount.belongsTo(models.ManagedCampaign, { foreignKey: 'managedCampaignId', as: 'managedCampaign', onDelete: 'SET NULL' });
    if (models.JobRequest) {
      CampaignDestinationBindingAccount.belongsTo(models.JobRequest, { foreignKey: 'applyJobRequestId', as: 'applyJob', onDelete: 'SET NULL' });
      CampaignDestinationBindingAccount.belongsTo(models.JobRequest, { foreignKey: 'rollbackJobRequestId', as: 'rollbackJob', onDelete: 'SET NULL' });
    }
    if (models.CampaignDestinationBindingEvent) CampaignDestinationBindingAccount.hasMany(models.CampaignDestinationBindingEvent, { foreignKey: 'accountId', as: 'events' });
  };

  return CampaignDestinationBindingAccount;
};
