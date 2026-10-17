'use strict';
const db = require('../../models');
const { assertUserCanAccessFeature, canUserAccessFeature } = require('../lib/access-policy');
const privacy = require('../services/patientPrivacyStatus.service');
const service = require('../services/patientCommunicationPreferences.service');
const fail = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
const positive = value => typeof value !== 'object' && /^[1-9]\d*$/.test(String(value || '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
async function authorize(req, values, transaction, edit = false) {
  const actorId = positive(req.userData?.userId), clinicId = positive(values?.clinic_id ?? values?.clinica_id);
  if (!actorId) throw fail('auth_failed', 401);
  if (!clinicId || values?.clinic_id != null && values?.clinica_id != null && positive(values.clinic_id) !== positive(values.clinica_id)) throw fail('clinic_id_required', 400);
  for (const featureKey of ['patients.view', 'patients.sensitive.view', ...(edit ? ['patients.edit'] : [])]) {
    await assertUserCanAccessFeature({ actorId, featureKey, clinicId });
  }
  const patient = await privacy.patientForPrivacyClinic({ db, identifier: req.params.id, clinicId, transaction });
  return { actorId, clinicId, patientId: Number(patient.id_paciente) };
}
function reply(error, res, next) {
  const status = error.statusCode || error.status;
  if ([400, 401, 403, 404, 409].includes(status)) return res.status(status).json({ code: error.code || error.message, message: error.message });
  return next(error);
}
exports.get = async (req, res, next) => {
  try {
    if (Object.keys(req.query || {}).some(key => !['clinic_id', 'clinica_id'].includes(key))) throw fail('patient_communication_query_invalid', 400);
    const result = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const target = await authorize(req, req.query, transaction);
      const mayReadOrigin = await canUserAccessFeature({ actorId: target.actorId, featureKey: 'leads.sensitive.view', clinicId: target.clinicId });
      return { whatsapp: await service.view({ db, ...target, transaction }), platform_origin: mayReadOrigin
        ? await service.platformOrigin({ db, ...target, transaction }) : { state: 'unavailable', items: [] } };
    });
    return res.json(result);
  } catch (error) { return reply(error, res, next); }
};
exports.set = async (req, res, next) => {
  try {
    const result = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const target = await authorize(req, req.body, transaction, true);
      // Recheck after the service acquires its clinic/patient locks as well.
      return service.apply({ db, ...target, payload: req.body, transaction,
        authorizeCurrent: async () => { await authorize(req, req.body, transaction, true); } });
    });
    if (result.changed) {
      // Cache invalidation after commit only. No message/read receipt is sent.
      try {
      const io = require('../services/socket.service').getIO();
      if (io) {
        const rows = await db.Conversation.findAll({ where: { clinic_id: result.whatsapp.clinic_id, channel: 'whatsapp',
          [db.Sequelize.Op.or]: [{ patient_id: result.patient_id },
            { contact_id: { [db.Sequelize.Op.in]: require('../lib/phone').getPhoneIdentityCandidates(result.whatsapp.phone_digits) } }] },
          attributes: ['id', 'clinic_id', 'patient_id', 'contact_id'], limit: 101 });
        const relevant = rows.filter(row => require('../lib/phone').normalizePhoneDigits(row.contact_id) === result.whatsapp.phone_digits);
        const restrictions = await require('../services/marketingOptOut.service').getActiveContactRestrictionsForConversations(relevant);
        for (const row of relevant) io.to(`clinic:${row.clinic_id}`).emit('conversation:updated', { id: String(row.id),
          contact_restrictions: restrictions.get(Number(row.id)) });
      }
      } catch { console.warn('patient_whatsapp_preference_realtime_refresh_failed'); }
    }
    return res.json(result);
  } catch (error) { return reply(error, res, next); }
};
