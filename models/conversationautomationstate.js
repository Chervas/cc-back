'use strict';

module.exports = (sequelize, DataTypes) => {
  const ConversationAutomationState = sequelize.define('ConversationAutomationState', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    conversation_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'active' },
    stage: { type: DataTypes.STRING(24), allowNull: false },
    source_message_id: { type: DataTypes.INTEGER, allowNull: true },
    first_message_at: { type: DataTypes.DATE, allowNull: true },
    deadline_at: { type: DataTypes.DATE, allowNull: true },
    execution_id: { type: DataTypes.INTEGER, allowNull: true },
    job_request_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    appointment_id: { type: DataTypes.INTEGER, allowNull: true },
    appointment_status: { type: DataTypes.STRING(40), allowNull: true },
    intent: { type: DataTypes.STRING(64), allowNull: true },
    possible_urgency: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    needs_response: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    manual_action_required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    failure_code: { type: DataTypes.STRING(96), allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'ConversationAutomationStates',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['clinic_id', 'status', 'updated_at'] },
      { fields: ['execution_id'] },
      { fields: ['source_message_id'] },
    ],
  });

  ConversationAutomationState.associate = function associate(models) {
    ConversationAutomationState.belongsTo(models.Conversation, {
      foreignKey: 'conversation_id',
      as: 'conversation',
    });
    if (models.FlowExecutionV2) {
      ConversationAutomationState.belongsTo(models.FlowExecutionV2, {
        foreignKey: 'execution_id',
        as: 'execution',
      });
    }
  };

  return ConversationAutomationState;
};
