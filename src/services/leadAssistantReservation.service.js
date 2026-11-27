'use strict';

const { randomBytes } = require('node:crypto');
const { bookingVisibility } = require('../lib/treatment-booking-visibility');
const { getPhoneIdentityCandidates, normalizePhoneE164 } = require('../lib/phone');
const { normalizeHumanName } = require('../lib/name');
const { loadScopedTreatment, requireOperationalProfile } = require('./treatmentBookingProfile.service');
const { mutateAppointmentBooking } = require('./appointmentBookingCommand.service');
const { lockPatientHistoryCounter } = require('./patientHistoryNumber.service');
const {
  persistedLeadPatientId,
  assertAppointmentLeadPatientConsistency,
  recordCreatedAppointmentLead,
} = require('./appointmentLeadLink.service');

const review = () =>
  Object.assign(new Error('assistant_booking_review'), { code: 'assistant_booking_review' });

async function resolveIdentity({ db, thread, lead, contact, transaction, audience }) {
  const cid = thread.clinic_id;
  const known =
    thread.patient_id ||
    (lead && (await persistedLeadPatientId({ models: db, leadId: lead.id, transaction })));
  if (known) {
    if (audience === 'leads') throw review();
    const row = await db.Paciente.findByPk(known, {
      attributes: ['id_paciente', 'clinica_id'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !row ||
      (row.clinica_id !== cid &&
        !(await db.PacienteClinica.count({ where: { paciente_id: known, clinica_id: cid }, transaction })))
    )
      throw review();
    return row.id_paciente;
  }
  const inboundPhone = thread.channel === 'whatsapp' ? normalizePhoneE164(thread.contact_id) : null;
  const phone = inboundPhone || normalizePhoneE164(contact?.phone || lead?.telefono);
  const name = normalizeHumanName(contact?.name || lead?.nombre || '');
  if (!phone || !name) throw review();
  await lockPatientHistoryCounter(db.sequelize, cid, transaction);
  const { Op } = db.Sequelize;
  const matches = await db.Paciente.findAll({
    where: {
      [Op.and]: db.Sequelize.where(
        db.Sequelize.fn(
          'REGEXP_REPLACE',
          db.Sequelize.fn('REGEXP_REPLACE', db.Sequelize.col('Paciente.telefono_movil'), '[^0-9]', ''),
          '^00',
          ''
        ),
        { [Op.in]: getPhoneIdentityCandidates(phone).map((n) => n.replace(/[^0-9]/g, '')) }
      ),
      [Op.or]: [{ clinica_id: cid }, { '$clinicasVinculadas.clinica_id$': cid }],
    },
    attributes: ['id_paciente', 'clinica_id'],
    include: [{ model: db.PacienteClinica, as: 'clinicasVinculadas', attributes: [], required: false }],
    subQuery: false,
    limit: 2,
    transaction,
  });
  // A number typed into an Instagram DM cannot establish ownership of an existing patient's record.
  if (matches.length) {
    if (matches.length !== 1 || !inboundPhone || audience === 'leads') throw review();
    return matches[0].id_paciente;
  }
  const newPatient = await db.Paciente.create(
    {
      public_id: 'pac_' + randomBytes(10).toString('hex'),
      nombre: name,
      apellidos: '',
      telefono_movil: phone,
      ...(contact?.email ? { email: contact.email } : {}),
      clinica_id: cid,
      idioma_preferido: 'es',
    },
    { transaction }
  );
  await db.PacienteClinica.create(
    { paciente_id: newPatient.id_paciente, clinica_id: cid, es_principal: true },
    { transaction }
  );
  return newPatient.id_paciente;
}

async function reserve({
  db,
  clinic,
  thread,
  lead,
  chosen,
  treatment,
  scope,
  actorId,
  contact,
  requestKey,
  transaction,
  capabilities,
  getPatient = resolveIdentity,
  visitManager,
  checkIncident,
  recordLead,
  enqueueSignals,
  enqueueBooked,
}) {
  const cid = Number(clinic.id_clinica);
  if (
    cid !== thread.clinic_id ||
    !Number.isSafeInteger(actorId) ||
    !actorId ||
    (!thread.patient_id && !lead) ||
    (lead && (lead.clinica_id !== cid || lead.id !== thread.lead_id || lead.archived_at)) ||
    !chosen?.receipt ||
    +new Date(chosen.start) <= Date.now()
  )
    throw review();
  const catalog = await loadScopedTreatment({ db, clinic, treatmentId: treatment.id, transaction });
  if (!catalog.activo || bookingVisibility(catalog)) throw review();
  const profile = requireOperationalProfile(catalog, { capabilities });
  const patientId = await getPatient({ db, thread, lead, contact, transaction, audience: scope.audience });
  const values = {
    clinica_id: cid,
    paciente_id: patientId,
    lead_intake_id: lead?.id || null,
    campana_id: lead?.campana_id || null,
    tratamiento_id: treatment.id,
    doctor_id: chosen.doctorId,
    instalacion_id: chosen.roomId,
    inicio: new Date(chosen.start),
    fin: new Date(chosen.end),
    created_by: actorId,
    updated_by: actorId,
    tipo_cita: 'primera_con_trat',
    estado: 'pendiente',
    es_provisional: false,
  };
  const provenance = {
    request_key: requestKey,
    channel: thread.channel,
    conversation_id: thread.id,
    origin_message_id: scope.originMessageId,
    confirmation_message_id: scope.messageId,
    publication_version: scope.version,
    template_id: scope.templateId,
    promotion: scope.promotionKey || null,
  };
  const incident = checkIncident || require('./patientIncidents.service').bookingIncident;
  if (await incident({ db, clinicIds: [cid], patientId, leadId: lead?.id, transaction, activeOnly: true }))
    throw review();
  const managed = visitManager || require('./appointmentVisitManaged.service').current();
  const birth = await managed.prepareBirth({ requestKey, values, clinic, actorId, profile });
  if (!birth) {
    values.source_system = 'quickchat_assistant';
    values.source_reference = requestKey;
  }
  // The canonical writer owns the registry used to validate managed visit tokens.
  const appointment = await mutateAppointmentBooking({
    db,
    appointmentValues: values,
    transaction,
    capabilities,
    visitBirth: birth,
    selections: chosen.selections,
    expectedPlanSha256: chosen.receipt,
    persist: async ({ values: locked, existing, sealedBirth }) => {
      if (!sealedBirth)
        await require('./appointmentPatientLinks.service').choiceRequired(
          db,
          { ...locked, patient_link_combined: profile.phases.length > 1 },
          clinic,
          null,
          transaction,
          { summaryOnly: true }
        );
      const row = sealedBirth ? existing : await db.CitaPaciente.create(locked, { transaction });
      // The generic writer protects source_* metadata. Only this originating command can stamp the receipt.
      await row.update(
        { import_metadata: { ...row.import_metadata, source_quickchat_assistant: provenance } },
        { transaction }
      );
      if (lead) {
        await assertAppointmentLeadPatientConsistency({ models: db, lead, appointment: row, transaction });
        await (recordLead || recordCreatedAppointmentLead)({
          models: db,
          lead,
          appointment: row,
          transaction,
          actorId,
          explicitLeadIntakeId: lead.id,
        });
        await (
          enqueueSignals || require('./leadCrmSignalPersistence.service').enqueueCreatedAppointmentCrmSignals
        )({ lead, appointment: row, transaction });
      }
      return row;
    },
  });
  await (enqueueBooked || require('./leadAssistantAppointmentEvents.service').enqueue)({
    db,
    transaction,
    appointmentId: appointment.id_cita,
    clinicId: cid,
    conversationId: thread.id,
    messageId: scope.messageId,
  });
  return { id: appointment.id_cita, patientId };
}

module.exports = { reserve, resolveIdentity };
