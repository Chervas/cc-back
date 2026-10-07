'use strict';
module.exports = (sequelize, D) => sequelize.define('AppointmentPatientLinkMember', {
  appointment_id: { type: D.INTEGER, primaryKey: true, allowNull: false, references: { model: 'CitasPacientes', key: 'id_cita' } },
  link_id: { type: D.STRING(36), allowNull: false, references: { model: 'AppointmentPatientLinks', key: 'id' } },
}, { tableName: 'AppointmentPatientLinkMembers', underscored: true,
  indexes: [{ fields: ['link_id', 'appointment_id'], name: 'aplm_link_appointment' }] });
