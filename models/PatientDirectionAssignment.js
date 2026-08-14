'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientDirectionAssignment extends Model {
    static associate(models) {
      PatientDirectionAssignment.belongsTo(models.Clinica, { foreignKey: 'clinic_id', as: 'clinic' });
      PatientDirectionAssignment.belongsTo(models.Usuario, { foreignKey: 'director_user_id', as: 'director' });
      PatientDirectionAssignment.belongsTo(models.Usuario, { foreignKey: 'successor_user_id', as: 'successor' });
      PatientDirectionAssignment.belongsTo(models.ClinicMetaAsset, { foreignKey: 'director_phone_asset_id', as: 'directorPhone' });
      PatientDirectionAssignment.belongsTo(models.ClinicMetaAsset, { foreignKey: 'clinic_phone_asset_id', as: 'clinicPhone' });
      PatientDirectionAssignment.belongsTo(models.LeadIntake, { foreignKey: 'lead_intake_id', as: 'lead' });
      PatientDirectionAssignment.belongsTo(models.Conversation, { foreignKey: 'conversation_id', as: 'conversation' });
      PatientDirectionAssignment.belongsTo(models.Paciente, { foreignKey: 'patient_id', as: 'patient' });
      PatientDirectionAssignment.belongsTo(models.CitaPaciente, { foreignKey: 'first_appointment_id', as: 'firstAppointment' });
      PatientDirectionAssignment.hasMany(models.PatientDirectionEvent, { foreignKey: 'assignment_id', as: 'events' });
    }
  }

  PatientDirectionAssignment.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    director_user_id: { type: DataTypes.INTEGER, allowNull: false },
    director_phone_asset_id: { type: DataTypes.INTEGER, allowNull: false },
    clinic_phone_asset_id: { type: DataTypes.INTEGER, allowNull: true },
    successor_user_id: { type: DataTypes.INTEGER, allowNull: true },
    lead_intake_id: { type: DataTypes.INTEGER, allowNull: true },
    conversation_id: { type: DataTypes.INTEGER, allowNull: true },
    patient_id: { type: DataTypes.INTEGER, allowNull: true },
    first_appointment_id: { type: DataTypes.INTEGER, allowNull: true },
    phone_e164: { type: DataTypes.STRING(32), allowNull: false },
    active_phone_key: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    status: {
      type: DataTypes.ENUM('unassigned', 'active', 'handoff_pending', 'handed_off', 'ended_attended', 'ended_discarded', 'ended_service_disabled'),
      allowNull: false,
      defaultValue: 'active',
    },
    start_reason: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'manual' },
    started_by: { type: DataTypes.INTEGER, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    end_reason: { type: DataTypes.STRING(64), allowNull: true },
    ended_by: { type: DataTypes.INTEGER, allowNull: true },
    ended_at: { type: DataTypes.DATE, allowNull: true },
    handoff_state: {
      type: DataTypes.ENUM('not_required', 'pending', 'queued', 'sent', 'failed'),
      allowNull: false,
      defaultValue: 'not_required',
    },
    handoff_message_id: { type: DataTypes.INTEGER, allowNull: true },
    old_number_notice_state: {
      type: DataTypes.ENUM('not_required', 'pending', 'sent', 'failed'),
      allowNull: false,
      defaultValue: 'not_required',
    },
    metadata: { type: DataTypes.JSON, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientDirectionAssignment',
    tableName: 'PatientDirectionAssignments',
    timestamps: true,
    underscored: true,
  });

  return PatientDirectionAssignment;
};
