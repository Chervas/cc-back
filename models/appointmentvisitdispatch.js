'use strict';
module.exports = (sequelize, D) => {
  const fk = (model, key, type = D.INTEGER) => ({ type, allowNull: false,
    references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
  const Dispatch = sequelize.define('AppointmentVisitDispatch', {
    id: { type: D.STRING(36), primaryKey: true, allowNull: false },
    communication_id: fk('AppointmentVisitCommunications', 'id', D.STRING(36)),
    message_id: fk('Messages', 'id'), execution_id: fk('FlowExecutionsV2', 'id'),
    job_request_id: fk('JobRequests', 'id', D.INTEGER.UNSIGNED),
    job_attempt: { type: D.INTEGER.UNSIGNED, allowNull: false, validate: { min: 1 } },
    job_claimed_at: { type: D.DATE(3), allowNull: false }, runtime_namespace: { type: D.STRING(32), allowNull: false },
    attempt_number: { type: D.INTEGER.UNSIGNED, allowNull: false, validate: { min: 1 } },
    attempt_token: { type: D.STRING(36), allowNull: false },
    status: { type: D.STRING(32), allowNull: false, defaultValue: 'leased',
      validate: { isIn: [['leased', 'pre_dispatch_failed', 'accepted', 'unknown', 'cancelled']] } },
    started_at: { type: D.DATE(3), allowNull: false }, lease_expires_at: { type: D.DATE(3), allowNull: false },
    network_started_at: { type: D.DATE(3), allowNull: true }, settled_at: { type: D.DATE(3), allowNull: true },
    failure_reason: { type: D.STRING(120), allowNull: true },
    created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
  }, { tableName: 'AppointmentVisitDispatches', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ name: 'avd_intent_attempt', unique: true, fields: ['communication_id', 'attempt_number'] },
      { name: 'avd_token', unique: true, fields: ['attempt_token'] }, { name: 'avd_intent_status', fields: ['communication_id', 'status'] }] });
  Dispatch.associate = models => {
    Dispatch.belongsTo(models.AppointmentVisitCommunication, { foreignKey: 'communication_id', as: 'communication' });
    Dispatch.belongsTo(models.Message, { foreignKey: 'message_id', as: 'message' });
    Dispatch.belongsTo(models.JobRequest, { foreignKey: 'job_request_id', as: 'job' });
  };
  return Dispatch;
};
