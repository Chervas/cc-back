'use strict';

// Explicit, clinic + full-number WhatsApp channel preference. Separate from
// commercial consent, legacy automated-care opt-outs and invalid-number holds.
const { createHash } = require('node:crypto');
const { normalizePhoneDigits } = require('../lib/phone');
const CHANNEL_SCOPE = 'whatsapp_channel';
const MANUAL_SOURCE = 'patient_record_whatsapp_preference';
const plain = row => row?.toJSON ? row.toJSON() : row;
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode, retryable: false });
const stamp = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;

async function rowsFor({ db, clinicId, patient, transaction, lock = false }) {
  const phone = normalizePhoneDigits(patient.telefono_movil);
  if (!phone) return [];
  return db.MarketingContactOptOut.findAll({ where: { clinica_id: clinicId, channel: 'whatsapp',
    scope: CHANNEL_SCOPE, phone_digits: phone }, order: [['id', 'DESC']], transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
}

function projection({ patient, clinicId, rows, signedDocumentIds = [] }) {
  const phone = normalizePhoneDigits(patient.telefono_movil), list = rows.map(plain);
  const active = list.find(row => row.status === 'active');
  const own = list.find(row => Number(row.paciente_id) === Number(patient.id_paciente) && row.source === MANUAL_SOURCE);
  const signedRefusal = signedDocumentIds.length > 0;
  const version = createHash('sha256').update(JSON.stringify([Number(patient.id_paciente), Number(clinicId), phone,
    list.map(row => [Number(row.id), row.status, row.source, Number(row.paciente_id), stamp(row.updated_at || row.updatedAt), stamp(row.opted_out_at)]),
    [...signedDocumentIds].map(Number).sort((a, b) => a - b)])).digest('hex');
  return { clinic_id: Number(clinicId), phone_digits: phone, version,
    state: active || signedRefusal ? 'refused' : own?.status === 'resolved' ? 'allowed' : 'not_recorded',
    refused: !!active || signedRefusal, source: signedRefusal ? 'signed_privacy_document' : active?.source || own?.source || null,
    changed_at: stamp(active?.opted_out_at || own?.updated_at || own?.updatedAt),
    can_clear: !signedRefusal && (!active || list.filter(row => row.status === 'active').every(row => row.source === MANUAL_SOURCE && Number(row.paciente_id) === Number(patient.id_paciente))) };
}

async function signedRefusalIds({ db, patient, clinicId, transaction }) {
  const phone = normalizePhoneDigits(patient.telefono_movil);
  if (!phone) return [];
  const refusal = await require('../lib/bs-privacy-commercial-preferences').channelRefusals({
    db, clinicIds: [clinicId], patientIds: [Number(patient.id_paciente)], phone, transaction,
  });
  return refusal.documentIds;
}

async function channelRestrictions({ db, clinicId, phones = [], patientIds = [], transaction = null }) {
  const numbers = [...new Set(phones.map(normalizePhoneDigits).filter(Boolean))];
  if (!numbers.length) return new Map();
  if (numbers.length > 200) throw fail('patient_communication_batch_invalid', 'Revisa los teléfonos.', 400);
  const rows = db.MarketingContactOptOut ? await db.MarketingContactOptOut.findAll({
    where: { clinica_id: clinicId, channel: 'whatsapp', scope: CHANNEL_SCOPE, status: 'active', phone_digits: { [db.Sequelize.Op.in]: numbers } },
    attributes: ['phone_digits'], transaction, raw: true,
  }) : [];
  const signed = await require('../lib/bs-privacy-commercial-preferences').channelRefusals({ db, clinicIds: [clinicId], patientIds, phones: numbers, transaction });
  const refused = new Set([...rows.map(row => normalizePhoneDigits(plain(row).phone_digits)), ...signed.phoneDigits]);
  return new Map(numbers.map(number => [number, refused.has(number)]));
}

async function view({ db, patientId, clinicId, transaction }) {
  const patient = plain(await db.Paciente.findByPk(patientId, { transaction, attributes: ['id_paciente', 'telefono_movil'] }));
  if (!patient) throw fail('patient_not_found', 'No se encuentra el paciente.', 404);
  return projection({ patient, clinicId, rows: await rowsFor({ db, clinicId, patient, transaction }),
    signedDocumentIds: await signedRefusalIds({ db, patient, clinicId, transaction }) });
}

async function apply({ db, patientId, clinicId, actorId, payload, transaction, authorizeCurrent }) {
  const allowedKeys = ['clinic_id', 'clinica_id', 'whatsapp_allowed', 'phone_digits', 'version'];
  if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => !allowedKeys.includes(key))
    || typeof payload.whatsapp_allowed !== 'boolean' || typeof payload.version !== 'string'
    || typeof payload.phone_digits !== 'string') throw fail('patient_communication_payload_invalid', 'Revisa la preferencia de WhatsApp.', 400);
  // The clinic anchor serializes changes even when no opt-out row exists yet.
  await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica'], transaction, lock: transaction.LOCK.UPDATE });
  const patient = plain(await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE,
    attributes: ['id_paciente', 'telefono_movil'] }));
  if (!patient) throw fail('patient_not_found', 'No se encuentra el paciente.', 404);
  if (authorizeCurrent) await authorizeCurrent();
  const rows = await rowsFor({ db, clinicId, patient, transaction, lock: true });
  const current = projection({ patient, clinicId, rows, signedDocumentIds: await signedRefusalIds({ db, patient, clinicId, transaction }) });
  if (!current.phone_digits || current.phone_digits !== payload.phone_digits || current.version !== payload.version) {
    throw fail('patient_communication_changed', 'El teléfono o la preferencia han cambiado. Vuelve a revisarlos.');
  }
  if (payload.whatsapp_allowed && !current.can_clear) throw fail('patient_communication_restriction_preserved', current.source === 'signed_privacy_document'
    ? 'La LOPD firmada rechaza estas comunicaciones. Se necesita una nueva autorización documentada.'
    : 'Hay otra restricción activa que no se puede retirar desde esta opción.');
  const owned = rows.filter(row => row.source === MANUAL_SOURCE && Number(row.paciente_id) === Number(patientId));
  let changed = false;
  if (!payload.whatsapp_allowed && !current.refused) {
    await db.MarketingContactOptOut.create({ clinica_id: clinicId, paciente_id: patientId,
      phone: '+' + current.phone_digits, phone_digits: current.phone_digits, channel: 'whatsapp', scope: CHANNEL_SCOPE,
      source: MANUAL_SOURCE, status: 'active', reason_text: 'El paciente ha pedido no ser notificado por WhatsApp.', opted_out_at: new Date() }, { transaction });
    changed = true;
  } else if (payload.whatsapp_allowed) {
    for (const row of owned.filter(row => row.status === 'active')) { await row.update({ status: 'resolved' }, { transaction }); changed = true; }
  }
  if (changed) await db.PatientOperationalEvent.create({ patient_id: patientId, clinic_id: clinicId, actor_user_id: actorId,
    event_type: 'patient.whatsapp_preference_changed', source: 'patient_record', channel: 'internal',
    metadata: { whatsapp_allowed: payload.whatsapp_allowed, phone_digits: current.phone_digits, scope: CHANNEL_SCOPE } }, { transaction });
  return { changed, patient_id: Number(patientId), whatsapp: await view({ db, patientId, clinicId, transaction }) };
}

