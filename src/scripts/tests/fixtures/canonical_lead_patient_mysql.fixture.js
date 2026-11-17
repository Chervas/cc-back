'use strict';
const S = require('sequelize');
const { createOwnedLeadPatientBookingFixture } = require('../helpers/owned-lead-patient-booking-fixture');

// Extends only the private mysqld fixture. No application bootstrap, recipients,
// credentials or providers. Actual booking and initial contact-link writers run.
async function createCanonicalLeadPatientMysqlFixture(context) {
  const f = await createOwnedLeadPatientBookingFixture(context, { nativeContactLink: true });
  const { db, sql } = f, D = S.DataTypes;
  for (const file of ['conversation', 'leadattributionaudit', 'patientoperationalevent']) {
    const model = require('../../../../models/' + file)(sql, D); db[model.name] = model;
    model.options.indexes.forEach((row, i) => { row.name = 'owned_canonical_' + model.name + '_' + i; });
  }
  db.Conversation.belongsTo(db.Paciente, { foreignKey: 'patient_id', as: 'paciente' });
  db.Conversation.belongsTo(db.LeadIntake, { foreignKey: 'lead_id', as: 'lead' });
  db.PatientOperationalEvent.associate(db);
  db.LeadAttributionAudit.associate(db);
  for (const name of ['Conversation', 'LeadAttributionAudit', 'PatientOperationalEvent']) await db[name].sync();
  const contextSnapshot = (leadId, patient, patch = {}) => db.LeadAttributionAudit.create({ lead_intake_id: leadId, raw_payload: null,
    attribution_steps: { type: 'lead_patient_context_v1', lead_patient_context_v1: { version: 1,
      relationship: 'existing_patient', patient_id: patient.id_paciente, clinic_id: 100, clinic_name: 'Clínica ficticia 100',
      same_clinic: true, captured_at: '2026-01-01T09:00:00.000Z', reason: 'prior_attended_appointment', request_kind: 'commercial', ...patch } } });
  const conversation = (leadId, patient, patch = {}) => db.Conversation.create({ clinic_id: 100, channel: 'whatsapp',
    contact_id: '+' + patient.telefono_movil, patient_id: patient.id_paciente, lead_id: leadId, ...patch });
  const wholeSnapshot = async () => {
    const state = await f.snapshot();
    for (const name of ['Conversation', 'LeadAttributionAudit', 'PatientOperationalEvent']) state[name] = await db[name].findAll({ order: [[db[name].primaryKeyAttribute, 'ASC']], raw: true });
    return JSON.parse(JSON.stringify(state));
  };
  return { ...f, contextSnapshot, conversation, wholeSnapshot };
}
module.exports = { createCanonicalLeadPatientMysqlFixture };
