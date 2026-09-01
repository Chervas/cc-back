'use strict';

module.exports = (sequelize, DataTypes) => {
  const AutomationInboundMessageClaim = sequelize.define('AutomationInboundMessageClaim', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    claim_key: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    message_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    conversation_id: { type: DataTypes.INTEGER, allowNull: false },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    channel: { type: DataTypes.STRING(24), allowNull: false },
    provider_message_id: { type: DataTypes.STRING(191), allowNull: true },
    owner_type: { type: DataTypes.STRING(48), allowNull: false, defaultValue: 'dispatching' },
    owner_reference_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'claimed' },
    claimed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    processed_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
  }, {
    tableName: 'AutomationInboundMessageClaims',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['conversation_id', 'created_at'] },
      { fields: ['clinic_id', 'owner_type', 'status'] },
      { fields: ['channel', 'provider_message_id'] },
    ],
  });

  AutomationInboundMessageClaim.associate = function associate(models) {
    AutomationInboundMessageClaim.belongsTo(models.Message, {
      foreignKey: 'message_id',
      as: 'message',
    });
    AutomationInboundMessageClaim.belongsTo(models.Conversation, {
      foreignKey: 'conversation_id',
      as: 'conversation',
    });
  };

  return AutomationInboundMessageClaim;
};
