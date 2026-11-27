'use strict';

const { randomUUID, createHash } = require('node:crypto');
const cal = require('./leadAssistantCalendar.service');
const { normalizePhoneE164 } = require('../lib/phone');
const { normalizeHumanName } = require('../lib/name');
const { assistantCommercialText, explicitOptOut } = require('./socialLeadInterestClassification.service');
const { reserve } = require('./leadAssistantReservation.service');

function readContact(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 300 || /[<>\n]/.test(value)) return null;
  const emailText = value.match(/(?:^|[\s,;])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63})(?=$|[\s,;])/i);
  const email = emailText?.[1] || null;
  const withoutEmail = email ? value.replace(email, '') : value;
  if (withoutEmail.includes('@')) return null;
  const phoneText = withoutEmail.match(/(?:\+\d{1,3}[ -]?)?(?:\d[ -]?){8,14}\d/);
  const phone = phoneText ? normalizePhoneE164(phoneText[0].trim()) : null;
  const raw = withoutEmail
    .replace(phoneText?.[0] || '\u0000', '')
    .replace(/\b(?:tel[eé]fono|m[oó]vil)(?: es)?\b\s*:?/gi, '')
    .replace(/^(?:me llamo|mi nombre es|a nombre de|soy)\s+/i, '')
    .replace(/\b(?:mi )?(?:correo(?: electr[oó]nico)?|e-?mail)(?: es)?\b\s*:?/gi, '')
    .replace(/^[,;\s-]+|[,.\s;-]+$/g, '')
    .trim();
  const name =
    raw &&
    !/\b(?:confirmo|prefiero|gracias|quiero|tengo|tarde|manana|ninguno|no|dolor|equipo|recepcion)\b/.test(
      cal.normalize(raw)
    ) &&
    /^[\p{L}][\p{L}'’-]{1,35}(?: [\p{L}][\p{L}'’-]{0,35}){0,4}$/u.test(raw) &&
    assistantCommercialText('Nombre de reserva ' + raw)
      ? normalizeHumanName(raw)
      : null;
  return name || phone || email ? { name, phone, ...(email ? { email } : {}) } : null;
}

function wantsHumanInput(raw) {
  return /\b(?:dolor|urgente|sangr|enferm|medicaci[oó]n|alerg|embaraz|s[ií]ntoma)/i.test(raw);
}

async function previous(db, scope, transaction) {
  const path = db.sequelize.literal("'$.assistantBooking'");
  const row = await db.Message.findOne({
    where: {
      conversation_id: scope.conversationId,
      direction: 'inbound',
      id: { [db.Sequelize.Op.lt]: scope.messageId, [db.Sequelize.Op.gte]: scope.originMessageId },
      'metadata.leadAssistantTurn.templateId': scope.templateId,
      'metadata.leadAssistantTurn.publicationVersion': scope.version,
      [db.Sequelize.Op.and]: db.sequelize.where(
        db.sequelize.fn('JSON_CONTAINS_PATH', db.sequelize.col('metadata'), 'one', path),
        1
      ),
    },
    attributes: ['id', 'metadata'],
    order: [['id', 'DESC']],
    transaction,
  });
  return row?.metadata?.assistantBooking || null;
}

async function hasDelivered(db, thread, prior, transaction) {
  return !!(
    prior?.executionId &&
    (await db.Message.count({
      where: {
        conversation_id: thread.id,
        direction: 'outbound',
        status: { [db.Sequelize.Op.in]: ['sent', 'delivered', 'read'] },
        'metadata.execution_id': prior.executionId,
        'metadata.source': 'automations_v2',
      },
      transaction,
    }))
  );
}

