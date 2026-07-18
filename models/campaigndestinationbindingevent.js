'use strict';

function immutableEvent(instance, options = {}) {
  const changed = typeof instance?.changed === 'function'
    ? instance.changed()
    : (options.fields || Object.keys(options.attributes || {}));
  if (Array.isArray(changed) && changed.every((field) => field === 'jobRequestId')) return;
  const error = new Error('CampaignDestinationBindingEvent es append-only');
  error.code = 'CAMPAIGN_DESTINATION_EVENT_IMMUTABLE';
  throw error;
}

function immutableBulkEvent() {
  const error = new Error('CampaignDestinationBindingEvent es append-only');
  error.code = 'CAMPAIGN_DESTINATION_EVENT_IMMUTABLE';
  throw error;
}

module.exports = (sequelize, DataTypes) => {
  const CampaignDestinationBindingEvent = sequelize.define('CampaignDestinationBindingEvent', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    eventId: { type: DataTypes.STRING(80), allowNull: false, field: 'event_id' },
    bindingId: { type: DataTypes.STRING(36), allowNull: false, field: 'binding_id' },
    accountId: { type: DataTypes.STRING(36), allowNull: true, field: 'account_id' },
    eventType: {
      type: DataTypes.ENUM('landing_published', 'destination_ready', 'apply_requested', 'apply_started', 'readback_verified', 'readback_failed', 'rollback_requested', 'rollback_started', 'rollback_verified', 'rollback_failed'),
      allowNull: false,
      field: 'event_type',
    },
    eventDigest: { type: DataTypes.STRING(64), allowNull: false, field: 'event_digest', validate: { is: /^[a-f0-9]{64}$/ } },
    data: { type: DataTypes.JSON, allowNull: false },
    jobRequestId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'job_request_id' },
    actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
  }, {
    tableName: 'CampaignDestinationBindingEvents',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { unique: true, name: 'uniq_campaign_destination_binding_event_id', fields: ['event_id'] },
      { fields: ['binding_id', 'created_at'] },
      { fields: ['account_id', 'created_at'] },
    ],
    hooks: { beforeUpdate: immutableEvent, beforeBulkUpdate: immutableBulkEvent, beforeDestroy: immutableBulkEvent, beforeBulkDestroy: immutableBulkEvent },
  });

  CampaignDestinationBindingEvent.associate = function associate(models) {
    CampaignDestinationBindingEvent.belongsTo(models.CampaignDestinationBinding, { foreignKey: 'bindingId', as: 'binding', onDelete: 'CASCADE' });
    CampaignDestinationBindingEvent.belongsTo(models.CampaignDestinationBindingAccount, { foreignKey: 'accountId', as: 'account', onDelete: 'SET NULL' });
    if (models.JobRequest) CampaignDestinationBindingEvent.belongsTo(models.JobRequest, { foreignKey: 'jobRequestId', as: 'job', onDelete: 'SET NULL' });
  };

  return CampaignDestinationBindingEvent;
};
