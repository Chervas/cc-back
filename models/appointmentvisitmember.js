'use strict';

module.exports = (sequelize, D) => {
  const fk = (model, key, type = D.INTEGER) => ({ type, allowNull: false,
    references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
  const Member = sequelize.define('AppointmentVisitMember', {
    appointment_id: { ...fk('CitasPacientes', 'id_cita'), primaryKey: true },
    visit_id: fk('AppointmentVisits', 'id', D.STRING(36)),
    clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
    role: { type: D.STRING(24), allowNull: false, validate: { isIn: [['primary', 'prp_extraction']] } },
    evidence: { type: D.JSON, allowNull: false },
    created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
  }, { tableName: 'AppointmentVisitMembers', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ name: 'avm_visit_member', fields: ['visit_id', 'appointment_id'] }] });
  Member.associate = models => {
    Member.belongsTo(models.AppointmentVisit, { foreignKey: 'visit_id', as: 'visit' });
    Member.belongsTo(models.CitaPaciente, { foreignKey: 'appointment_id', targetKey: 'id_cita', as: 'appointment' });
  };
  return Member;
};
