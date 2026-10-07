'use strict';

module.exports = (sequelize, D) => {
  const fk = (model, key, type = D.INTEGER) => ({ type, allowNull: false,
    references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
  const Visit = sequelize.define('AppointmentVisit', {
    id: { type: D.STRING(36), primaryKey: true, allowNull: false },
    clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
    owner_appointment_id: fk('CitasPacientes', 'id_cita'),
    grouping_kind: { type: D.STRING(24), allowNull: false, validate: { isIn: [['singleton', 'validated_prp']] } },
    status: { type: D.STRING(24), allowNull: false, defaultValue: 'active', validate: { isIn: [['active', 'merged', 'needs_review']] } },
    communication_revision: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    membership_sha256: { type: D.STRING(64), allowNull: false }, snapshot_sha256: { type: D.STRING(64), allowNull: false },
    snapshot: { type: D.JSON, allowNull: false }, grouping_evidence: { type: D.JSON, allowNull: false },
    runtime_enrollment: { type: D.JSON, allowNull: true }, runtime_enrollment_sha256: { type: D.STRING(64), allowNull: true },
    merged_into_visit_id: { ...fk('AppointmentVisits', 'id', D.STRING(36)), allowNull: true },
    created_by: { type: D.INTEGER, allowNull: true }, updated_by: { type: D.INTEGER, allowNull: true },
    created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
  }, { tableName: 'AppointmentVisits', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ name: 'av_clinic_patient', fields: ['clinic_id', 'patient_id', 'id'] }] });
  Visit.associate = models => {
    Visit.hasMany(models.AppointmentVisitMember, { foreignKey: 'visit_id', as: 'members' });
    Visit.hasMany(models.AppointmentVisitCommunication, { foreignKey: 'visit_id', as: 'communications' });
    Visit.belongsTo(models.CitaPaciente, { foreignKey: 'owner_appointment_id', targetKey: 'id_cita', as: 'ownerAppointment' });
  };
  return Visit;
};