async function platformOrigin({ db, patientId, clinicId, transaction }) {
  const { Op } = db.Sequelize;
  const appointments = await db.CitaPaciente.findAll({ where: { paciente_id: patientId, clinica_id: clinicId,
    lead_intake_id: { [Op.ne]: null } }, attributes: ['lead_intake_id', 'created_at'], order: [['created_at', 'ASC'], ['id_cita', 'ASC']], limit: 101, transaction, raw: true });
  const events = await db.PatientOperationalEvent.findAll({ where: { patient_id: patientId, clinic_id: clinicId,
    event_type: 'patient.created' }, attributes: ['metadata'], order: [['id', 'ASC']], limit: 21, transaction, raw: true });
  const ids = [...new Set([...appointments.map(row => Number(row.lead_intake_id)), ...events.map(row => Number(row.metadata?.lead_id))]
    .filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return { state: 'not_recorded', items: [] };
  const leads = await db.LeadIntake.findAll({ where: { id: { [Op.in]: ids }, clinica_id: clinicId },
    attributes: ['id', 'source', 'source_detail', 'channel', 'utm_campaign', 'created_at'], order: [['created_at', 'ASC'], ['id', 'ASC']], limit: 101, transaction, raw: true });
  return { state: leads.length > 1 || appointments.length > 100 || events.length > 20 ? 'multiple' : leads.length ? 'recorded' : 'not_recorded',
    items: leads.slice(0, 100).map(row => ({ lead_id: Number(row.id), source: row.source || null, source_detail: row.source_detail || null,
      channel: row.channel || 'unknown', campaign: row.utm_campaign || null, recorded_at: stamp(row.created_at) })) };
}

module.exports = { CHANNEL_SCOPE, MANUAL_SOURCE, projection, view, apply, platformOrigin, channelRestrictions };