async function localProfessional(db, clinicId, text) {
  const match = String(text).match(
    /\b(?:con (?:el |la )?(?:dr\.?|dra\.?|doctor|doctora|profesional)|(?:profesional|doctor[a]?) de agenda\s*:)\s+([\p{L}][\p{L} .'-]{1,65})/iu
  );
  if (!match) return { id: null };
  const rows = await db.DoctorClinica.findAll({
    where: { clinica_id: clinicId, activo: true, recibe_citas: true },
    attributes: ['doctor_id'],
    include: [{ model: db.Usuario, as: 'doctor', attributes: ['nombre', 'apellidos'], required: true }],
    raw: true,
    nest: true,
  });
  const request = ' ' + cal.normalize(match[1]) + ' ';
  const matches = rows.filter((r) =>
    [r.doctor.nombre, r.doctor.apellidos, [r.doctor.nombre, r.doctor.apellidos].join(' ')].some(
      (name) => name && request.includes(' ' + cal.normalize(name) + ' ')
    )
  );
  return matches.length === 1 ? { id: matches[0].doctor_id } : { unclear: true };
}

async function processTurn({
  db,
  thread,
  entry,
  scope,
  execution,
  fields,
  offer,
  blockReason,
  availability,
  mayBook,
  findSlots = cal.available,
  book = reserve,
  now = new Date(),
  capabilities,
}) {
  if (entry.type !== 'dm' || explicitOptOut(entry.text)) return null;
  const raw = String(entry.text || '').trim();
  if (scope.originMessageId === scope.messageId && !cal.bookingRequest(raw)) return null;
  const pending = await previous(db, scope);
  const contactTurn = pending?.stage === 'contact' && readContact(raw) && !wantsHumanInput(raw);
  const choice =
    pending?.slots?.length &&
    cal.selection(raw, pending.slots, pending.stage === 'confirm' ? pending.selected : null);
  const requestBooking = !!assistantCommercialText(raw) && cal.bookingRequest(raw);
  if (wantsHumanInput(raw)) return null;
  const revisesDate =
    !!pending &&
    ['service', 'offered', 'confirm'].includes(pending.stage) &&
    !!assistantCommercialText(raw) &&
    /\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|tarde|hoy|\d{1,4}[/-]\d{1,2})\b/i.test(
      raw
    );
  const unspecifiedYes =
    pending?.stage === 'offered' && /^(?:s[ií]|vale|confirmo|de acuerdo)[.! ]*$/i.test(raw.trim());
  if (
    !requestBooking &&
    !choice &&
    !contactTurn &&
    !revisesDate &&
    !unspecifiedYes &&
    !(pending?.stage === 'service' && assistantCommercialText(raw))
  )
    return null;
  const blocked = await blockReason();
  if (blocked || !(await availability())) return { stop: blocked || 'reply_unavailable' };
  const allowed =
    mayBook ||
    ((actorId, clinicId) =>
      require('../lib/access-policy').canUserAccessFeature({
        actorId,
        clinicId,
        featureKey: 'appointments.manage',
      }));
  if (!(await allowed(execution.created_by, thread.clinic_id))) return { review: true };
  const clinic = await db.Clinica.findByPk(thread.clinic_id, {
    attributes: [
      'id_clinica',
      'nombre_clinica',
      'grupoClinicaId',
      'configuracion',
      'equipment_booking_enabled',
    ],
    raw: true,
  });
  const mapped = offer && require('../lib/lead-assistant-tables').tableRows(fields.booking, [
    /promocion|oferta/, /tratamiento|servicio/, /persona|profesional/,
  ]).filter(([title]) => cal.normalize(title) === cal.normalize(offer.title));
  if (mapped?.length > 1) return { review: true };
  const mapping = mapped?.[0];
  const catalog = await cal.services(db, clinic, fields, offer);
  const choices = mapping ? catalog.filter(item => [item.name, item.code].some(name => cal.normalize(name) === cal.normalize(mapping[1]))) : catalog;
  if (mapping && choices.length !== 1) return { review: true };
  if (!choices.length) return { review: true };
  const timezone = cal.resolveClinicTimezone(clinic);
  const treatment = cal.pickTreatment(choices, raw, offer, pending?.treatment?.id);
  async function materialize(build) {
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async (transaction) => {
      const current = await db.Conversation.findByPk(thread.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const m = await db.Message.findOne({
        where: { id: entry.messageId, conversation_id: current.id, direction: 'inbound' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const turn = m?.metadata?.leadAssistantTurn;
      if (
        !turn ||
        turn.executionId !== execution.id ||
        turn.publicationVersion !== scope.version ||
        turn.templateId !== scope.templateId
      )
        throw Error('assistant_booking_scope');
      if (m.metadata.assistantBooking) return { reply: m.metadata.assistantBooking.reply };
      const unavailable = await blockReason(transaction);
      if (
        unavailable ||
        !(await db.LeadAssistantSession.count({
          where: {
            conversation_id: current.id,
            clinic_id: current.clinic_id,
            template_id: scope.templateId,
            publication_version: scope.version,
            state: 'active',
          },
          transaction,
        }))
      )
        return { stop: unavailable || 'assistant_turn_unavailable' };
      const state = await build({ current, transaction });
      if (!state || state.review || state.stop) return state;
      const complete = { ...state, executionId: execution.id, createdAt: now.toISOString() };
      const visible =
        complete.stage === 'booked'
          ? {
              assistantAppointment: {
                id: complete.appointmentId,
                clinicId: current.clinic_id,
                date: complete.slots[complete.selected].local.slice(0, 10),
                time: complete.slots[complete.selected].local.slice(11, 16),
              },
            }
          : {};
      await m.update(
        { metadata: { ...m.metadata, assistantBooking: complete, ...visible } },
        { transaction }
      );
      return { reply: state.reply };
    });
  }
  if (!treatment)
    return materialize(async () => ({
      stage: 'service',
      reply:
        '¿Para qué tratamiento quieres la cita? ' +
        choices
          .slice(0, 6)
          .map((c) => c.name)
          .join(', ') +
        '.',
    }));
  const lead =
    thread.lead_id &&
    (await db.LeadIntake.findOne({
      where: { id: thread.lead_id, clinica_id: thread.clinic_id, archived_at: null },
      attributes: [
        'id',
        'clinica_id',
        'grupo_clinica_id',
        'campana_id',
        'nombre',
        'telefono',
        'archived_at',
        'external_source',
      ],
      raw: true,
    }));
  const currentOffer =
    pending?.treatment?.id === treatment.id && pending.stage !== 'booked' && pending.slots?.length;
  const professional = await localProfessional(db, thread.clinic_id, raw);
  if (professional.unclear) return { review: true };
  const assigned = mapping ? await localProfessional(db, thread.clinic_id, 'Profesional de agenda: ' + mapping[2]) : null;
  if (mapping && (!assigned?.id || (professional.id && professional.id !== assigned.id))) return { review: true };
  const professionalId = assigned?.id || professional.id || (currentOffer ? pending.professionalId : null);
  const calendar = cal.requestedCalendar(raw, timezone, now);
  if (!calendar)
    return materialize(async () => ({
      stage: 'service',
      treatment,
      reply: '¿Qué día futuro te vendría bien para la cita?',
    }));
  async function propose(prefix = '', range = calendar) {
    const available = await findSlots({
      db,
      clinic,
      treatment,
      calendar: range,
      patientId: thread.patient_id,
      professionalId,
      now,
      capabilities,
    });
    const slots = /\b(?:dos|2) (?:alternativas|opciones|huecos)\b/i.test(fields.booking) ? available.slice(0, 2) : available;
    return materialize(async () =>
      slots.length
        ? {
            stage: 'offered',
            offerMessageId: entry.messageId,
            treatment,
            professionalId,
            calendar: range,
            slots,
            requestKey: randomUUID(),
            reply:
              prefix +
              'Para ' +
              treatment.name +
              ' en ' +
              clinic.nombre_clinica +
              ' tengo ' +
              slots.map((s, i) => i + 1 + ') ' + cal.display(s, timezone)).join(' · ') +
              '. ¿Cuál te va mejor?',
          }
        : {
            stage: 'service',
            treatment,
            reply:
              prefix +
              'No encuentro un hueco disponible para ' +
              treatment.name +
              ' en esas fechas. ¿Qué otro día te iría bien?',
          }
    );
  }
  if (pending?.stage === 'booked' && choice) {
    return materialize(async () => ({
      ...pending,
      reply:
        'Tu cita ya está reservada para el ' + cal.display(pending.slots[pending.selected], timezone) + '.',
    }));
  }
  if (unspecifiedYes && currentOffer) {
    return materialize(async () => ({
      ...pending,
      reply:
        '¿Cuál de estos horarios quieres reservar? ' +
        pending.slots.map((s, i) => i + 1 + ') ' + cal.display(s, timezone)).join(' · ') +
        '.',
    }));
  }
  if (!currentOffer || (!choice && !contactTurn)) return propose();
  if (!(await hasDelivered(db, thread, pending))) return { review: true };
  const index = choice ? choice.index : pending.selected;
  const selected = pending.slots[index];
  if (!selected || +new Date(selected.start) <= +now) return propose('Ese hueco ya ha pasado. ');
  const common = {
    offerMessageId: pending.offerMessageId,
    slots: pending.slots,
    requestKey: pending.requestKey,
    treatment,
    professionalId,
    calendar: pending.calendar,
    selected: index,
  };
  const knownPhone = thread.channel === 'whatsapp' ? normalizePhoneE164(thread.contact_id) : null;
  const entered = contactTurn ? readContact(raw) : null;
  const name =
    lead?.external_source === 'quickchat_social' && lead.nombre === thread.social_alias ? null : lead?.nombre;
  const contact = {
    name: entered?.name || pending.contact?.name || name || null,
    phone: knownPhone || entered?.phone || pending.contact?.phone || lead?.telefono || null,
  };
  const needsEmail = fields.booking.split(/\r?\n/).some(line =>
    /\b(?:pregunta|pide|solicita|recoge)\w*\b.{0,190}\b(?:correo electr[oó]nico|email|e-mail)\b/i.test(line) &&
    !/\bno\s+(?:(?:hace falta|debes?)\s+)?(?:pregunt|pid|solicit|recog)/i.test(line));
  if (needsEmail) contact.email = entered?.email || pending.contact?.email || null;
  const needsSurname = /\bnombre y (?:un )?apellido/i.test(fields.booking);
  const missing = [];
  if (!thread.patient_id && (!contact.name || (needsSurname && !contact.name.trim().includes(' ')))) missing.push(needsSurname ? 'tu nombre y un apellido' : 'tu nombre');
  if (!thread.patient_id && !contact.phone) missing.push('un teléfono de contacto');
  if (needsEmail && !contact.email) missing.push('tu correo electrónico');
  if (missing.length) {
    const need = new Intl.ListFormat('es').format(missing);
    return materialize(async () => ({
      ...common,
      stage: 'contact',
      contact,
      reply: 'Para preparar la cita del ' + cal.display(selected, timezone) + ', ¿me indicas ' + need + '?',
    }));
  }
  if (!choice?.confirmed)
    return materialize(async () => ({
      ...common,
      stage: 'confirm',
      contact,
      reply:
        '¿Confirmas la cita de ' +
        treatment.name +
        ' en ' +
        clinic.nombre_clinica +
        ' para el ' +
        cal.display(selected, timezone) +
        (contact.name ? ' a nombre de ' + contact.name : '') +
        '?',
    }));
  try {
    return await materialize(async ({ current, transaction }) => {
      if (!(await hasDelivered(db, current, pending, transaction))) return { review: true };
      const ends =
        entry.channel === 'whatsapp'
          ? Date.parse(entry.expiresAt)
          : current.last_inbound_at
            ? new Date(current.last_inbound_at).getTime() + 86400000
            : NaN;
      if (
        !Number.isFinite(ends) ||
        ends <= Date.now() ||
        !(await allowed(execution.created_by, current.clinic_id))
      )
        return { stop: 'reply_unavailable' };
      const origin = await db.Message.findOne({
        where: { id: pending.offerMessageId, conversation_id: current.id, direction: 'inbound' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const original = origin?.metadata?.assistantBooking;
      if (
        original?.stage !== 'offered' ||
        original.requestKey !== pending.requestKey ||
        original.treatment.id !== treatment.id ||
        origin.metadata.leadAssistantTurn?.publicationVersion !== scope.version ||
        original.slots[index]?.receipt !== selected.receipt
      )
        return { review: true };
      if (original.redemption) {
        const prior = original.redemption;
        return {
          ...common,
          stage: 'booked',
          selected: prior.index,
          appointmentId: prior.id,
          patientId: prior.patientId,
          reply:
            'Tu cita ya está reservada para el ' + cal.display(original.slots[prior.index], timezone) + '.',
        };
      }
      let bookingLead = lead;
      if (!current.lead_id && !current.patient_id && current.channel === 'whatsapp') {
        const externalId = createHash('sha256')
          .update(JSON.stringify([current.clinic_id, current.contact_id]))
          .digest('hex');
        [bookingLead] = await db.LeadIntake.findOrCreate({
          where: { external_source: 'quickchat_whatsapp', external_id: externalId },
          defaults: {
            clinica_id: current.clinic_id,
            grupo_clinica_id: clinic.grupoClinicaId,
            source: 'whatsapp',
            channel: 'organic',
            status_lead: 'nuevo',
            nombre: contact.name,
            telefono: contact.phone,
          },
          transaction,
        });
        if (bookingLead.clinica_id !== current.clinic_id || bookingLead.archived_at)
          throw Object.assign(Error(), { code: 'assistant_booking_review' });
        await current.update({ lead_id: bookingLead.id }, { transaction });
      }
      const booked = await book({
        db,
        clinic,
        thread: current,
        lead: bookingLead,
        treatment,
        scope,
        actorId: execution.created_by,
        chosen: selected,
        contact,
        requestKey: pending.requestKey,
        transaction,
        capabilities,
      });
      await current.update({ patient_id: booked.patientId }, { transaction });
      if (bookingLead)
        await db.LeadIntake.update(
          { es_paciente: true },
          { where: { id: bookingLead.id, clinica_id: current.clinic_id }, transaction }
        );
      await origin.update(
        {
          metadata: {
            ...origin.metadata,
            assistantBooking: {
              ...original,
              redemption: { id: booked.id, patientId: booked.patientId, index },
            },
          },
        },
        { transaction }
      );
      return {
        ...common,
        stage: 'booked',
        appointmentId: booked.id,
        patientId: booked.patientId,
        reply:
          'Tu cita de ' +
          treatment.name +
          ' ha quedado reservada en ' +
          clinic.nombre_clinica +
          ' para el ' +
          cal.display(selected, timezone) +
          '. Gracias.',
      };
    });
  } catch (error) {
    if (
      [
        'booking_conflict',
        'booking_unavailable',
        'booking_plan_changed',
        'booking_slot_unavailable',
        'booking_priority_confirmation_required',
      ].includes(error.code)
    ) {
      return propose('Ese hueco se acaba de ocupar. ', pending.calendar);
    }
    if (error.code === 'assistant_booking_review' || error.status === 409 || error.statusCode === 409)
      return { review: true };
    throw error;
  }
}

// A lead-only rule may finish the receipt for the same turn that linked the patient.
async function excludedPatient(db, rule, thread, messageId, transaction) {
  if (rule.audience !== 'leads' || !thread.patient_id) return false;
  const row = await db.Message.findOne({
    where: { id: messageId, conversation_id: thread.id, direction: 'inbound' },
    attributes: ['metadata'],
    transaction,
    raw: true,
  });
  const receipt = row?.metadata?.assistantBooking;
  return !(
    receipt?.stage === 'booked' &&
    receipt.patientId === thread.patient_id &&
    receipt.appointmentId === row.metadata.assistantAppointment?.id &&
    row.metadata.leadAssistantTurn?.publicationVersion === rule.version
  );
}

module.exports = { processTurn, previous, readContact, excludedPatient };
