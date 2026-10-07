'use strict';

module.exports = (sequelize, D) => {
  const fk = (model, key, type = D.INTEGER) => ({ type, allowNull: false,
    references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
  const Communication = sequelize.define('AppointmentVisitCommunication', {
    id: { type: D.STRING(36), primaryKey: true, allowNull: false },
    visit_id: fk('AppointmentVisits', 'id', D.STRING(36)),
    clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
    owner_appointment_id: fk('CitasPacientes', 'id_cita'),
    purpose: { type: D.STRING(64), allowNull: false },
    communication_revision: { type: D.INTEGER.UNSIGNED, allowNull: false, validate: { min: 1 } },
    window_key: { type: D.STRING(120), allowNull: false }, window_sha256: { type: D.STRING(64), allowNull: false },
    window_starts_at: { type: D.DATE(3), allowNull: false }, window_ends_at: { type: D.DATE(3), allowNull: false },
    membership_sha256: { type: D.STRING(64), allowNull: false }, snapshot_sha256: { type: D.STRING(64), allowNull: false },
    snapshot: { type: D.JSON, allowNull: false },
    runtime_stage: { type: D.JSON, allowNull: true }, runtime_stage_sha256: { type: D.STRING(64), allowNull: true },
    runtime_wait: { type: D.JSON, allowNull: true }, runtime_wait_sha256: { type: D.STRING(64), allowNull: true },
    status: { type: D.STRING(24), allowNull: false, defaultValue: 'pending',
      validate: { isIn: [['pending', 'dispatching', 'accepted', 'unknown', 'failed', 'cancelled']] } },
    template_version_id: { type: D.INTEGER, allowNull: true },
    execution_id: { ...fk('FlowExecutionsV2', 'id'), allowNull: true }, message_id: { ...fk('Messages', 'id'), allowNull: true },
    accepted_at: { type: D.DATE(3), allowNull: true }, unknown_at: { type: D.DATE(3), allowNull: true },
    cancelled_at: { type: D.DATE(3), allowNull: true }, cancellation_reason: { type: D.STRING(120), allowNull: true },
    created_by: { type: D.INTEGER, allowNull: true },
    created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
  }, { tableName: 'AppointmentVisitCommunications', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [
      { name: 'avc_visit_purpose_revision_window', unique: true, fields: ['visit_id', 'purpose', 'communication_revision', 'window_sha256'] },
      { name: 'avc_message_unique', unique: true, fields: ['message_id'] },
      { name: 'avc_execution', fields: ['execution_id'] },
      { name: 'avc_clinic_visit_status', fields: ['clinic_id', 'visit_id', 'status'] },
    ] });
  Communication.associate = models => {
    Communication.belongsTo(models.AppointmentVisit, { foreignKey: 'visit_id', as: 'visit' });
    Communication.belongsTo(models.CitaPaciente, { foreignKey: 'owner_appointment_id', targetKey: 'id_cita', as: 'ownerAppointment' });
    Communication.belongsTo(models.FlowExecutionV2, { foreignKey: 'execution_id', as: 'execution' });
    Communication.belongsTo(models.Message, { foreignKey: 'message_id', as: 'message' });
  };
  return Communication;
};
